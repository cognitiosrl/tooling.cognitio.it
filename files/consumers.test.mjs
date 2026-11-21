// Tests for consumers.mjs: the file format, the validation it shares with the Worker,
// and the commands, run on a temporary file. They touch no network and never push.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import worker from "./worker.js";
import { readWranglerConfig } from "./wrangler-config.mjs";
import { parseFile, formatFile, splitPublications, consumersJson, hashPassword, validate, UsageError } from "./consumers.mjs";

const SCRIPT = fileURLToPath(new URL("./consumers.mjs", import.meta.url));
const KNOWN = new Set(["tandemsdd", "l10n"]);
const H = hashPassword("pw");

function run(file, args, input = "") {
  const r = spawnSync(process.execPath, [SCRIPT, "--file", file, ...args], { input, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("parseFile and formatFile round-trip, comments and blank lines kept in place", () => {
  const text = `# operator's consumers\naggrega:${H}:tandemsdd,l10n\n\nacme:${H}:*\n`;
  assert.equal(formatFile(parseFile(text)), text);
});

test("parseFile refuses a malformed line, naming it", () => {
  for (const [line, says] of [
    ["only:two", "not <username>"],
    [`bad user:${H}:l10n`, "is not a username"],
    ["u:ABC:l10n", "64 lowercase hex"],
    [`u:${H}:`, "empty publication"],
  ]) {
    assert.throws(() => parseFile(`# c\n${line}\n`), (e) => e instanceof UsageError && e.message.startsWith("line 2") && e.message.includes(says), line);
  }
});

test('splitPublications: a list, or "*" alone', () => {
  assert.deepEqual(splitPublications("tandemsdd,l10n"), ["tandemsdd", "l10n"]);
  assert.deepEqual(splitPublications("*"), ["*"]);
  assert.throws(() => splitPublications("*,l10n"), UsageError);
  assert.throws(() => splitPublications("l10n,l10n"), UsageError);
});

test("validate: a publication wrangler.jsonc does not configure, and an empty file, are refused", async () => {
  await assert.rejects(validate(parseFile(`a:${H}:l1On\n`), KNOWN), /not a publication wrangler.jsonc configures/);
  await assert.rejects(validate(parseFile("# nobody\n"), KNOWN), /no consumer/);
  await validate(parseFile(`a:${H}:*\nb:${H}:l10n\n`), KNOWN);
});

test("validate: with a host serving any publication, any publication name is configured, and only those", async () => {
  await validate(parseFile(`a:${H}:tandemsdd,not-yet-released\n`), KNOWN, { anyName: true });
  await assert.rejects(validate(parseFile(`a:${H}:l1On\n`), new Set(["tandemsdd"]), { anyName: true }), /not a publication/);
  await assert.rejects(validate(parseFile(`a:${H}:v2\n`), new Set(["tandemsdd"]), { anyName: true }), /not a publication/);
});

test("the JSON the file stands for is served by the Worker as written", async () => {
  const json = consumersJson(parseFile(`all:${hashPassword("p1")}:*\nl10n-only:${hashPassword("p2")}:l10n\n`));
  const vars = readWranglerConfig(new URL("./wrangler.jsonc", import.meta.url)).vars;
  const env = {
    FILES: { get: async (key) => ({ body: key, httpEtag: '"e"' }) },
    PUBLICATIONS: vars.PUBLICATIONS,
    ANY_PUBLICATION_HOSTS: vars.ANY_PUBLICATION_HOSTS,
    CONSUMERS: json,
  };
  const anyHost = Object.keys(vars.ANY_PUBLICATION_HOSTS)[0];
  const get = (host, path, user, pass) =>
    worker.fetch(new Request(`https://${host}${path}`, { headers: { Authorization: `Basic ${btoa(`${user}:${pass}`)}` } }), env);
  assert.equal((await get("tooling.example", "/tandemsdd/marketplace.json", "all", "p1")).status, 200);
  assert.equal((await get(anyHost, "/l10n/archives/l10n-1.1.0.tgz", "all", "p1")).status, 200);
  assert.equal((await get(anyHost, "/l10n/archives/l10n-1.1.0.tgz", "l10n-only", "p2")).status, 200);
  assert.equal((await get("tooling.example", "/tandemsdd/marketplace.json", "l10n-only", "p2")).status, 403);
});

test("the commands, on a file of their own", () => {
  const dir = mkdtempSync(join(tmpdir(), "consumers-"));
  const file = join(dir, "consumers.htpasswd");
  try {
    let r = run(file, ["add", "aggrega", "*"], "secret-1\n");
    assert.equal(r.code, 0, r.err);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8"), `aggrega:${hashPassword("secret-1")}:*\n`);

    r = run(file, ["add", "acme", "l10n", "--generate"]);
    assert.equal(r.code, 0, r.err);
    const password = /password: (\S+)/.exec(r.out)[1];
    assert.match(readFileSync(file, "utf8"), new RegExp(`^acme:${hashPassword(password)}:l10n$`, "m"));

    assert.equal(run(file, ["add", "acme", "l10n"], "x\n").code, 2, "a username twice");
    assert.equal(run(file, ["add", "typo", "l1On"], "x\n").code, 2, "an unknown publication");
    assert.equal(run(file, ["add", "nopass", "l10n"], "\n").code, 2, "an empty password");

    writeFileSync(file, `# kept\n${readFileSync(file, "utf8")}`);
    assert.equal(run(file, ["allow", "acme", "tandemsdd,l10n"]).code, 0);
    assert.equal(run(file, ["passwd", "aggrega"], "secret-2\n").code, 0);
    assert.equal(run(file, ["remove", "acme"]).code, 0);
    assert.equal(readFileSync(file, "utf8"), `# kept\naggrega:${hashPassword("secret-2")}:*\n`);
    assert.equal(run(file, ["remove", "aggrega"]).code, 2, "the last consumer is not removed");

    r = run(file, ["json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), [{ name: "aggrega", username: "aggrega", passwordSha256: hashPassword("secret-2"), publications: ["*"] }]);
    assert.match(run(file, ["list"]).out, /^aggrega\t\*$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
