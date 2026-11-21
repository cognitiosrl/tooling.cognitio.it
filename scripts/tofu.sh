#!/usr/bin/env bash
# Runs OpenTofu for iac/ from the environment alone: the one way the workflows
# and a person run it.
#
#   scripts/tofu.sh plan
#       init, plan; changes nothing.
#   scripts/tofu.sh apply [--confirmed] [--delete-confirmed]
#       init, plan, then apply. A plan that deletes or replaces a resource is
#       refused unless both --confirmed and --delete-confirmed are given; any
#       other change (create, update, import) is refused unless --confirmed is
#       given; an empty plan applies nothing and exits 0.
#   scripts/tofu.sh output --github-output <file>
#       init, then write every output to <file> as NAME=value lines, the
#       sensitive ones masked first. Only under GitHub Actions.
#   scripts/tofu.sh migrate-state <plain state file>
#       By hand only (refused under GITHUB_ACTIONS): copies the file into iac/
#       (mode 600), runs tofu init -migrate-state -force-copy, removes the copy.
#
# Inputs come from the environment only:
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, TOFU_STATE_BUCKET,
#   TOFU_STATE_PASSPHRASE, CLOUDFLARE_ZONE_IDS (a JSON object, hostname to zone
#   id), ACCESS_IDP_ID, ACCESS_ALLOWED_EMAILS (comma-separated),
#   ADMIN_SERVICE_TOKEN_ID. migrate-state needs only the first four.
#
# Exit status: 2 for usage, missing inputs or a refusal by the environment;
# 1 for a plan refused by a confirmation gate, a failed init or a token that
# no tokens/verify endpoint accepts.
set -euo pipefail

# The state bucket's R2 endpoint for the default jurisdiction; the eu
# jurisdiction uses https://$CLOUDFLARE_ACCOUNT_ID.eu.r2.cloudflarestorage.com.
R2_ENDPOINT_SUFFIX="r2.cloudflarestorage.com"
STATE_KEY="cognitio-tooling/tooling.cognitio.it/terraform.tfstate"
API="https://api.cloudflare.com/client/v4"

usage() {
  cat <<'USAGE'
usage:
  tofu.sh plan
  tofu.sh apply [--confirmed] [--delete-confirmed]
  tofu.sh output --github-output <file>
  tofu.sh migrate-state <plain state file>
  tofu.sh --help
USAGE
}

die() {
  local status="$1"
  shift
  echo "tofu.sh: $*" >&2
  exit "$status"
}

# A path argument is made absolute before the script changes directory.
absolute() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$PWD" "$1" ;; esac; }

on_actions() { [ "${GITHUB_ACTIONS:-}" = true ]; }

# Under GitHub Actions the value is masked in the log from here on.
# The data is escaped as the Actions runner expects (%, CR, LF).
mask() {
  if on_actions; then
    local data="$1"
    data="${data//'%'/%25}"
    data="${data//$'\r'/%0D}"
    data="${data//$'\n'/%0A}"
    printf '::add-mask::%s\n' "$data"
  fi
}

ACTION="${1:-}"
case "$ACTION" in
  -h|--help) usage; exit 0 ;;
  plan|apply|output|migrate-state) shift ;;
  *) usage >&2; exit 2 ;;
esac

CONFIRMED=0
DELETE_CONFIRMED=0
GITHUB_OUTPUT_FILE=""
STATE_FILE=""
while [ "$#" -gt 0 ]; do
  case "$ACTION:$1" in
    apply:--confirmed) CONFIRMED=1 ;;
    apply:--delete-confirmed) DELETE_CONFIRMED=1 ;;
    output:--github-output)
      [ "$#" -ge 2 ] || die 2 "--github-output needs a file"
      GITHUB_OUTPUT_FILE="$(absolute "$2")"
      shift
      ;;
    migrate-state:-*) usage >&2; exit 2 ;;
    migrate-state:*)
      [ -z "$STATE_FILE" ] || { usage >&2; exit 2; }
      STATE_FILE="$(absolute "$1")"
      ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

IAC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../iac" && pwd)"

if [ "$DELETE_CONFIRMED" = 1 ] && [ "$CONFIRMED" = 0 ]; then
  die 2 "--delete-confirmed requires --confirmed"
fi

case "$ACTION" in
  output)
    on_actions || die 2 "output writes a GitHub Actions step output and prints no value"
    [ -n "$GITHUB_OUTPUT_FILE" ] || die 2 "output needs --github-output <file>"
    ;;
  migrate-state)
    on_actions && die 2 "migrate-state is by hand only and is refused under GITHUB_ACTIONS"
    [ -n "$STATE_FILE" ] || { usage >&2; exit 2; }
    [ -f "$STATE_FILE" ] || die 2 "the state file $STATE_FILE does not exist"
    [ ! -e "$IAC/.terraform/terraform.tfstate" ] ||
      die 2 "iac/.terraform/terraform.tfstate exists: a backend is already initialised and init -migrate-state would copy nothing; remove iac/.terraform and run again"
    [ ! -e "$IAC/terraform.tfstate" ] ||
      die 2 "iac/terraform.tfstate already exists and is never overwritten; move it away and run again"
    [ ! -e "$IAC/terraform.tfstate.backup" ] ||
      die 2 "iac/terraform.tfstate.backup already exists; move it away and run again"
    ;;
esac

required=(CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TOFU_STATE_BUCKET TOFU_STATE_PASSPHRASE)
if [ "$ACTION" != migrate-state ]; then
  required+=(CLOUDFLARE_ZONE_IDS ACCESS_IDP_ID ACCESS_ALLOWED_EMAILS ADMIN_SERVICE_TOKEN_ID)
fi
missing=()
for v in "${required[@]}"; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
[ "${#missing[@]}" -eq 0 ] || die 2 "missing from the environment: ${missing[*]}"

export TF_VAR_account_id="$CLOUDFLARE_ACCOUNT_ID"
export TF_VAR_state_passphrase="$TOFU_STATE_PASSPHRASE"
if [ "$ACTION" != migrate-state ]; then
  TF_VAR_zone_ids="$(jq -ec 'select(type == "object")' <<<"$CLOUDFLARE_ZONE_IDS" 2>/dev/null)" ||
    die 2 "CLOUDFLARE_ZONE_IDS must be a JSON object (hostname to zone id)"
  # "a@x, b@y" -> ["a@x","b@y"]
  # Read from the environment inside jq, never from its argument list.
  export ACCESS_ALLOWED_EMAILS
  TF_VAR_access_allowed_emails="$(jq -cn \
    '$ENV.ACCESS_ALLOWED_EMAILS | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(. != ""))')"
  export TF_VAR_access_idp_id="$ACCESS_IDP_ID"
  export TF_VAR_admin_service_token_id="$ADMIN_SERVICE_TOKEN_ID"
  export TF_VAR_zone_ids TF_VAR_access_allowed_emails
  if on_actions; then
    while IFS= read -r address; do mask "$address"; done < <(jq -r '.[]' <<<"$TF_VAR_access_allowed_emails")
  fi
fi
export TF_IN_AUTOMATION=1

WORK="$(mktemp -d)"
COPIED_STATE=""
cleanup() {
  rm -rf "$WORK"
  if [ -n "$COPIED_STATE" ]; then rm -f "$COPIED_STATE" "$COPIED_STATE.backup"; fi
}
trap cleanup EXIT

# The token travels to curl on stdin, never in an argument list.
verify_token_id() {
  printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" |
    curl --silent --show-error --fail --max-time 30 --header @- "$1" |
    jq -er '.result.id | select(type == "string" and . != "")' 2>/dev/null
}

token_id="$(verify_token_id "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify" || true)"
if [ -z "$token_id" ]; then
  token_id="$(verify_token_id "$API/user/tokens/verify" || true)"
fi
[ -n "$token_id" ] || die 1 "CLOUDFLARE_API_TOKEN is not verified by either tokens/verify endpoint"
# printf is a builtin: the token stays out of any process's arguments.
token_secret="$(printf '%s' "$CLOUDFLARE_API_TOKEN" | sha256sum | cut -d' ' -f1)"
mask "$token_id"
mask "$token_secret"

export AWS_ACCESS_KEY_ID="$token_id"
export AWS_SECRET_ACCESS_KEY="$token_secret"
export AWS_ENDPOINT_URL_S3="https://${CLOUDFLARE_ACCOUNT_ID}.${R2_ENDPOINT_SUFFIX}"

cd "$IAC"

init_args=(init -input=false -lockfile=readonly
  "-backend-config=bucket=$TOFU_STATE_BUCKET"
  "-backend-config=key=$STATE_KEY")

if [ "$ACTION" = migrate-state ]; then
  install -m 600 "$STATE_FILE" "$IAC/terraform.tfstate"
  COPIED_STATE="$IAC/terraform.tfstate"
  tofu "${init_args[@]}" -lock-timeout=10m -migrate-state -force-copy ||
    die 1 "tofu init -migrate-state failed for bucket $TOFU_STATE_BUCKET, key $STATE_KEY"
  exit 0
fi

tofu "${init_args[@]}" ||
  die 1 "tofu init failed for bucket $TOFU_STATE_BUCKET, key $STATE_KEY"

if [ "$ACTION" = output ]; then
  tofu output -json >"$WORK/outputs.json"
  names_text="$(jq -r 'keys[]' "$WORK/outputs.json")"
  mapfile -t names <<<"$names_text"
  lines=()
  for name in "${names[@]}"; do
    [ -n "$name" ] || continue
    if jq -e --arg n "$name" '.[$n].value | (if type == "string" then . else tojson end) | contains("\n")' \
      "$WORK/outputs.json" >/dev/null; then
      die 1 "output $name has a value with a newline, which a step output cannot carry"
    fi
    value="$(jq -j --arg n "$name" '.[$n].value | if type == "string" then . else tojson end' "$WORK/outputs.json")"
    if [ "$(jq -r --arg n "$name" '.[$n].sensitive' "$WORK/outputs.json")" = true ]; then
      mask "$value"
    fi
    upper="${name^^}"
    lines+=("$upper=$value")
  done
  for line in "${lines[@]}"; do
    printf '%s\n' "$line" >>"$GITHUB_OUTPUT_FILE"
  done
  exit 0
fi

plan="$WORK/plan.tfplan"
tofu plan -input=false -no-color -lock-timeout=10m -out="$plan"

if [ "$ACTION" = plan ]; then
  exit 0
fi

# The plan JSON carries values (the sensitive ones too): it stays in $WORK and
# only the resource addresses are read from it.
tofu show -json "$plan" >"$WORK/plan.json"
changes="$(jq -r '.resource_changes[]?
  | select((.change.actions != ["no-op"] and .change.actions != ["read"]) or (.change.importing != null))
  | .address' "$WORK/plan.json")"
deletes="$(jq -r '.resource_changes[]? | select(.change.actions | index("delete")) | .address' "$WORK/plan.json")"

list() {
  local address
  while IFS= read -r address; do printf '  %s\n' "$address" >&2; done <<<"$1"
}

if [ -z "$changes" ]; then
  echo "tofu.sh: the plan has no changes; nothing applied"
  exit 0
fi
if [ -n "$deletes" ] && [ "$DELETE_CONFIRMED" = 0 ]; then
  echo "tofu.sh: the plan deletes or replaces:" >&2
  list "$deletes"
  die 1 "apply refused; to allow it, pass --confirmed --delete-confirmed"
fi
if [ "$CONFIRMED" = 0 ]; then
  echo "tofu.sh: the plan changes:" >&2
  list "$changes"
  die 1 "apply refused; to allow it, pass --confirmed"
fi

tofu apply -input=false -no-color -lock-timeout=10m "$plan"
