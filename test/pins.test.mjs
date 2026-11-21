// check-pins.sh against temporary git repositories laid out as the install's root is.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "..", "scripts", "check-pins.sh");

function git(cwd, ...args) {
  const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}
const commit = (cwd, name) => {
  writeFileSync(resolve(cwd, name), name);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", name);
  return git(cwd, "rev-parse", "HEAD");
};

// A root holding both checkouts. `tooling` and `registry` shape the checkouts after the
// first commit; origin/aggrega is made to point at the registry's first commit.
function root(setup) {
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), "pins-test-")));
  const tooling = resolve(dir, "cognitio-tooling");
  const registry = resolve(dir, "serverless-registry");
  for (const repo of [tooling, registry]) {
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
  }
  commit(tooling, "one");
  const first = commit(registry, "one");
  git(registry, "update-ref", "refs/remotes/origin/aggrega", first);
  setup({ tooling, registry });
  const run = () => spawnSync("bash", [script], { cwd: dir, encoding: "utf8" });
  return { dir, run };
}

test("a pin exactly at vX.Y.Z passes", () => {
  const r = root(({ tooling }) => {
    git(tooling, "tag", "latest");
    git(tooling, "tag", "-a", "-m", "release", "v1.2.3");
  });
  try {
    const out = r.run();
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /cognitio-tooling.*v1\.2\.3/);
    assert.match(out.stdout, /serverless-registry [0-9a-f]{40}/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a pin past the tag is refused", () => {
  const r = root(({ tooling }) => {
    git(tooling, "tag", "v1.2.3");
    commit(tooling, "two");
  });
  try {
    const out = r.run();
    assert.equal(out.status, 1);
    assert.match(out.stderr, /cognitio-tooling is not exactly at a release tag vX\.Y\.Z/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a registry pin off aggrega is refused", () => {
  const r = root(({ tooling, registry }) => {
    git(tooling, "tag", "v1.2.3");
    commit(registry, "two");
  });
  try {
    const out = r.run();
    assert.equal(out.status, 1);
    assert.match(out.stderr, /serverless-registry .* is not an ancestor of origin\/aggrega/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
