// The deploy scripts: fill-config.mjs, secrets-file.mjs and verify-deploy.mjs. No network, no
// Cloudflare account; every secret value is a literal made up here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseJsonc } from "../scripts/jsonc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = (name) => resolve(here, "..", "scripts", name);

const scratch = () => mkdtempSync(resolve(tmpdir(), "install-scripts-test-"));
const run = (name, args, env = {}) =>
  spawnSync(process.execPath, [script(name), ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

const SOURCE = `// A comment that survives.
{
  "name": "w",
  "vars": {
    "ACCESS_AUD": "REPLACE_ACCESS_AUD",
    "ACCESS_TEAM_DOMAIN": "REPLACE_ACCESS_TEAM_DOMAIN"
  },
  "d1_databases": [{ "database_id": "REPLACE_D1_DATABASE_ID" }],
  "again": "REPLACE_D1_DATABASE_ID",
}
`;
const ENV = {
  D1_DATABASE_ID: "d1-made-up-0001",
  ACCESS_AUD: 'aud"with\\quote',
  ACCESS_TEAM_DOMAIN: "https://team.example.cloudflareaccess.com",
};

function withSource(text, body) {
  const dir = scratch();
  try {
    const source = resolve(dir, "admin.wrangler.jsonc");
    writeFileSync(source, text);
    return body(dir, source);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fills every placeholder from the environment", () => {
  withSource(SOURCE, (dir, source) => {
    const out = run("fill-config.mjs", [source], ENV);
    assert.equal(out.status, 0, out.stderr);
    const filled = readFileSync(resolve(dir, "admin.filled.jsonc"), "utf8");
    assert.doesNotMatch(filled, /REPLACE_/);
    const config = parseJsonc(filled);
    assert.equal(config.vars.ACCESS_AUD, ENV.ACCESS_AUD);
    assert.equal(config.vars.ACCESS_TEAM_DOMAIN, ENV.ACCESS_TEAM_DOMAIN);
    assert.equal(config.d1_databases[0].database_id, ENV.D1_DATABASE_ID);
    assert.equal(config.again, ENV.D1_DATABASE_ID);
    for (const value of Object.values(ENV)) assert.ok(!out.stdout.includes(value) && !out.stderr.includes(value));
  });
});

test("an empty value is refused, naming the placeholder", () => {
  withSource(SOURCE, (dir, source) => {
    const out = run("fill-config.mjs", [source], { ...ENV, ACCESS_AUD: "" });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REPLACE_ACCESS_AUD/);
    assert.equal(existsSync(resolve(dir, "admin.filled.jsonc")), false);
  });
});

test("a placeholder no variable fills is refused", () => {
  withSource(SOURCE, (dir, source) => {
    const { ACCESS_TEAM_DOMAIN: _omitted, ...rest } = ENV;
    const out = run("fill-config.mjs", [source], rest);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /REPLACE_ACCESS_TEAM_DOMAIN/);
    assert.equal(existsSync(resolve(dir, "admin.filled.jsonc")), false);
  });
});

test("the filled file is written beside its source and parses", () => {
  withSource(SOURCE, (dir, source) => {
    assert.equal(run("fill-config.mjs", [source], ENV).status, 0);
    assert.ok(existsSync(resolve(dir, "admin.filled.jsonc")));
    assert.ok(existsSync(source), "the source stays");
    assert.match(readFileSync(source, "utf8"), /REPLACE_D1_DATABASE_ID/);
    assert.doesNotThrow(() => parseJsonc(readFileSync(resolve(dir, "admin.filled.jsonc"), "utf8")));
  });
});

test("secrets-file writes the named variables with mode 600", () => {
  const dir = scratch();
  try {
    const out = resolve(dir, "keys.json");
    const env = { VERIFIER_KEY: "verifier-made-up", CSRF_KEY: "csrf-made-up" };
    const result = run("secrets-file.mjs", [out, "VERIFIER_KEY", "CSRF_KEY"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), env);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    for (const value of Object.values(env)) assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secrets-file refuses a missing variable, naming it", () => {
  const dir = scratch();
  try {
    const out = resolve(dir, "keys.json");
    for (const env of [{ VERIFIER_KEY: "v" }, { VERIFIER_KEY: "v", CSRF_KEY: "" }]) {
      const result = run("secrets-file.mjs", [out, "VERIFIER_KEY", "CSRF_KEY"], env);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /CSRF_KEY/);
      assert.equal(existsSync(out), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secrets-file refuses an existing file", () => {
  const dir = scratch();
  try {
    const out = resolve(dir, "keys.json");
    writeFileSync(out, "kept");
    const result = run("secrets-file.mjs", [out, "VERIFIER_KEY"], { VERIFIER_KEY: "v" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /keys\.json/);
    assert.equal(readFileSync(out, "utf8"), "kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The shapes: Wrangler appends one JSON object per line to WRANGLER_OUTPUT_FILE_PATH (the
// "deploy" entry carries version_id), and `wrangler deployments status --json` prints the
// latest deployment, whose versions list version_id and percentage.
const UPLOADED = "11111111-aaaa-4bbb-8ccc-000000000001";
const OTHER = "22222222-aaaa-4bbb-8ccc-000000000002";
const outputLines = (versionId) =>
  [
    { type: "wrangler-session", version: 1, wrangler_version: "4.153.0", command_line_args: ["deploy"], log_file_path: "/tmp/x.log" },
    { type: "deploy", version: 1, worker_name: "w", worker_tag: "tag0001", version_id: versionId, targets: [], wrangler_environment: undefined, worker_name_overridden: false },
  ]
    .map((entry) => JSON.stringify({ ...entry, timestamp: "2026-11-21T10:00:00.000Z" }))
    .join("\n") + "\n";
const deployment = (versions) => ({
  id: "33333333-aaaa-4bbb-8ccc-000000000003",
  source: "wrangler",
  strategy: "percentage",
  author_email: "person@example.com",
  created_on: "2026-11-21T10:00:01.000Z",
  annotations: { "workers/triggered_by": "deployment" },
  versions,
});

function verify(versions, uploaded = UPLOADED) {
  const dir = scratch();
  try {
    const ndjson = resolve(dir, "out.ndjson");
    const status = resolve(dir, "status.json");
    writeFileSync(ndjson, outputLines(uploaded));
    writeFileSync(status, JSON.stringify(deployment(versions), null, 2));
    return run("verify-deploy.mjs", ["--wrangler-output", ndjson, "--deployment", status]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("verify-deploy accepts the uploaded version at 100 %", () => {
  const result = verify([{ version_id: UPLOADED, percentage: 100 }]);
  assert.equal(result.status, 0, result.stderr);
});

test("verify-deploy refuses while another version serves", () => {
  for (const versions of [
    [{ version_id: OTHER, percentage: 100 }],
    [
      { version_id: UPLOADED, percentage: 50 },
      { version_id: OTHER, percentage: 50 },
    ],
    [{ version_id: UPLOADED, percentage: 90 }],
  ]) {
    const result = verify(versions);
    assert.equal(result.status, 1, JSON.stringify(versions));
    assert.ok(result.stderr.includes(UPLOADED), result.stderr);
    if (versions.some((v) => v.version_id === OTHER)) assert.ok(result.stderr.includes(OTHER), result.stderr);
  }
});
