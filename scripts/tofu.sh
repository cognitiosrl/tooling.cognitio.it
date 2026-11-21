#!/usr/bin/env bash
# Runs OpenTofu for iac/ from the environment alone: the one way the workflows
# and a person run it.
#
#   scripts/tofu.sh plan
#       init, plan; changes nothing and takes no state lock (-lock=false), so
#       a cancelled run never leaves the lock held.
#   scripts/tofu.sh apply [--confirmed] [--delete-confirmed]
#       init, plan, then apply. Refused unless both --confirmed and
#       --delete-confirmed are given: a plan that deletes, replaces or forgets
#       (drops from the state) a resource, or that changes or removes a
#       sensitive output (a key the deploy ships). Refused unless --confirmed
#       is given: any other resource change (create, update, import) and any
#       change to, or removal of, an existing output. A plan that only adds
#       outputs is applied without either flag; a plan with no change applies
#       nothing and exits 0.
#   scripts/tofu.sh output --github-output <file>
#       init, then write every output to <file> as NAME=value lines, the
#       sensitive ones masked first. Only under GitHub Actions.
#   scripts/tofu.sh migrate-state <plain state file>
#       By hand only (refused under GITHUB_ACTIONS): carries a plain state into
#       the bucket, encrypted. iac/encryption.tf refuses a plain state, so the
#       migration runs in a copy of iac/ under a temporary directory, where
#       encryption.tf is replaced by one that also reads a plain state: the file
#       is copied in (mode 600) and tofu init -migrate-state -force-copy runs
#       there. iac/ is never changed; the temporary directory, the copy with
#       it, is removed on exit. Before it, tofu state list reads the bucket's
#       state under the install's key, with iac/encryption.tf, in a second
#       copy: a state holding any resource, or one that cannot be read, is
#       refused and nothing is migrated. After it, the same read must list a
#       resource, or the run exits 1.
#
# Inputs come from the environment only:
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, TOFU_STATE_BUCKET,
#   TOFU_STATE_PASSPHRASE, CLOUDFLARE_ZONE_IDS (a JSON object, hostname to zone
#   id), ACCESS_IDP_ID, ACCESS_ALLOWED_EMAILS (comma-separated),
#   ADMIN_SERVICE_TOKEN_ID. migrate-state needs only the first four.
#
# Exit status: 2 for usage, missing inputs, a refusal by the environment or a
# bucket that already holds a state with resources; 1 for a plan refused by a
# confirmation gate, a failed init, a bucket state that cannot be listed or
# lists no resource after a migration, or a token that no tokens/verify
# endpoint accepts.
set -euo pipefail

# OpenTofu settings a shell may carry are dropped, so a run reads only the inputs above: a
# data directory (TF_DATA_DIR) shared by migrate-state's two copies would record the backend
# for both, a workspace (TF_WORKSPACE) would select another state, TF_CLI_ARGS and
# TF_CLI_ARGS_<command> would add arguments to the commands below, TF_ENCRYPTION would add
# encryption config, and a TF_VAR_<name> would override a committed default; the only TF_VAR_
# values OpenTofu sees are the ones this script exports from the inputs.
# TF_CLI_CONFIG_FILE is kept: CI never sets it, and a run by hand reads the operator's own CLI
# configuration either way (the file it names, else ~/.tofurc).
unset TF_DATA_DIR TF_WORKSPACE TF_ENCRYPTION
while IFS= read -r name; do unset "$name"; done < <(compgen -v TF_CLI_ARGS || true; compgen -v TF_VAR_ || true)

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

# Prints each line of $1 indented, on stderr.
list() {
  local address
  while IFS= read -r address; do printf '  %s\n' "$address" >&2; done <<<"$1"
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
trap 'rm -rf "$WORK"' EXIT

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

init_args=(init -input=false -lockfile=readonly
  "-backend-config=bucket=$TOFU_STATE_BUCKET"
  "-backend-config=key=$STATE_KEY")

# A copy of iac/'s configuration, its .tf files and lockfile, in a new directory.
copy_iac() {
  mkdir "$1"
  cp "$IAC"/*.tf "$IAC/.terraform.lock.hcl" "$1/"
}

# The migration's encryption config, written only into the migration's copy of iac/: the
# key provider and method of iac/encryption.tf, and a plain state read as the state's
# fallback. The two are kept the same on purpose, so the state the migration writes reads
# back under iac/encryption.tf; test/tofu.test.mjs compares them.
migration_encryption() {
  cat <<'HCL'
terraform {
  encryption {
    key_provider "pbkdf2" "passphrase" {
      passphrase = var.state_passphrase # gitleaks:allow reads the input variable, not a value
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.passphrase
    }
    method "unencrypted" "plain" {}
    state {
      method = method.aes_gcm.state
      fallback {
        method = method.unencrypted.plain
      }
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}
HCL
}

# Lists the addresses in the bucket's state under the install's key into $WORK/addresses,
# read in the copy $check with iac/encryption.tf. An absent key, which tofu state list
# reports by exiting 1 with "No state file was found" and printing nothing, lists nothing.
# Any other failure prints tofu's error and returns 1.
bucket_state() {
  local status=0
  tofu -chdir="$check" state list -no-color >"$WORK/addresses" 2>"$WORK/state-list.err" || status=$?
  [ "$status" != 0 ] || return 0
  if [ "$status" = 1 ] && [ ! -s "$WORK/addresses" ] && grep -q 'No state file was found' "$WORK/state-list.err"; then
    return 0
  fi
  cat "$WORK/state-list.err" >&2
  return 1
}

if [ "$ACTION" = migrate-state ]; then
  # init -migrate-state -force-copy replaces whatever state the key holds, so a state that
  # holds any resource is refused first. tofu state list reads it with iac/encryption.tf, in
  # a copy of iac/ of its own; a state that cannot be read is refused too.
  check="$WORK/check"
  copy_iac "$check"
  tofu -chdir="$check" "${init_args[@]}" ||
    die 1 "tofu init failed for bucket $TOFU_STATE_BUCKET, key $STATE_KEY"
  bucket_state ||
    die 1 "tofu state list failed for bucket $TOFU_STATE_BUCKET, key $STATE_KEY; nothing was migrated"
  if [ -s "$WORK/addresses" ]; then
    echo "tofu.sh: the state already in the bucket holds:" >&2
    list "$(cat "$WORK/addresses")"
    die 2 "bucket $TOFU_STATE_BUCKET, key $STATE_KEY already holds a state; migrate-state never replaces one"
  fi

  migration="$WORK/migration"
  copy_iac "$migration"
  migration_encryption >"$migration/encryption.tf"
  install -m 600 "$STATE_FILE" "$migration/terraform.tfstate"
  tofu -chdir="$migration" "${init_args[@]}" -lock-timeout=10m -migrate-state -force-copy ||
    die 1 "tofu init -migrate-state failed for bucket $TOFU_STATE_BUCKET, key $STATE_KEY"

  # init can exit 0 having copied nothing, so the migration counts only once the bucket's
  # state, read back with iac/encryption.tf, lists a resource.
  bucket_state ||
    die 1 "tofu state list failed for bucket $TOFU_STATE_BUCKET, key $STATE_KEY after the migration"
  [ -s "$WORK/addresses" ] ||
    die 1 "bucket $TOFU_STATE_BUCKET, key $STATE_KEY lists no resource after the migration; nothing was migrated"
  exit 0
fi

cd "$IAC"

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
# The plan action only reads the state, so it takes no lock; inside apply the plan takes
# the lock, as the apply after it does.
if [ "$ACTION" = plan ]; then
  lock=(-lock=false)
else
  lock=(-lock-timeout=10m)
fi
tofu plan -input=false -no-color "${lock[@]}" -out="$plan"

if [ "$ACTION" = plan ]; then
  exit 0
fi

# The plan JSON carries values (the sensitive ones too): it stays in $WORK and
# only the resource addresses, the output names and their sensitivity are read
# from it.
tofu show -json "$plan" >"$WORK/plan.json"
changes="$(jq -r '.resource_changes[]?
  | select((.change.actions != ["no-op"] and .change.actions != ["read"]) or (.change.importing != null))
  | .address' "$WORK/plan.json")"
# A forget drops a resource from the state and leaves it in the account; declaring it
# again then creates a new one (new keys, for a random_bytes), so it is gated as a delete.
deletes="$(jq -r '.resource_changes[]?
  | select(.change.actions | (index("delete") or index("forget")))
  | .address' "$WORK/plan.json")"
# The deploy ships the outputs, the keys among them as the serving Worker's secrets. Adding
# an output changes nothing deployed; changing or removing one is gated as a resource change,
# and for a sensitive output as a delete, since it replaces the keys every credential is
# verified with.
added_outputs="$(jq -r '[.output_changes // {} | to_entries[] | select(.value.actions == ["create"]) | .key]
  | join(", ")' "$WORK/plan.json")"
changed_outputs="$(jq -r '.output_changes // {} | to_entries[]
  | select(.value.actions != ["no-op"] and .value.actions != ["create"])
  | "output.\(.key)"' "$WORK/plan.json")"
key_outputs="$(jq -r '.output_changes // {} | to_entries[]
  | select(.value.actions != ["no-op"] and .value.actions != ["create"])
  | select([.value.before_sensitive, .value.after_sensitive] | any(..; . == true))
  | "output.\(.key)"' "$WORK/plan.json")"

if [ -z "$changes" ] && [ -z "$changed_outputs" ]; then
  if [ -z "$added_outputs" ]; then
    echo "tofu.sh: the plan has no changes; nothing applied"
    exit 0
  fi
  # Applying it writes the new outputs into the state and touches no resource.
  echo "tofu.sh: the plan only adds outputs: $added_outputs"
  tofu apply -input=false -no-color -lock-timeout=10m "$plan"
  exit 0
fi
if [ "$DELETE_CONFIRMED" = 0 ] && { [ -n "$deletes" ] || [ -n "$key_outputs" ]; }; then
  if [ -n "$deletes" ]; then
    echo "tofu.sh: the plan deletes, replaces or forgets:" >&2
    list "$deletes"
  fi
  if [ -n "$key_outputs" ]; then
    echo "tofu.sh: the plan changes or removes sensitive outputs, replacing the keys deployed from them:" >&2
    list "$key_outputs"
  fi
  die 1 "apply refused; to allow it, pass --confirmed --delete-confirmed"
fi
if [ "$CONFIRMED" = 0 ]; then
  if [ -n "$changes" ]; then
    echo "tofu.sh: the plan changes:" >&2
    list "$changes"
  fi
  if [ -n "$changed_outputs" ]; then
    echo "tofu.sh: the plan changes or removes outputs:" >&2
    list "$changed_outputs"
  fi
  die 1 "apply refused; to allow it, pass --confirmed"
fi

tofu apply -input=false -no-color -lock-timeout=10m "$plan"
