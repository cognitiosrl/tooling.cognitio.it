// Unit tests for the files Worker and its publish script. No network and no edge
// runtime: the R2 bucket is an in-memory stand-in that records every key it is asked
// for. Run with `npm test` (node --test) from this directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import worker, {
  basicCredential,
  publicationsFrom,
  anyPublicationHostsFrom,
  servingFrom,
  publicationFor,
  splitPath,
  servablePath,
  objectKey,
  contentTypeFor,
  cacheControlFor,
} from "./worker.js";
import { readWranglerConfig, filesBucket, stripJsonc } from "./wrangler-config.mjs";

const hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// The deployed configuration's publications, so the tests read what wrangler deploys.
const WRANGLER = readWranglerConfig(new URL("./wrangler.jsonc", import.meta.url));
const PUBLICATIONS = WRANGLER.vars.PUBLICATIONS;
const ANY_PUBLICATION_HOSTS = WRANGLER.vars.ANY_PUBLICATION_HOSTS;
const SERVING = servingFrom(WRANGLER.vars);

// A host routed one publication at a time, and the deployed host that serves any.
const ROUTED_HOST = "tooling.example";
const ANY_HOST = Object.keys(ANY_PUBLICATION_HOSTS)[0];

// Three consumers, as the README's example: two allowed both publications, and a
// customer allowed l10n alone. Passwords carry a colon and the base64 "+" and "/".
const COGNITIO = { name: "cognitio", username: "cognitio", password: "c0g:n+t/o" };
const AGGREGA = { name: "aggrega", username: "aggrega", password: "aggr:ega" };
const CUSTOMER = { name: "acme", username: "acme-ci", password: "acme-secret" };
const CONSUMERS = JSON.stringify([
  { name: COGNITIO.name, username: COGNITIO.username, passwordSha256: hex(COGNITIO.password), publications: ["tandemsdd", "l10n"] },
  { name: AGGREGA.name, username: AGGREGA.username, passwordSha256: hex(AGGREGA.password), publications: ["tandemsdd", "l10n"] },
  { name: CUSTOMER.name, username: CUSTOMER.username, passwordSha256: hex(CUSTOMER.password), publications: ["l10n"] },
]);

// A consumer allowed every publication, as the deployed consumers are.
const AGGREGA_ALL = { name: "all", username: "all-user", password: "a:l+l/" };
const WITH_ALL = JSON.stringify([
  ...JSON.parse(CONSUMERS),
  { name: AGGREGA_ALL.name, username: AGGREGA_ALL.username, passwordSha256: hex(AGGREGA_ALL.password), publications: ["*"] },
]);

// The registry's read-only pair, which stays a consumer allowed tandemsdd alone.
const RO_USER = "reader";
const RO_PASS = "s3cr+t/with:colon";

function bucket(objects) {
  const asked = [];
  return {
    asked,
    async get(key) {
      asked.push(key);
      if (!(key in objects)) return null;
      return { body: objects[key], httpEtag: `"etag-${key.length}"` };
    },
  };
}

function env(objects = {}, overrides = {}) {
  return {
    FILES: bucket(objects),
    PUBLICATIONS,
    ANY_PUBLICATION_HOSTS,
    CONSUMERS,
    READONLY_USERNAME: RO_USER,
    READONLY_PASSWORD: RO_PASS,
    ...overrides,
  };
}

function basic(user, pass) {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

const as = (c) => basic(c.username, c.password);
const READONLY = basic(RO_USER, RO_PASS);

// A request goes to the host that serves its publication in the deployment: tandemsdd's
// routed host, and the host serving any publication for every other one, unless `host`
// names another.
function req(path, { method = "GET", auth = as(COGNITIO), host } = {}) {
  const headers = auth === null ? {} : { Authorization: auth };
  const to = host ?? (path.startsWith("/tandemsdd/") ? ROUTED_HOST : ANY_HOST);
  return new Request(`https://${to}/${path.replace(/^\//, "")}`, { method, headers });
}

const STORE = {
  "_marketplace/marketplace.json": '{"name":"m","plugins":[]}',
  "_marketplace/archives/tandem-1.2.0.zip": "PK-zip-bytes",
  "_files/l10n/archives/cognitio-l10n-0.3.0.tgz": "tgz-bytes",
  "_files/l10n/latest.json": '{"version":"0.3.0"}',
};

// --- the configuration ---------------------------------------------------------

test("the deployed configuration parses, tandemsdd on its own key prefix and every module at _files/<module>/", () => {
  assert.equal(SERVING.error, undefined, SERVING.error);
  assert.equal(SERVING.publications.get("tandemsdd").keyPrefix, "_marketplace/");
  assert.equal(publicationFor(SERVING, ANY_HOST, "l10n").keyPrefix, "_files/l10n/");
  assert.equal(publicationFor(SERVING, ANY_HOST, "not-yet-released").keyPrefix, "_files/not-yet-released/");
});

// The `publications` default in ../iac/variables.tf, as [host, [publication, ...]]
// pairs in the order written.
function routedPublications() {
  const tf = readFileSync(new URL("../iac/variables.tf", import.meta.url), "utf8");
  const block = /variable "publications" \{[\s\S]*?default\s*=\s*\{([\s\S]*?)\n\s*\}/.exec(tf);
  assert.ok(block, "variables.tf declares a publications default");
  const hosts = [...block[1].matchAll(/"([^"]+)"\s*=\s*\[([^\]]*)\]/g)].map((m) => [
    m[1],
    [...m[2].matchAll(/"([^"]+)"/g)].map((p) => p[1]),
  ]);
  assert.ok(hosts.length > 0, "the publications default names a host");
  return hosts;
}

test("the publications in wrangler.jsonc and the routes in ../iac/, on every host, are the same list", () => {
  const hosts = routedPublications();
  const routed = [...new Set(hosts.flatMap(([, pubs]) => pubs))].sort();
  assert.deepEqual(routed, Object.keys(PUBLICATIONS).sort());
  for (const [host, pubs] of hosts) {
    assert.ok(pubs.length > 0, `${host} routes at least one publication`);
    assert.equal(new Set(pubs).size, pubs.length, `${host} lists no publication twice`);
  }
});

// The `any_publication_hosts` default in ../iac/variables.tf, in the order written.
function anyPublicationHosts() {
  const tf = readFileSync(new URL("../iac/variables.tf", import.meta.url), "utf8");
  const block = /variable "any_publication_hosts" \{[\s\S]*?default\s*=\s*\[([^\]]*)\]/.exec(tf);
  assert.ok(block, "variables.tf declares an any_publication_hosts default");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("the hosts serving any publication are the same in wrangler.jsonc and ../iac/, and route nothing one by one", () => {
  const hosts = anyPublicationHosts();
  assert.deepEqual([...hosts].sort(), Object.keys(ANY_PUBLICATION_HOSTS).sort());
  const routed = new Set(routedPublications().map(([host]) => host));
  for (const host of hosts) assert.ok(!routed.has(host), `${host} is not also routed one publication at a time`);
});

test("modules: install.sh is revalidated and archives/ immutable, like every other publication's archives", () => {
  const modules = publicationFor(SERVING, ANY_HOST, "modules");
  assert.equal(objectKey(modules, "install.sh"), "_files/modules/install.sh");
  assert.equal(cacheControlFor(modules, "install.sh"), "private, no-cache");
  assert.equal(cacheControlFor(modules, "archives/modules-1.0.0.tgz"), "private, max-age=31536000, immutable");
  assert.equal(contentTypeFor("install.sh"), "text/plain; charset=utf-8");
  const every = [...SERVING.publications, ...[...SERVING.hosts.keys()].map((h) => [h, publicationFor(SERVING, h, "any")])];
  for (const [name, p] of every) {
    assert.ok(p.immutable.includes("archives/"), `${name}: archives/ is immutable`);
    assert.equal(cacheControlFor(p, "index.json"), "private, no-cache", `${name}: index.json is revalidated`);
  }
});

test("publicationFor: any publication name on a host serving any, only the named ones elsewhere", () => {
  assert.equal(publicationFor(SERVING, ROUTED_HOST, "l10n"), null);
  assert.equal(publicationFor(SERVING, ROUTED_HOST, "tandemsdd").keyPrefix, "_marketplace/");
  assert.equal(publicationFor(SERVING, ANY_HOST, "tandemsdd").keyPrefix, "_files/tandemsdd/", "the marketplace is not served on a host serving any");
  for (const name of ["v2", "Bad", "-x", "", "_files"]) assert.equal(publicationFor(SERVING, ANY_HOST, name), null, name);
});

test("anyPublicationHostsFrom: absent or empty names no host; what is not a configuration", () => {
  assert.equal(anyPublicationHostsFrom(undefined).hosts.size, 0);
  assert.equal(anyPublicationHostsFrom("").hosts.size, 0);
  assert.equal(anyPublicationHostsFrom(JSON.stringify(ANY_PUBLICATION_HOSTS)).hosts.size, Object.keys(ANY_PUBLICATION_HOSTS).length);
  for (const [scenario, value] of [
    ["not JSON", "{"],
    ["a list", "[]"],
    ["not a host name", { localhost: {} }],
    ["upper case", { "Tooling.example": {} }],
    ["an entry that is not an object", { "a.example": "x" }],
    ["immutable that is not a list", { "a.example": { immutable: "archives/" } }],
  ]) {
    assert.ok(anyPublicationHostsFrom(value).error, scenario);
  }
});

test("servingFrom: a named publication holding every _files/ prefix is refused while a host serves any", () => {
  const p = { a: { keyPrefix: "_files/" } };
  assert.ok(servingFrom({ PUBLICATIONS: p, ANY_PUBLICATION_HOSTS }).error);
  assert.equal(servingFrom({ PUBLICATIONS: p }).error, undefined, "with no host serving any");
  assert.ok(servingFrom({ PUBLICATIONS, ANY_PUBLICATION_HOSTS: "{" }).error);
});

test("publicationsFrom: a JSON string is read like an object", () => {
  assert.equal(publicationsFrom(JSON.stringify(PUBLICATIONS)).error, undefined);
});

test("publicationsFrom: what is not a configuration", () => {
  for (const [scenario, value] of [
    ["absent", undefined],
    ["not JSON", "{"],
    ["a list", "[]"],
    ["empty", {}],
    ["a bad name", { "Bad Name": {} }],
    ["the registry's path", { v2: {} }],
    ["an entry that is not an object", { a: "x" }],
    ["a key prefix without the leading underscore", { a: { keyPrefix: "files/a/" } }],
    ["a key prefix without the trailing slash", { a: { keyPrefix: "_files/a" } }],
    ["a doubled slash", { a: { keyPrefix: "_files//a/" } }],
    ["immutable that is not a list", { a: { immutable: "archives/" } }],
    ["one prefix inside another", { a: { keyPrefix: "_files/" }, b: {} }],
  ]) {
    assert.ok(publicationsFrom(value).error, scenario);
  }
});

// --- what a path names -----------------------------------------------------------

test("splitPath: the publication and the path inside it", () => {
  assert.deepEqual(splitPath("/tandemsdd/marketplace.json"), { publication: "tandemsdd", path: "marketplace.json" });
  assert.deepEqual(splitPath("/l10n/archives/x-1.0.0.tgz"), { publication: "l10n", path: "archives/x-1.0.0.tgz" });
});

test("servablePath: traversal, encoded bytes, hidden and empty segments are refused", () => {
  for (const p of [
    "",
    "..",
    "../l10n/latest.json",
    "a/../b",
    "./a",
    ".hidden",
    "archives/.hidden.zip",
    "a//b",
    "a/",
    "%2e%2e/x",
    "archives/%2e%2e%2fx.zip",
    "a\\b",
    "a b",
    "x".repeat(1025),
  ]) {
    assert.equal(servablePath(p), false, p);
  }
  for (const p of ["marketplace.json", "archives/tandem-1.2.0.zip", "a/b/c_d~e-f.txt", "x".repeat(1024)]) {
    assert.equal(servablePath(p), true, p);
  }
});

test("objectKey and contentTypeFor", () => {
  assert.equal(objectKey(SERVING.publications.get("tandemsdd"), "marketplace.json"), "_marketplace/marketplace.json");
  assert.equal(objectKey(publicationFor(SERVING, ANY_HOST, "l10n"), "latest.json"), "_files/l10n/latest.json");
  assert.equal(contentTypeFor("a.json"), "application/json");
  assert.equal(contentTypeFor("a.ZIP"), "application/zip");
  assert.equal(contentTypeFor("a.tgz"), "application/gzip");
  assert.equal(contentTypeFor("noext"), "application/octet-stream");
});

// --- the credential --------------------------------------------------------------

test("basicCredential: splits at the first colon, standard base64 alphabet", () => {
  assert.deepEqual(basicCredential(READONLY), [RO_USER, RO_PASS]);
  assert.deepEqual(basicCredential(`basic ${btoa("u:p")}`), ["u", "p"]);
});

test("basicCredential: refuses what is not a Basic credential", () => {
  for (const h of [null, "", "Bearer abc", "Basic", "Basic !!!", `Basic ${btoa("nocolon")}`, "Basic /w==="]) {
    assert.equal(basicCredential(h), null, String(h));
  }
});

// --- the handler: who is served what ---------------------------------------------

test("tandemsdd's URLs serve its _marketplace/ keys, with the same headers", async () => {
  const e = env(STORE);
  const res = await worker.fetch(req("/tandemsdd/marketplace.json"), e);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("cache-control"), "private, no-cache");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(res.headers.get("etag"));
  assert.equal(await res.text(), STORE["_marketplace/marketplace.json"]);
  assert.deepEqual(e.FILES.asked, ["_marketplace/marketplace.json"]);

  const zip = await worker.fetch(req("/tandemsdd/archives/tandem-1.2.0.zip"), env(STORE));
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get("content-type"), "application/zip");
  assert.equal(zip.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(await zip.text(), "PK-zip-bytes");
});

test("a module serves its _files/<module>/ keys on the host serving any, with no configuration naming it", async () => {
  const e = env(STORE);
  const res = await worker.fetch(req("/l10n/archives/cognitio-l10n-0.3.0.tgz"), e);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/gzip");
  assert.equal(res.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(await res.text(), "tgz-bytes");
  assert.deepEqual(e.FILES.asked, ["_files/l10n/archives/cognitio-l10n-0.3.0.tgz"]);

  const latest = await worker.fetch(req("/l10n/latest.json"), env(STORE));
  assert.equal(latest.status, 200);
  assert.equal(latest.headers.get("cache-control"), "private, no-cache");

  const store = { ...STORE, "_files/brand-new/archives/brand-new-1.0.0.tgz": "new-bytes" };
  const fresh = await worker.fetch(req("/brand-new/archives/brand-new-1.0.0.tgz", { auth: as(AGGREGA_ALL) }), env(store, { CONSUMERS: WITH_ALL }));
  assert.equal(fresh.status, 200, "a module first uploaded after the deploy");
  assert.equal(fresh.headers.get("cache-control"), "private, max-age=31536000, immutable");
});

test("the hosts stay apart: no module on the routed host, no marketplace on the host serving any", async () => {
  let e = env(STORE);
  let res = await worker.fetch(req("/l10n/latest.json", { host: ROUTED_HOST }), e);
  assert.equal(res.status, 404);
  assert.deepEqual(e.FILES.asked, [], "a module name is not looked up on the routed host");

  e = env(STORE);
  res = await worker.fetch(req("/tandemsdd/marketplace.json", { host: ANY_HOST }), e);
  assert.equal(res.status, 404);
  assert.deepEqual(e.FILES.asked, ["_files/tandemsdd/marketplace.json"], "tandemsdd there is a module name like any other");
});

test("per consumer: each is served exactly the publications it is allowed", async () => {
  const cells = [
    // consumer, publication path, expected status
    [COGNITIO, "/tandemsdd/marketplace.json", 200],
    [COGNITIO, "/l10n/latest.json", 200],
    [AGGREGA, "/tandemsdd/marketplace.json", 200],
    [AGGREGA, "/l10n/latest.json", 200],
    [CUSTOMER, "/l10n/latest.json", 200],
    [CUSTOMER, "/tandemsdd/marketplace.json", 403],
    [CUSTOMER, "/tandemsdd/archives/tandem-1.2.0.zip", 403],
  ];
  for (const [consumer, path, status] of cells) {
    const e = env(STORE);
    const res = await worker.fetch(req(path, { auth: as(consumer) }), e);
    assert.equal(res.status, status, `${consumer.name} ${path}`);
    if (status === 403) assert.deepEqual(e.FILES.asked, [], `${consumer.name} ${path}: nothing is read`);
  }
});

test('a consumer allowed "*" is served every publication, one added after its entry included', async () => {
  const consumers = WITH_ALL;
  const publications = { ...PUBLICATIONS, later: {} };
  const store = { ...STORE, "_files/later/archives/later-1.0.0.tgz": "later-bytes" };
  for (const [path, host] of [
    ["/tandemsdd/marketplace.json", ROUTED_HOST],
    ["/l10n/latest.json", ANY_HOST],
    ["/later/archives/later-1.0.0.tgz", ROUTED_HOST],
  ]) {
    const res = await worker.fetch(req(path, { auth: as(AGGREGA_ALL), host }), env(store, { CONSUMERS: consumers, PUBLICATIONS: publications }));
    assert.equal(res.status, 200, path);
  }
  const e = env(store, { CONSUMERS: consumers, PUBLICATIONS: publications });
  const other = await worker.fetch(req("/later/archives/later-1.0.0.tgz", { auth: as(CUSTOMER), host: ROUTED_HOST }), e);
  assert.equal(other.status, 403, "a consumer that lists publications is still held to them");
  assert.deepEqual(e.FILES.asked, []);
});

test('a consumer allowed "*" is served every publication routed on every host', async () => {
  const consumers = JSON.stringify([{ name: "all", username: "all-user", passwordSha256: hex("pw"), publications: ["*"] }]);
  const cells = [
    ...routedPublications().flatMap(([, pubs]) => pubs.map((name) => [name, ROUTED_HOST])),
    ...anyPublicationHosts().map((host) => ["some-module", host]),
  ];
  for (const [name, host] of cells) {
    const store = { [objectKey(publicationFor(SERVING, host, name), "index.json")]: "{}" };
    const e = env(store, { CONSUMERS: consumers });
    const res = await worker.fetch(req(`/${name}/index.json`, { auth: basic("all-user", "pw"), host }), e);
    assert.equal(res.status, 200, `${host}/${name}`);
  }
});

test('"*" allows no publication the routed host does not configure', async () => {
  const consumers = JSON.stringify([{ name: "all", username: "all-user", passwordSha256: hex("pw"), publications: ["*"] }]);
  const e = env(STORE, { CONSUMERS: consumers });
  const res = await worker.fetch(req("/nowhere/x.json", { auth: basic("all-user", "pw"), host: ROUTED_HOST }), e);
  assert.equal(res.status, 404);
  assert.deepEqual(e.FILES.asked, []);
});

test("the registry's read-only pair is a consumer allowed tandemsdd alone", async () => {
  const ok = await worker.fetch(req("/tandemsdd/marketplace.json", { auth: READONLY }), env(STORE));
  assert.equal(ok.status, 200);
  const e = env(STORE);
  const no = await worker.fetch(req("/l10n/latest.json", { auth: READONLY }), e);
  assert.equal(no.status, 403);
  assert.deepEqual(e.FILES.asked, []);
});

test("the read-only pair alone, with no CONSUMERS, still serves tandemsdd", async () => {
  const res = await worker.fetch(req("/tandemsdd/marketplace.json", { auth: READONLY }), env(STORE, { CONSUMERS: undefined }));
  assert.equal(res.status, 200);
});

test("CONSUMERS alone, with no read-only pair, serves its consumers and refuses the pair", async () => {
  const e = { READONLY_USERNAME: undefined, READONLY_PASSWORD: undefined };
  assert.equal((await worker.fetch(req("/l10n/latest.json", { auth: as(CUSTOMER) }), env(STORE, e))).status, 200);
  assert.equal((await worker.fetch(req("/tandemsdd/marketplace.json", { auth: READONLY }), env(STORE, e))).status, 401);
});

test("a revoked consumer is refused with 401", async () => {
  const without = JSON.stringify(JSON.parse(CONSUMERS).filter((c) => c.name !== CUSTOMER.name));
  const res = await worker.fetch(req("/l10n/latest.json", { auth: as(CUSTOMER) }), env(STORE, { CONSUMERS: without }));
  assert.equal(res.status, 401);
});

// --- the handler: the refusal order -----------------------------------------------

test("401 before any lookup: no credential, wrong halves, another consumer's mix, another scheme", async () => {
  for (const auth of [
    null,
    basic(COGNITIO.username, "wrong"),
    basic("nobody", COGNITIO.password),
    basic(COGNITIO.username, AGGREGA.password),
    basic(RO_USER, "wrong"),
    basic(RO_USER, `${RO_PASS}x`),
    "Bearer token",
  ]) {
    const e = env(STORE);
    const res = await worker.fetch(req("/tandemsdd/marketplace.json", { auth }), e);
    assert.equal(res.status, 401, String(auth));
    assert.match(res.headers.get("www-authenticate"), /^Basic realm="/);
    assert.deepEqual(e.FILES.asked, [], "nothing is read for an unauthenticated request");
  }
});

test("401 comes before 403, 405 and 404", async () => {
  for (const [path, method] of [
    ["/tandemsdd/marketplace.json", "POST"],
    ["/nowhere/x.json", "GET"],
    ["/l10n/../x", "GET"],
  ]) {
    const res = await worker.fetch(req(path, { method, auth: null }), env(STORE));
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("403 comes before 405 and 404, and reads nothing", async () => {
  for (const [path, method] of [
    ["/tandemsdd/marketplace.json", "PUT"],
    ["/tandemsdd/missing.json", "GET"],
    ["/tandemsdd/%2e%2e/x", "GET"],
    ["/nowhere/x.json", "GET"],
  ]) {
    const e = env(STORE);
    const res = await worker.fetch(req(path, { method, auth: as(CUSTOMER) }), e);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual(e.FILES.asked, []);
  }
});

test("405 for every method but GET, HEAD included, before 404", async () => {
  for (const method of ["HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    for (const path of ["/tandemsdd/marketplace.json", "/tandemsdd/missing.json"]) {
      const e = env(STORE);
      const res = await worker.fetch(req(path, { method }), e);
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get("allow"), "GET");
      assert.deepEqual(e.FILES.asked, []);
    }
  }
});

test("404 without a lookup: traversal, encoded bytes, hidden or empty segments", async () => {
  for (const path of [
    "/l10n/..%2f_marketplace/marketplace.json",
    "/l10n/%2e%2e%2f_marketplace/marketplace.json",
    "/l10n/a%2fb",
    "/l10n/.hidden",
    "/l10n/a//b",
    "/l10n/",
    "/tandemsdd/archives/",
  ]) {
    const e = env(STORE);
    const res = await worker.fetch(req(path), e);
    assert.equal(res.status, 404, path);
    assert.deepEqual(e.FILES.asked, [], path);
  }
});

test("a dot-dot segment the URL parser resolves is judged where it lands", async () => {
  // "..", and "%2e%2e" with it, is resolved by the URL parser before the Worker sees
  // the path, so /l10n/../tandemsdd/x is a tandemsdd request: the customer, allowed
  // l10n alone, gets 403, and nothing is read.
  for (const path of ["/l10n/../tandemsdd/marketplace.json", "/l10n/%2e%2e/tandemsdd/marketplace.json"]) {
    const e = env(STORE);
    const res = await worker.fetch(req(path, { auth: as(CUSTOMER) }), e);
    assert.equal(res.status, 403, path);
    assert.deepEqual(e.FILES.asked, [], path);
  }
});

test("404 for an allowed publication the routed host does not configure, without a lookup", async () => {
  const consumers = JSON.stringify([{ name: "x", username: "x", passwordSha256: hex("y"), publications: ["gone"] }]);
  const e = env(STORE, { CONSUMERS: consumers });
  const res = await worker.fetch(req("/gone/latest.json", { auth: basic("x", "y"), host: ROUTED_HOST }), e);
  assert.equal(res.status, 404);
  assert.deepEqual(e.FILES.asked, []);
});

test("404 for a file never uploaded, after one lookup inside the prefix", async () => {
  const e = env(STORE);
  const res = await worker.fetch(req("/tandemsdd/archives/tandem-9.9.9.zip"), e);
  assert.equal(res.status, 404);
  assert.deepEqual(e.FILES.asked, ["_marketplace/archives/tandem-9.9.9.zip"]);
});

test("500 and no lookup when the configuration is missing or invalid", async () => {
  const dup = JSON.parse(CONSUMERS);
  dup.push({ ...dup[0], name: "twin" });
  for (const [scenario, overrides] of [
    ["no bucket", { FILES: undefined }],
    ["no PUBLICATIONS", { PUBLICATIONS: undefined }],
    ["invalid PUBLICATIONS", { PUBLICATIONS: "{" }],
    ["invalid ANY_PUBLICATION_HOSTS", { ANY_PUBLICATION_HOSTS: { localhost: {} } }],
    ["no consumer at all", { CONSUMERS: undefined, READONLY_USERNAME: undefined, READONLY_PASSWORD: undefined }],
    ["half the read-only pair", { READONLY_PASSWORD: undefined }],
    ["CONSUMERS not JSON", { CONSUMERS: "[" }],
    ["CONSUMERS not a list", { CONSUMERS: "{}" }],
    ["a consumer without a hash", { CONSUMERS: JSON.stringify([{ name: "a", username: "a", publications: [] }]) }],
    ["a short hash", { CONSUMERS: JSON.stringify([{ name: "a", username: "a", passwordSha256: "abc", publications: [] }]) }],
    ["a username with a colon", { CONSUMERS: JSON.stringify([{ name: "a", username: "a:b", passwordSha256: hex("p"), publications: [] }]) }],
    ["two consumers, one username", { CONSUMERS: JSON.stringify(dup) }],
    ["a consumer reusing the read-only username", {
      CONSUMERS: JSON.stringify([{ name: "a", username: RO_USER, passwordSha256: hex("p"), publications: [] }]),
    }],
  ]) {
    const e = env(STORE);
    const files = e.FILES;
    Object.assign(e, overrides);
    const res = await worker.fetch(req("/tandemsdd/marketplace.json"), e);
    assert.equal(res.status, 500, scenario);
    assert.deepEqual(files.asked, [], scenario);
  }
});

// --- the configuration reader and the publish script -----------------------------

test("stripJsonc keeps // inside strings and removes comments outside them", () => {
  assert.deepEqual(JSON.parse(stripJsonc('{"u": "https://x//y", /* c */ "n": 1 // c\n}')), { u: "https://x//y", n: 1 });
});

test("the FILES binding names the registry's bucket", () => {
  assert.equal(filesBucket(WRANGLER), "tandem-tooling");
});

function publish(...args) {
  const script = fileURLToPath(new URL("./publish.mjs", import.meta.url));
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: "" } });
}

test("publish.mjs --dry-run prints the upload to the key the Worker reads", () => {
  const file = fileURLToPath(new URL("./package.json", import.meta.url));
  const l10n = publish("l10n", "archives/cognitio-l10n-0.3.0.tgz", file, "--dry-run");
  assert.equal(l10n.status, 0, l10n.stderr);
  assert.equal(
    l10n.stdout.trim(),
    `wrangler r2 object put tandem-tooling/_files/l10n/archives/cognitio-l10n-0.3.0.tgz --file ${file} --content-type application/gzip --remote`,
  );
  const legacy = publish("tandemsdd", "marketplace.json", file, "--dry-run");
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /tandem-tooling\/_marketplace\/marketplace\.json /);
  const fresh = publish("brand-new", "index.json", file, "--dry-run");
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /tandem-tooling\/_files\/brand-new\/index\.json /, "a module no configuration names");
});

test("publish.mjs refuses what is not a publication name, an unservable path, a missing file", () => {
  const file = fileURLToPath(new URL("./package.json", import.meta.url));
  for (const args of [
    ["Nowhere", "a.json", file, "--dry-run"],
    ["v2", "a.json", file, "--dry-run"],
    ["l10n", "../tandemsdd/marketplace.json", file, "--dry-run"],
    ["l10n", "a.json", "/nonexistent/file", "--dry-run"],
    ["l10n", "a.json"],
  ]) {
    const run = publish(...args);
    assert.equal(run.status, 2, args.join(" "));
  }
});

test("publish.mjs without --dry-run refuses to run without the Cloudflare credential", () => {
  const file = fileURLToPath(new URL("./package.json", import.meta.url));
  const run = publish("l10n", "a.json", file);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /CLOUDFLARE_API_TOKEN is not set/);
});
