import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

const STUB_TOFU = `#!/usr/bin/env bash
{
  printf 'CALL\\t%s\\n' "$*"
  for v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL_S3 TF_IN_AUTOMATION \\
           TF_VAR_account_id TF_VAR_zone_ids TF_VAR_access_idp_id TF_VAR_access_allowed_emails \\
           TF_VAR_admin_service_token_id TF_VAR_state_passphrase; do
    printf 'ENV\\t%s=%s\\n' "$v" "\${!v-<unset>}"
  done
  if [ -e terraform.tfstate ]; then printf 'STATE\\tmode=%s\\n' "$(stat -c %a terraform.tfstate)"; fi
} >>"$STUB_LOG"
case "$1" in
  init) [ -z "\${STUB_INIT_FAIL:-}" ] || { echo "init: no such bucket" >&2; exit 1; } ;;
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
printf 'ARGV\\t%s\\nHEADER\\t%s\\nURL\\t%s\\n' "$*" "$header" "$url" >>"$STUB_LOG"
case "$url" in
  */accounts/*/tokens/verify)
    [ -z "\${STUB_ACCOUNT_FAIL:-}" ] || exit 22
    printf '{"success":true,"result":{"id":"acct-token-id","status":"active"}}' ;;
  */user/tokens/verify)
    [ -z "\${STUB_USER_FAIL:-}" ] || exit 22
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

// A working copy of the script's layout with stub tofu and curl first on PATH.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tofu-test-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'iac'));
  mkdirSync(join(dir, 'bin'));
  copyFileSync(script, join(dir, 'scripts', 'tofu.sh'));
  for (const [name, body] of [['tofu', STUB_TOFU], ['curl', STUB_CURL]]) {
    writeFileSync(join(dir, 'bin', name), body);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  const log = join(dir, 'stub.log');
  writeFileSync(log, '');
  const run = (args, env = {}, { withInputs = true } = {}) => {
    const r = spawnSync('bash', [join(dir, 'scripts', 'tofu.sh'), ...args], {
      encoding: 'utf8',
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
    return { ...r, dir, lines, calls, envs, curl, out: r.stdout + r.stderr };
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
  const plan = called(r, 'plan');
  assert.match(plan[0], /-lock-timeout=10m/);
  assert.match(plan[0], /-out=/);
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

test('plan changes nothing and prints no plan JSON', () => {
  const { run } = setup();
  const r = run(['plan'], { STUB_PLAN_JSON: fixture('plan-create.json') });
  assert.equal(r.status, 0, r.out);
  assert.equal(called(r, 'apply').length, 0);
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
  assert.match(r.stderr, /^ {2}cloudflare_d1_database\.tooling$/m);
  assert.equal(called(r, 'apply').length, 0);
});

test('apply without --confirmed refuses an import', () => {
  const { run } = setup();
  const r = run(['apply'], { STUB_PLAN_JSON: fixture('plan-import.json') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^ {2}cloudflare_r2_bucket\.tooling$/m);
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
  assert.match(r.stderr, /tofu -chdir=iac output/);
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

test('migrate-state copies with mode 600 and removes the copy', () => {
  const { dir, run } = setup();
  const env = Object.fromEntries(Object.entries(inputs()).filter(([k]) => migrateInputs.includes(k)));
  const r = run(['migrate-state', plainState(dir)], {}, { withInputs: false });
  assert.equal(r.status, 2, 'only the four inputs are required, the others are not');
  const r2 = run(['migrate-state', plainState(dir)], env, { withInputs: false });
  assert.equal(r2.status, 0, r2.out);
  const init = called(r2, 'init');
  assert.equal(init.length, 1);
  assert.match(init[0], /-migrate-state/);
  assert.match(init[0], /-force-copy/);
  assert.ok(init[0].includes(`-backend-config=bucket=${BUCKET}`));
  assert.ok(init[0].includes(`-backend-config=key=${KEY}`));
  assert.ok(r2.lines.some(([k, v]) => k === 'STATE' && v === 'mode=600'));
  assert.ok(!existsSync(join(dir, 'iac', 'terraform.tfstate')));
});

test('migrate-state refuses while a backend is already initialised', () => {
  const { dir, run } = setup();
  mkdirSync(join(dir, 'iac', '.terraform'));
  writeFileSync(join(dir, 'iac', '.terraform', 'terraform.tfstate'), '{}');
  const r = run(['migrate-state', plainState(dir)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /iac\/\.terraform\/terraform\.tfstate/);
  assert.match(r.stderr, /remove iac\/\.terraform/);
  assert.equal(r.calls.length, 0);
});

test('migrate-state refuses to overwrite iac/terraform.tfstate', () => {
  const { dir, run } = setup();
  writeFileSync(join(dir, 'iac', 'terraform.tfstate'), 'keep me');
  const r = run(['migrate-state', plainState(dir)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /iac\/terraform\.tfstate/);
  assert.equal(readFileSync(join(dir, 'iac', 'terraform.tfstate'), 'utf8'), 'keep me');
  assert.equal(r.calls.length, 0);
});
