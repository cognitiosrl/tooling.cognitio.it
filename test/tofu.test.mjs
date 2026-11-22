import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '..', 'scripts', 'tofu.sh');
const fixture = (name) => resolve(here, 'fixtures', name);

const TOKEN = 'tok-made-up-0123456789abcdef';
const PASSPHRASE = 'passphrase-made-up-0123456789';
const ACCOUNT_ID = 'acc0123456789';
const BUCKET = 'test-state-bucket';
const KEY = 'cognitio-tooling/tooling.cognitio.it/terraform.tfstate';

// Each call is logged as a CALL line (the arguments after any -chdir) followed by what the
// call saw: its working directory, the files there, its environment, the plain state's mode
// and the encryption config, base64. A migration that succeeds leaves a marker beside the log;
// state list then answers STUB_MIGRATED_LIST (a resource unless it is set) instead of
// STUB_STATE_LIST or STUB_STATE_LIST_ERROR (exit status STUB_STATE_LIST_STATUS, else 1).
const STUB_TOFU = `#!/usr/bin/env bash
case "$1" in -chdir=*) cd "\${1#-chdir=}" || exit 1; shift ;; esac
{
  printf 'CALL\\t%s\\n' "$*"
  printf 'CWD\\t%s\\n' "$PWD"
  printf 'FILES\\t%s\\n' "$(ls -A | LC_ALL=C sort | tr '\\n' ' ')"
  for v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL_S3 TF_IN_AUTOMATION \\
           TF_VAR_account_id TF_VAR_zone_ids TF_VAR_access_idp_id TF_VAR_access_allowed_emails \\
           TF_VAR_admin_service_token_id TF_VAR_state_passphrase \\
           TF_DATA_DIR TF_WORKSPACE TF_CLI_ARGS TF_CLI_ARGS_init TF_CLI_ARGS_plan \\
           TF_VAR_registry_hostname TF_ENCRYPTION; do
    printf 'ENV\\t%s=%s\\n' "$v" "\${!v-<unset>}"
  done
  if [ -e terraform.tfstate ]; then printf 'STATE\\tmode=%s\\n' "$(stat -c %a terraform.tfstate)"; fi
  if [ -e encryption.tf ]; then printf 'ENC\\t%s\\n' "$(base64 -w0 encryption.tf)"; fi
} >>"$STUB_LOG"
case "$1" in
  init) [ -z "\${STUB_INIT_FAIL:-}" ] || { echo "init: no such bucket" >&2; exit 1; }
        case " $* " in *' -migrate-state '*)
          touch terraform.tfstate.backup
          [ -z "\${STUB_MIGRATE_FAIL:-}" ] || { echo "init: migration failed" >&2; exit 1; }
          touch "$STUB_LOG.migrated" ;;
        esac ;;
  state) if [ "$2" = list ] && [ -e "$STUB_LOG.migrated" ]; then
           [ -z "\${STUB_MIGRATED_LIST-x}" ] || printf '%s\\n' "\${STUB_MIGRATED_LIST-cloudflare_workers_custom_domain.registry}"
         elif [ "$2" = list ]; then
           [ -z "\${STUB_STATE_LIST_ERROR:-}" ] || { printf 'Error: %s\\n' "$STUB_STATE_LIST_ERROR" >&2; exit "\${STUB_STATE_LIST_STATUS:-1}"; }
           [ -z "\${STUB_STATE_LIST:-}" ] || printf '%s\\n' "$STUB_STATE_LIST"
         fi ;;
  plan) for a in "$@"; do case "$a" in -out=*) echo plan >"\${a#-out=}" ;; esac; done ;;
  show) cat "$STUB_PLAN_JSON" ;;
  output) cat "$STUB_OUTPUT_JSON" ;;
  apply) ;;
esac
`;

const STUB_CURL = `#!/usr/bin/env bash
header="$(cat)"
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
printf 'FIRSTARG\\t%s\\n' "$1" >>"$STUB_LOG"
printf 'ARGV\\t%s\\nHEADER\\t%s\\nURL\\t%s\\n' "$*" "$header" "$url" >>"$STUB_LOG"
case "$url" in
  */accounts/*/tokens/verify)
    [ -z "\${STUB_ACCOUNT_FAIL:-}" ] || { echo "curl: (22) The requested URL returned error: 401" >&2; exit 22; }
    printf '{"success":true,"result":{"id":"acct-token-id","status":"active"}}' ;;
  */user/tokens/verify)
    [ -z "\${STUB_USER_FAIL:-}" ] || { echo "curl: (22) The requested URL returned error: 403" >&2; exit 22; }
    printf '{"success":true,"result":{"id":"user-token-id","status":"active"}}' ;;
  *) exit 22 ;;
esac
`;

const inputs = () => ({
  CLOUDFLARE_API_TOKEN: TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_ZONE_IDS: '{"tooling.cognitio.it":"zone0001"}',
  TOFU_STATE_BUCKET: BUCKET,
  TOFU_STATE_PASSPHRASE: PASSPHRASE,
  ACCESS_IDP_ID: 'idp-made-up',
  ACCESS_ALLOWED_EMAILS: 'a@example.test',
  ADMIN_SERVICE_TOKEN_ID: 'svc-made-up',
});

const iacDir = resolve(here, '..', 'iac');
const iacFiles = [...readdirSync(iacDir).filter((f) => f.endsWith('.tf')), '.terraform.lock.hcl'];

// A working copy of the script's layout, with iac/'s configuration files, and stub tofu and
// curl first on PATH.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tofu-test-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'iac'));
  mkdirSync(join(dir, 'bin'));
  copyFileSync(script, join(dir, 'scripts', 'tofu.sh'));
  for (const f of iacFiles) copyFileSync(join(iacDir, f), join(dir, 'iac', f));
  for (const [name, body] of [['tofu', STUB_TOFU], ['curl', STUB_CURL]]) {
    writeFileSync(join(dir, 'bin', name), body);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  const log = join(dir, 'stub.log');
  writeFileSync(log, '');
  const run = (args, env = {}, { withInputs = true, cwd } = {}) => {
    rmSync(`${log}.migrated`, { force: true });
    const r = spawnSync('bash', [join(dir, 'scripts', 'tofu.sh'), ...args], {
      encoding: 'utf8',
      cwd,
      env: {
        PATH: `${join(dir, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
        HOME: dir,
        STUB_LOG: log,
        STUB_PLAN_JSON: fixture('plan-empty.json'),
        STUB_OUTPUT_JSON: fixture('outputs.json'),
        ...(withInputs ? inputs() : {}),
        ...env,
      },
    });
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
    const calls = lines.filter(([k]) => k === 'CALL').map(([, v]) => v);
    const envs = Object.fromEntries(
      lines.filter(([k]) => k === 'ENV').map(([, v]) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]),
    );
    const curl = lines.filter(([k]) => k === 'URL').map(([, v]) => v);
    // One record per tofu call, with what that call saw.
    const records = [];
    for (const [k, v] of lines) {
      if (k === 'CALL') records.push({ call: v });
      else if (records.length > 0 && ['CWD', 'FILES', 'STATE', 'ENC'].includes(k)) {
        records[records.length - 1][k.toLowerCase()] = k === 'ENC' ? Buffer.from(v, 'base64').toString('utf8') : v;
      }
    }
    return { ...r, dir, lines, calls, envs, curl, records, out: r.stdout + r.stderr };
  };
  return { dir, run };
}

const called = (r, sub) => r.calls.filter((c) => c.split(' ')[0] === sub);

test('--help exits 0 and names every subcommand', () => {
  const { run } = setup();
  const r = run(['--help'], {}, { withInputs: false });
  assert.equal(r.status, 0);
  for (const word of ['plan', 'apply', 'output', 'migrate-state', '--confirmed', '--delete-confirmed', '--github-output']) {
    assert.match(r.stdout, new RegExp(word));
  }
});

test('an unknown subcommand exits 2', () => {
  const { run } = setup();
  const r = run(['destroy']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
  assert.equal(r.calls.length, 0);
});

test('missing inputs are named and exit 2', () => {
  const { run } = setup();
  const r = run(['plan'], {}, { withInputs: false });
  assert.equal(r.status, 2);
  for (const name of Object.keys(inputs())) assert.match(r.stderr, new RegExp(name));
  assert.equal(r.calls.length, 0);
});

test('CLOUDFLARE_ZONE_IDS that is not a JSON object exits 2', () => {
  const { run } = setup();
  const r = run(['plan'], { CLOUDFLARE_ZONE_IDS: '["zone0001"]' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CLOUDFLARE_ZONE_IDS must be a JSON object/);
  assert.equal(r.calls.length, 0);
});

test('the state pair comes from the token: id from tokens/verify, secret its sha256', () => {
  const { run } = setup();
  const r = run(['plan']);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.envs.AWS_ACCESS_KEY_ID, 'acct-token-id');
  assert.equal(r.envs.AWS_SECRET_ACCESS_KEY, createHash('sha256').update(TOKEN).digest('hex'));
  assert.equal(r.envs.AWS_ENDPOINT_URL_S3, `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`);
  assert.equal(r.envs.TF_IN_AUTOMATION, '1');
  assert.equal(r.envs.TF_VAR_account_id, ACCOUNT_ID);
  assert.equal(r.envs.TF_VAR_zone_ids, '{"tooling.cognitio.it":"zone0001"}');
  assert.equal(r.envs.TF_VAR_access_idp_id, 'idp-made-up');
  assert.equal(r.envs.TF_VAR_admin_service_token_id, 'svc-made-up');
  assert.equal(r.envs.TF_VAR_state_passphrase, PASSPHRASE);
  // Outside Actions nothing of the pair is printed.
  assert.ok(!r.out.includes('acct-token-id'));
  assert.ok(!r.out.includes(r.envs.AWS_SECRET_ACCESS_KEY));
});

test('the token reaches curl on stdin and never in its argv', () => {
  const { run } = setup();
  const r = run(['plan']);
  assert.equal(r.status, 0, r.out);
  const argv = r.lines.filter(([k]) => k === 'ARGV').map(([, v]) => v);
  const headers = r.lines.filter(([k]) => k === 'HEADER').map(([, v]) => v);
  assert.ok(argv.length > 0);
  for (const a of argv) assert.ok(!a.includes(TOKEN));
  for (const h of headers) assert.equal(h, `Authorization: Bearer ${TOKEN}`);
});

test('the account endpoint is tried before the user endpoint', () => {
  const { run } = setup();
  const first = run(['plan']);
  assert.deepEqual(first.curl, [`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`]);
  const { run: run2 } = setup();
  const second = run2(['plan'], { STUB_ACCOUNT_FAIL: '1' });
  assert.equal(second.status, 0, second.out);
  assert.deepEqual(second.curl, [
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`,
    'https://api.cloudflare.com/client/v4/user/tokens/verify',
  ]);
  assert.equal(second.envs.AWS_ACCESS_KEY_ID, 'user-token-id');
});

test('an account endpoint refusal is not printed when the user endpoint verifies the token', () => {
  const { run } = setup();
  const r = run(['plan'], { STUB_ACCOUNT_FAIL: '1' });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.stderr, /curl:/);
  assert.equal(r.envs.AWS_ACCESS_KEY_ID, 'user-token-id');
});

test('when both tokens/verify endpoints fail, each failure is printed', () => {
  const { run } = setup();
  const r = run(['plan'], { STUB_ACCOUNT_FAIL: '1', STUB_USER_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /accounts\/\.\.\.\/tokens\/verify: curl: \(22\) The requested URL returned error: 401/);
  assert.match(r.stderr, /user\/tokens\/verify: curl: \(22\) The requested URL returned error: 403/);
  assert.match(r.stderr, /CLOUDFLARE_API_TOKEN is not verified by either tokens\/verify endpoint/);
  assert.ok(!r.out.includes(TOKEN));
  assert.equal(r.calls.length, 0);
  const first = r.lines.filter(([k]) => k === 'FIRSTARG').map(([, v]) => v);
  assert.deepEqual(first, ['-q', '-q']);
});

test('a token neither endpoint verifies exits 1 before any tofu call', () => {
  const { run } = setup();
  const r = run(['plan'], { STUB_ACCOUNT_FAIL: '1', STUB_USER_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CLOUDFLARE_API_TOKEN is not verified by either tokens\/verify endpoint/);
  assert.equal(r.calls.length, 0);
});

test('the token id and the derived secret are masked under GitHub Actions', () => {
  const { run } = setup();
  const r = run(['plan'], { GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 0, r.out);
  const secret = createHash('sha256').update(TOKEN).digest('hex');
  const iId = r.stdout.indexOf('::add-mask::acct-token-id');
  const iSecret = r.stdout.indexOf(`::add-mask::${secret}`);
  assert.ok(iId >= 0 && iSecret >= 0, r.out);
});

test('init gets the bucket and the install\'s key', () => {
  const { run } = setup();
  const r = run(['plan']);
  const init = called(r, 'init');
  assert.equal(init.length, 1);
  assert.match(init[0], /-input=false/);
  assert.match(init[0], /-lockfile=readonly/);
  assert.ok(init[0].includes(`-backend-config=bucket=${BUCKET}`));
  assert.ok(init[0].includes(`-backend-config=key=${KEY}`));
});

test('plan takes no state lock; the plan inside apply takes it', () => {
  const { run } = setup();
  const [planOnly] = called(run(['plan']), 'plan');
  assert.match(planOnly, / -lock=false /);
  assert.doesNotMatch(planOnly, /-lock-timeout/);
  assert.match(planOnly, /-out=/);
  const { run: run2 } = setup();
  const [inApply] = called(run2(['apply', '--confirmed'], { STUB_PLAN_JSON: fixture('plan-update.json') }), 'plan');
  assert.match(inApply, /-lock-timeout=10m/);
  assert.doesNotMatch(inApply, /-lock=false/);
  assert.match(inApply, /-out=/);
});

test('an init failure names the bucket and key and exits 1', () => {
  const { run } = setup();
  const r = run(['plan'], { STUB_INIT_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(BUCKET));
  assert.ok(r.stderr.includes(KEY));
  assert.equal(called(r, 'plan').length, 0);
});

test('ACCESS_ALLOWED_EMAILS becomes a JSON list, spaces trimmed, empties dropped', () => {
  const { run } = setup();
  const r = run(['plan'], { ACCESS_ALLOWED_EMAILS: ' a@example.test , ,b@example.test,, ' });
  assert.equal(r.envs.TF_VAR_access_allowed_emails, '["a@example.test","b@example.test"]');
});

test('plan runs no apply and reads no plan JSON', () => {
  const { run } = setup();
  const r = run(['plan'], { STUB_PLAN_JSON: fixture('plan-create.json') });
  assert.equal(r.status, 0, r.out);
  assert.equal(called(r, 'apply').length, 0);
  assert.equal(called(r, 'show').length, 0);
  assert.ok(!r.out.includes('format_version'));
});

test('apply applies nothing and exits 0 on an empty plan', () => {
  const { run } = setup();
  const r = run(['apply']);
  assert.equal(r.status, 0, r.out);
  assert.equal(called(r, 'apply').length, 0);
  assert.match(r.stdout, /no changes/i);
});

test('apply without --confirmed refuses a create, naming the address', () => {
  const { run } = setup();
  const r = run(['apply'], { STUB_PLAN_JSON: fixture('plan-create.json') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the plan changes:\n {2}cloudflare_d1_database\.tooling\n/);
  assert.match(r.stderr, /apply refused; to allow it, pass --confirmed$/m);
  assert.ok(!r.stderr.includes('deletes, replaces or forgets'));
  assert.equal(called(r, 'apply').length, 0);
});

test('apply without --confirmed refuses an import', () => {
  const { run } = setup();
  const r = run(['apply'], { STUB_PLAN_JSON: fixture('plan-import.json') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the plan changes:\n {2}cloudflare_r2_bucket\.tooling\n/);
  assert.match(r.stderr, /apply refused; to allow it, pass --confirmed$/m);
  assert.ok(!r.stderr.includes('deletes, replaces or forgets'));
  assert.equal(called(r, 'apply').length, 0);
});

test('apply --confirmed applies an update', () => {
  const { run } = setup();
  const r = run(['apply', '--confirmed'], { STUB_PLAN_JSON: fixture('plan-update.json') });
  assert.equal(r.status, 0, r.out);
  const apply = called(r, 'apply');
  assert.equal(apply.length, 1);
  assert.match(apply[0], /-lock-timeout=10m/);
});

test('apply refuses a plan whose only change is a moved address, and --confirmed applies it', () => {
  const { run } = setup();
  const r = run(['apply'], { STUB_PLAN_JSON: fixture('plan-moved.json') });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /the plan changes:\n {2}cloudflare_workers_route\.serving\["tooling\.cognitio\.it"\]\n/);
  assert.match(r.stderr, /apply refused; to allow it, pass --confirmed$/m);
  assert.equal(called(r, 'apply').length, 0);
  const { run: run2 } = setup();
  const confirmed = run2(['apply', '--confirmed'], { STUB_PLAN_JSON: fixture('plan-moved.json') });
  assert.equal(confirmed.status, 0, confirmed.out);
  assert.equal(called(confirmed, 'apply').length, 1);
});

test('apply --confirmed refuses a delete', () => {
  const { run } = setup();
  const r = run(['apply', '--confirmed'], { STUB_PLAN_JSON: fixture('plan-delete.json') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^ {2}cloudflare_dns_record\.site$/m);
  assert.match(r.stderr, /--delete-confirmed/);
  assert.equal(called(r, 'apply').length, 0);
});

test('a replace counts as a delete', () => {
  const { run } = setup();
  const r = run(['apply', '--confirmed'], { STUB_PLAN_JSON: fixture('plan-replace.json') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^ {2}cloudflare_workers_route\.serve$/m);
  assert.equal(called(r, 'apply').length, 0);
});

test('a forget counts as a delete', () => {
  const { run } = setup();
  const r = run(['apply', '--confirmed'], { STUB_PLAN_JSON: fixture('plan-forget.json') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^ {2}random_bytes\.verifier_key$/m);
  assert.match(r.stderr, /apply refused; to allow it, pass --confirmed --delete-confirmed$/m);
  assert.equal(called(r, 'apply').length, 0);
});

test('apply applies a plan that only adds outputs, without either flag', () => {
  const { run } = setup();
  const r = run(['apply'], { STUB_PLAN_JSON: fixture('plan-outputs.json') });
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /the plan only adds outputs: d1_database_id$/m);
  assert.equal(called(r, 'apply').length, 1);
});

test('a change to an existing output needs --confirmed', () => {
  const { run } = setup();
  const r = run(['apply'], { STUB_PLAN_JSON: fixture('plan-output-update.json') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the plan changes or removes outputs:\n {2}output\.d1_database_id\n/);
  assert.match(r.stderr, /apply refused; to allow it, pass --confirmed$/m);
  assert.equal(called(r, 'apply').length, 0);
  const { run: run2 } = setup();
  const confirmed = run2(['apply', '--confirmed'], { STUB_PLAN_JSON: fixture('plan-output-update.json') });
  assert.equal(confirmed.status, 0, confirmed.out);
  assert.equal(called(confirmed, 'apply').length, 1);
});

test('a change to a sensitive output needs --confirmed --delete-confirmed', () => {
  const plan = { STUB_PLAN_JSON: fixture('plan-output-key-update.json') };
  for (const flags of [[], ['--confirmed']]) {
    const { run } = setup();
    const r = run(['apply', ...flags], plan);
    assert.equal(r.status, 1, flags.join(' '));
    assert.match(r.stderr, /the plan changes or removes sensitive outputs, replacing the keys deployed from them:\n {2}output\.verifier_key\n/, flags.join(' '));
    assert.match(r.stderr, /apply refused; to allow it, pass --confirmed --delete-confirmed$/m, flags.join(' '));
    assert.equal(called(r, 'apply').length, 0, flags.join(' '));
  }
  const { run } = setup();
  const r = run(['apply', '--confirmed', '--delete-confirmed'], plan);
  assert.equal(r.status, 0, r.out);
  assert.equal(called(r, 'apply').length, 1);
});

test('apply --confirmed --delete-confirmed applies a replace', () => {
  const { run } = setup();
  const r = run(['apply', '--confirmed', '--delete-confirmed'], { STUB_PLAN_JSON: fixture('plan-replace.json') });
  assert.equal(r.status, 0, r.out);
  assert.equal(called(r, 'apply').length, 1);
});

test('--delete-confirmed without --confirmed exits 2', () => {
  const { run } = setup();
  const r = run(['apply', '--delete-confirmed']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--delete-confirmed requires --confirmed/);
  assert.equal(r.calls.length, 0);
});

test('the plan JSON is never printed', () => {
  const { run } = setup();
  const r = run(['apply'], { STUB_PLAN_JSON: fixture('plan-create.json') });
  assert.ok(!r.out.includes('format_version'));
  assert.ok(!r.out.includes('resource_changes'));
});

test('output masks sensitive outputs before writing them', () => {
  const { dir, run } = setup();
  const file = join(dir, 'gh-output');
  const r = run(['output', '--github-output', file], { GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 0, r.out);
  const written = readFileSync(file, 'utf8').split('\n').filter(Boolean).sort();
  assert.deepEqual(written, [
    'ADMIN_ACCESS_AUD=aud-made-up-0001',
    'CSRF_KEY=csrf-made-up-key',
    'D1_DATABASE_ID=d1-made-up-id',
    'VERIFIER_KEY=verifier-made-up-key',
  ]);
  const masks = r.stdout.split('\n').filter((l) => l.startsWith('::add-mask::')).map((l) => l.slice(12));
  assert.ok(masks.includes('csrf-made-up-key'));
  assert.ok(masks.includes('verifier-made-up-key'));
  assert.ok(!masks.includes('d1-made-up-id'));
  assert.ok(!r.stdout.includes('::add-mask::d1-made-up-id'));
});

test('output refuses a value with a newline', () => {
  const { dir, run } = setup();
  const file = join(dir, 'gh-output');
  const r = run(['output', '--github-output', file], { GITHUB_ACTIONS: 'true', STUB_OUTPUT_JSON: fixture('outputs-newline.json') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /verifier_key.*newline/);
  assert.ok(!existsSync(file) || readFileSync(file, 'utf8') === '');
});

test('output prints no value outside GitHub Actions', () => {
  const { dir, run } = setup();
  const r = run(['output', '--github-output', join(dir, 'gh-output')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /GitHub Actions step output/);
  for (const v of ['aud-made-up-0001', 'csrf-made-up-key', 'd1-made-up-id', 'verifier-made-up-key']) {
    assert.ok(!r.out.includes(v));
  }
  assert.equal(r.calls.length, 0);
});

test('output without --github-output exits 2', () => {
  const { run } = setup();
  const r = run(['output'], { GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--github-output/);
});

const migrateInputs = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'TOFU_STATE_BUCKET', 'TOFU_STATE_PASSPHRASE'];
const plainState = (dir) => {
  const f = join(dir, 'plain.tfstate');
  writeFileSync(f, '{"version":4,"resources":[]}\n');
  return f;
};

// HCL read as text: comments dropped, then the block a header opens, its braces matched.
const stripComments = (text) => text.replace(/#.*$/gm, '');
function block(text, header) {
  const m = new RegExp(`^\\s*${header}\\s*\\{`, 'm').exec(text);
  if (!m) return undefined;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(m.index, i + 1);
  }
  return undefined;
}
const squash = (text) => text.replace(/\s+/g, ' ').trim();

// Every file under a directory, by relative path, with the SHA-256 of its content.
function digest(root) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p.slice(root.length + 1)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}
const migrations = (r) => r.records.filter((c) => ` ${c.call} `.includes(' -migrate-state '));

test('the committed encryption config enforces the state and the plan, with no plain method', () => {
  const tf = iacFiles.filter((f) => f.endsWith('.tf')).map((f) => [f, stripComments(readFileSync(join(iacDir, f), 'utf8'))]);
  for (const [f, text] of tf) assert.doesNotMatch(text, /method\s+"unencrypted"/, f);
  const holders = tf.filter(([, text]) => /^\s*encryption\s*\{/m.test(text)).map(([f]) => f);
  // migrate-state replaces this one file in its copy of iac/.
  assert.deepEqual(holders, ['encryption.tf']);
  const encryption = block(tf.find(([f]) => f === 'encryption.tf')[1], 'encryption');
  for (const name of ['state', 'plan']) {
    const b = block(encryption, name);
    assert.ok(b, `the encryption block has a ${name} block`);
    assert.match(b, /^\s*enforced\s*=\s*true\s*$/m, name);
    assert.doesNotMatch(b, /fallback/, name);
  }
});

test('migrate-state migrates in a copy of iac/ whose encryption config also reads a plain state, leaving iac/ unchanged', () => {
  const { dir, run } = setup();
  // A backend iac/ was initialised with, and a state file in iac/, are neither refused nor read.
  mkdirSync(join(dir, 'iac', '.terraform'));
  writeFileSync(join(dir, 'iac', '.terraform', 'terraform.tfstate'), '{"backend":{}}');
  writeFileSync(join(dir, 'iac', 'terraform.tfstate'), 'keep me');
  const iac = join(dir, 'iac');
  const before = digest(iac);
  const r = run(['migrate-state', plainState(dir)]);
  assert.equal(r.status, 0, r.out);
  const [m, ...more] = migrations(r);
  assert.equal(more.length, 0);
  assert.ok(m.cwd !== iac && !m.cwd.startsWith(`${iac}/`), `the migration ran in ${m.cwd}`);
  assert.equal(m.files.trim(), [...new Set([...iacFiles, 'encryption.tf', 'terraform.tfstate'])].sort().join(' '));
  assert.equal(m.state, 'mode=600');
  const enc = stripComments(m.enc);
  assert.match(enc, /^\s*method\s+"unencrypted"\s+"\w+"\s*\{\s*\}/m);
  assert.match(block(block(enc, 'encryption'), 'state'), /^\s*fallback\s*\{\s*method\s*=\s*method\.unencrypted\.\w+\s*\}/m);
  // The key provider and the method are iac/encryption.tf's, so the state reads back under it.
  const committed = stripComments(readFileSync(join(iacDir, 'encryption.tf'), 'utf8'));
  for (const header of ['key_provider "pbkdf2" "passphrase"', 'method "aes_gcm" "state"']) {
    assert.equal(squash(block(enc, header)), squash(block(committed, header)), header);
  }
  assert.deepEqual(digest(iac), before);
  assert.ok(!existsSync(m.cwd), 'the copy is removed');
});

test('migrate-state first lists the bucket\'s state with the committed encryption config, in a copy of its own', () => {
  const { dir, run } = setup();
  const iac = join(dir, 'iac');
  const r = run(['migrate-state', plainState(dir)]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.records.length, 4, r.calls.join('\n'));
  const [check, list, migration, readBack] = r.records;
  assert.match(check.call, /^init /);
  assert.doesNotMatch(check.call, /-migrate-state/);
  assert.ok(check.call.includes(`-backend-config=bucket=${BUCKET}`) && check.call.includes(`-backend-config=key=${KEY}`));
  assert.match(list.call, /^state list\b/);
  assert.equal(list.cwd, check.cwd);
  assert.ok(check.cwd !== iac && !check.cwd.startsWith(`${iac}/`), check.cwd);
  assert.notEqual(check.cwd, migration.cwd);
  assert.equal(check.enc, readFileSync(join(iacDir, 'encryption.tf'), 'utf8'));
  assert.equal(check.state, undefined, 'the check\'s copy holds no plain state');
  assert.match(migration.call, /-migrate-state/);
  // The migration is read back in the check's copy, with iac/encryption.tf.
  assert.match(readBack.call, /^state list\b/);
  assert.equal(readBack.cwd, check.cwd);
});

test('migrate-state refuses a bucket whose state holds a resource, naming the bucket and key', () => {
  const { dir, run } = setup();
  const r = run(['migrate-state', plainState(dir)], { STUB_STATE_LIST: 'cloudflare_d1_database.tooling' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^ {2}cloudflare_d1_database\.tooling$/m);
  assert.match(r.stderr, new RegExp(`bucket ${BUCKET}, key ${KEY.replaceAll('.', '\\.')} already holds a state`));
  assert.equal(migrations(r).length, 0);
});

test('migrate-state proceeds when the bucket holds no state under the key', () => {
  const { dir, run } = setup();
  const r = run(['migrate-state', plainState(dir)], { STUB_STATE_LIST_ERROR: 'No state file was found' });
  assert.equal(r.status, 0, r.out);
  assert.equal(migrations(r).length, 1);
});

test('migrate-state reads "No state file was found" as an absent key only with exit status 1', () => {
  const { dir, run } = setup();
  const r = run(['migrate-state', plainState(dir)], { STUB_STATE_LIST_ERROR: 'No state file was found', STUB_STATE_LIST_STATUS: '2' });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`tofu state list failed for bucket ${BUCKET}, key ${KEY}`), r.stderr);
  assert.equal(migrations(r).length, 0);
});

test('migrate-state exits 1 when the bucket\'s state lists no resource after the migration', () => {
  const { dir, run } = setup();
  const r = run(['migrate-state', plainState(dir)], { STUB_MIGRATED_LIST: '' });
  assert.equal(r.status, 1);
  assert.equal(migrations(r).length, 1);
  assert.ok(r.stderr.includes(`bucket ${BUCKET}, key ${KEY} lists no resource after the migration; nothing was migrated`), r.stderr);
});

test('a stray TF_VAR_ value and TF_ENCRYPTION never reach tofu; the runner\'s own TF_VAR_ values do', () => {
  const stray = { TF_VAR_registry_hostname: 'elsewhere.example.test', TF_ENCRYPTION: 'key_provider "pbkdf2" "other" {}', TF_VAR_account_id: 'stray-account' };
  for (const args of [['plan'], ['migrate-state', 'plain.tfstate']]) {
    const { dir, run } = setup();
    plainState(dir);
    const r = run(args, stray, { cwd: dir });
    assert.equal(r.status, 0, r.out);
    const values = (name) => r.lines.filter(([k, v]) => k === 'ENV' && v.startsWith(`${name}=`)).map(([, v]) => v.slice(name.length + 1));
    for (const name of ['TF_VAR_registry_hostname', 'TF_ENCRYPTION']) {
      assert.equal(values(name).length, r.calls.length, `${args[0]}: ${name}`);
      assert.deepEqual([...new Set(values(name))], ['<unset>'], `${args[0]}: ${name}`);
    }
    assert.deepEqual([...new Set(values('TF_VAR_account_id'))], [ACCOUNT_ID], args[0]);
    assert.deepEqual([...new Set(values('TF_VAR_state_passphrase'))], [PASSPHRASE], args[0]);
    if (args[0] === 'plan') assert.deepEqual([...new Set(values('TF_VAR_access_idp_id'))], ['idp-made-up'], args[0]);
  }
});

test('OpenTofu settings in the environment never reach tofu', () => {
  const settings = { TF_DATA_DIR: '/tmp/shared-data-dir', TF_WORKSPACE: 'other', TF_CLI_ARGS: '-no-color', TF_CLI_ARGS_init: '-upgrade', TF_CLI_ARGS_plan: '-refresh=false' };
  for (const args of [['plan'], ['migrate-state', 'plain.tfstate']]) {
    const { dir, run } = setup();
    plainState(dir);
    const r = run(args, settings, { cwd: dir });
    assert.equal(r.status, 0, r.out);
    const seen = r.lines.filter(([k, v]) => k === 'ENV' && Object.keys(settings).includes(v.slice(0, v.indexOf('='))));
    assert.equal(seen.length, Object.keys(settings).length * r.calls.length, args[0]);
    for (const [, v] of seen) assert.match(v, /=<unset>$/, `${args[0]}: ${v}`);
  }
});

test('migrate-state refuses a bucket whose state cannot be listed, naming the bucket and key', () => {
  const { dir, run } = setup();
  const r = run(['migrate-state', plainState(dir)], { STUB_STATE_LIST_ERROR: 'encountered unencrypted payload without unencrypted method configured' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Error: encountered unencrypted payload/);
  assert.ok(r.stderr.includes(`tofu state list failed for bucket ${BUCKET}, key ${KEY}`), r.stderr);
  assert.equal(migrations(r).length, 0);
});

test('migrate-state stops when the check\'s init fails', () => {
  const { dir, run } = setup();
  const r = run(['migrate-state', plainState(dir)], { STUB_INIT_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`tofu init failed for bucket ${BUCKET}, key ${KEY}`), r.stderr);
  assert.equal(called(r, 'state').length, 0);
  assert.equal(migrations(r).length, 0);
});

test('migrate-state needs only its four inputs and passes the bucket and key', () => {
  const { dir, run } = setup();
  const env = Object.fromEntries(Object.entries(inputs()).filter(([k]) => migrateInputs.includes(k)));
  const r = run(['migrate-state', plainState(dir)], {}, { withInputs: false });
  assert.equal(r.status, 2, 'without the four inputs migrate-state exits 2');
  const r2 = run(['migrate-state', plainState(dir)], env, { withInputs: false });
  assert.equal(r2.status, 0, r2.out);
  const [m] = migrations(r2);
  assert.match(m.call, /-force-copy/);
  assert.match(m.call, /-lock-timeout=10m/);
  assert.ok(m.call.includes(`-backend-config=bucket=${BUCKET}`));
  assert.ok(m.call.includes(`-backend-config=key=${KEY}`));
});

test('migrate-state is refused under GITHUB_ACTIONS', () => {
  const { dir, run } = setup();
  const r = run(['migrate-state', plainState(dir)], { GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /GITHUB_ACTIONS/);
  assert.equal(r.calls.length, 0);
});

test('migrate-state refuses a file that does not exist', () => {
  const { dir, run } = setup();
  const r = run(['migrate-state', join(dir, 'nope.tfstate')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nope\.tfstate/);
});

test('migrate-state reads a relative state path from the working copy root', () => {
  const { dir, run } = setup();
  plainState(dir);
  const r = run(['migrate-state', 'plain.tfstate'], {}, { cwd: dir });
  assert.equal(r.status, 0, r.out);
  assert.equal(migrations(r).length, 1);
});

test('output writes a relative path next to the caller, not into iac/', () => {
  const { dir, run } = setup();
  const r = run(['output', '--github-output', 'gh-out'], { GITHUB_ACTIONS: 'true' }, { cwd: dir });
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(join(dir, 'gh-out')));
  assert.ok(!existsSync(join(dir, 'iac', 'gh-out')));
});

test('the temporary directory is removed on exit, a failed migration\'s plain copy with it', () => {
  const { dir, run } = setup();
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  for (const [args, env, status] of [
    [['apply'], { STUB_PLAN_JSON: fixture('plan-create.json') }, 1],
    [['apply', '--confirmed'], { STUB_PLAN_JSON: fixture('plan-update.json') }, 0],
    [['migrate-state', plainState(dir)], {}, 0],
    [['migrate-state', plainState(dir)], { STUB_MIGRATE_FAIL: '1' }, 1],
  ]) {
    const r = run(args, { TMPDIR: tmp, ...env });
    assert.equal(r.status, status, `${args[0]}: ${r.out}`);
    assert.deepEqual(readdirSync(tmp), [], args.join(' '));
  }
});

test('the allowed e-mail addresses are masked under GitHub Actions', () => {
  const { run } = setup();
  const r = run(['plan'], { GITHUB_ACTIONS: 'true', ACCESS_ALLOWED_EMAILS: 'a@example.test, b@example.test' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^::add-mask::a@example\.test$/m);
  assert.match(r.stdout, /^::add-mask::b@example\.test$/m);
});

test('a mask command escapes %, CR and LF', () => {
  const { dir, run } = setup();
  const f = join(dir, 'pct.json');
  writeFileSync(f, JSON.stringify({ csrf_key: { sensitive: true, type: 'string', value: '100%done' } }));
  const r = run(['output', '--github-output', join(dir, 'o')], { GITHUB_ACTIONS: 'true', STUB_OUTPUT_JSON: f });
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^::add-mask::100%25done$/m);
});

test('a network failure reaches stderr as curl\'s own error, not as a rejected token alone', () => {
  const { dir, run } = setup();
  writeFileSync(join(dir, 'bin', 'curl'), '#!/usr/bin/env bash\ncat >/dev/null\necho "curl: (6) Could not resolve host" >&2\nexit 6\n');
  const r = run(['plan']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /curl: \(6\) Could not resolve host/);
  assert.ok(!r.out.includes(TOKEN));
});

test('--help exits 0 when iac/ is missing', () => {
  const { dir, run } = setup();
  spawnSync('rm', ['-r', join(dir, 'iac')]);
  assert.equal(run(['--help'], {}, { withInputs: false }).status, 0);
});
