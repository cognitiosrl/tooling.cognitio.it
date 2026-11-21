// The Worker configurations agree with each other, with ../iac and with the code bases they
// deploy. Nothing here touches the network.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseJsonc } from "../scripts/jsonc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const parse = (path) => parseJsonc(read(path));

const serve = parse("workers/serve.wrangler.jsonc");
const admin = parse("workers/admin.wrangler.jsonc");
const registry = parse("workers/registry.wrangler.jsonc");
const filesWorker = parse("files/wrangler.jsonc");

// The text of a variable's block in iac/variables.tf, from its declaration to the next one.
function variableBlock(name) {
  const tf = read("iac/variables.tf");
  const start = tf.indexOf(`variable "${name}"`);
  assert.notEqual(start, -1, `variable ${name} is declared`);
  const next = tf.indexOf("\nvariable ", start + 1);
  return tf.slice(start, next === -1 ? undefined : next);
}
const stringDefault = (name) => variableBlock(name).match(/^\s*default\s*=\s*"([^"]*)"/m)?.[1];
const objectDefault = (name, key) => variableBlock(name).match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];

// Without routes Wrangler would serve a Worker on workers.dev, so each one turns it off.
test("every configuration parses, has no workers.dev or preview URL and no route, and its main and migrations_dir exist", () => {
  for (const [file, config] of [
    ["workers/serve.wrangler.jsonc", serve],
    ["workers/admin.wrangler.jsonc", admin],
    ["workers/registry.wrangler.jsonc", registry],
    ["files/wrangler.jsonc", filesWorker],
  ]) {
    assert.equal(config.workers_dev, false, file);
    assert.equal(config.preview_urls, false, file);
    assert.equal(config.routes, undefined, file);
    assert.equal(config.route, undefined, file);
    assert.ok(existsSync(resolve(root, dirname(file), config.main)), `${file}: ${config.main}`);
  }
  assert.equal(serve.main, "../cognitio-tooling/src/serve.js");
  assert.equal(admin.main, "../cognitio-tooling/src/admin.js");
  assert.equal(registry.main, "../serverless-registry/index.ts");
  assert.equal(admin.d1_databases[0].migrations_dir, "../cognitio-tooling/migrations");
  assert.ok(existsSync(resolve(root, "workers", admin.d1_databases[0].migrations_dir)));
});

test("Worker names equal the OpenTofu defaults", () => {
  assert.equal(objectDefault("instance_worker_names", "serve"), serve.name);
  assert.equal(objectDefault("instance_worker_names", "admin"), admin.name);
  assert.equal(stringDefault("registry_worker_name"), registry.name);
  assert.equal(stringDefault("files_worker_name"), filesWorker.name);
});

test("ADMIN_HOST equals admin_hostname", () => {
  assert.equal(stringDefault("admin_hostname"), admin.vars.ADMIN_HOST);
});

test("the placeholders are exactly the three fill-config fills", () => {
  const found = (path) => [...new Set(read(path).match(/REPLACE_[A-Z0-9_]+/g) ?? [])].sort();
  assert.deepEqual(found("workers/serve.wrangler.jsonc"), ["REPLACE_D1_DATABASE_ID"]);
  assert.deepEqual(found("workers/admin.wrangler.jsonc"), ["REPLACE_ACCESS_AUD", "REPLACE_ACCESS_TEAM_DOMAIN", "REPLACE_D1_DATABASE_ID"]);
  assert.deepEqual(found("workers/registry.wrangler.jsonc"), []);
  assert.equal(serve.d1_databases[0].database_id, "REPLACE_D1_DATABASE_ID");
  assert.equal(admin.d1_databases[0].database_id, "REPLACE_D1_DATABASE_ID");
  assert.equal(admin.vars.ACCESS_AUD, "REPLACE_ACCESS_AUD");
  assert.equal(admin.vars.ACCESS_TEAM_DOMAIN, "REPLACE_ACCESS_TEAM_DOMAIN");
});

test("the serving vars are the same in both Workers", () => {
  for (const key of ["PUBLIC_URL", "DEFAULT_NAMESPACE", "IMMUTABLE_PREFIXES", "LEGACY_LAYOUT", "CACHE_TTL_SECONDS"]) {
    assert.deepEqual(admin.vars[key], serve.vars[key], key);
  }
  assert.equal(serve.vars.LEGACY_LAYOUT, "read");
  assert.equal(admin.vars.PUBLIC_URL, serve.vars.PUBLIC_URL);
});

test("the bindings name the TANDEM bucket and one database in both Workers", () => {
  const files = read("files/wrangler.jsonc");
  assert.ok(files.includes('"bucket_name": "tandem-tooling"'));
  for (const config of [serve, admin]) {
    assert.deepEqual(config.r2_buckets, [{ binding: "FILES", bucket_name: "tandem-tooling" }]);
    assert.equal(config.d1_databases[0].binding, "DB");
    assert.equal(config.d1_databases[0].database_name, "cognitio-tooling");
  }
  assert.equal(serve.d1_databases[0].database_id, admin.d1_databases[0].database_id);
  assert.deepEqual(serve.ratelimits, [{ name: "AUTH_LIMIT", namespace_id: "1001", simple: { limit: 20, period: 60 } }]);
  assert.deepEqual(registry.r2_buckets, [{ binding: "REGISTRY", bucket_name: "tandem-tooling" }]);
  assert.equal(registry.vars.READONLY_ANONYMOUS, "false");
});

// Stand-in bindings: only the methods the configuration reads.
function bindings(vars) {
  const files = Object.fromEntries(["get", "head", "put", "list", "delete"].map((m) => [m, () => null]));
  return {
    ...vars,
    VERIFIER_KEY: Buffer.alloc(32, 7).toString("base64"),
    FILES: files,
    DB: { prepare: () => null, batch: () => null },
    AUTH_LIMIT: { limit: () => null },
  };
}

test("the vars pass the code base's own configuration checks once the placeholders are filled", async () => {
  const { serveConfig, adminConfig } = await import(pathToFileURL(resolve(root, "cognitio-tooling/src/lib/config.js")).href);
  const served = await serveConfig(bindings(serve.vars));
  assert.equal(served.faults, undefined, String(served.faults));
  const filled = { ...admin.vars, ACCESS_TEAM_DOMAIN: "https://team.example.cloudflareaccess.com", ACCESS_AUD: "aud-made-up-0123456789" };
  const administered = await adminConfig(bindings(filled));
  assert.equal(administered.faults, undefined, String(administered.faults));
});

test("the served host is one of any_publication_hosts", () => {
  const hosts = [...(variableBlock("any_publication_hosts").match(/^\s*default\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(hosts.includes(new URL(serve.vars.PUBLIC_URL).host));
});
