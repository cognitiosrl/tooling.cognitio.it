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

// A root holding both checkouts. `fn` shapes the checkouts after the first commit; origin/main
// and origin/aggrega are made to point at the tooling's and the registry's first commit. The root then records each checkout's HEAD
// as its gitlink, as the install's commit does, and `after` shapes the checkouts once more.
function root(arg) {
  const setup = typeof arg === "function" ? { fn: arg } : arg;
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), "pins-test-")));
  // The root is itself a repository, as the install is: git must not walk up into it.
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "root");
  const tooling = resolve(dir, "cognitio-tooling");
  const registry = resolve(dir, "serverless-registry");
  const checkouts = setup.checkouts ?? true;
  if (checkouts) {
    for (const repo of [tooling, registry]) {
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
    }
    const toolingFirst = commit(tooling, "one");
    if (!setup.noToolingMain) git(tooling, "update-ref", "refs/remotes/origin/main", toolingFirst);
    const first = commit(registry, "one");
    if (!setup.noOrigin) git(registry, "update-ref", "refs/remotes/origin/aggrega", first);
  } else {
    mkdirSync(tooling);
    mkdirSync(registry);
  }
  setup.fn?.({ tooling, registry });
  if (checkouts) {
    git(dir, "-c", "advice.addEmbeddedRepo=false", "add", "cognitio-tooling", "serverless-registry");
    git(dir, "commit", "-q", "-m", "pins");
    setup.after?.({ tooling, registry });
  }
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

test("an empty checkout directory is refused, naming it", () => {
  const r = root({ checkouts: false });
  try {
    const out = r.run();
    assert.equal(out.status, 1);
    assert.match(out.stderr, /cognitio-tooling is not a git checkout \(its repository is /);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a dirty checkout is refused, naming it", () => {
  for (const which of ["tooling", "registry"]) {
    const r = root(({ tooling, registry }) => {
      git(tooling, "tag", "v1.2.3");
      writeFileSync(resolve(which === "tooling" ? tooling : registry, "one"), "changed");
    });
    try {
      const out = r.run();
      assert.equal(out.status, 1);
      assert.match(out.stderr, which === "tooling" ? /cognitio-tooling has changes to tracked files/ : /serverless-registry has changes to tracked files/);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }
});

test("a registry checkout without origin/aggrega is refused", () => {
  const r = root({ noOrigin: true, fn: ({ tooling }) => git(tooling, "tag", "v1.2.3") });
  try {
    const out = r.run();
    assert.equal(out.status, 1);
    assert.match(out.stderr, /serverless-registry has no origin\/aggrega/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a tag that is not vX.Y.Z is refused", () => {
  const r = root(({ tooling }) => git(tooling, "tag", "v1.2.3-rc1"));
  try {
    const out = r.run();
    assert.equal(out.status, 1);
    assert.match(out.stderr, /cognitio-tooling is not exactly at a release tag vX\.Y\.Z/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a checkout that is not at the install's gitlink is refused, naming it", () => {
  for (const which of ["cognitio-tooling", "serverless-registry"]) {
    const r = root({
      fn: ({ tooling }) => git(tooling, "tag", "v1.2.3"),
      // The checkout moves to a commit that passes every other check.
      after: ({ tooling, registry }) => {
        if (which === "cognitio-tooling") {
          commit(tooling, "two");
          git(tooling, "tag", "v1.2.4");
          git(tooling, "update-ref", "refs/remotes/origin/main", "HEAD");
        } else {
          commit(registry, "two");
          git(registry, "update-ref", "refs/remotes/origin/aggrega", "HEAD");
        }
      },
    });
    try {
      const out = r.run();
      assert.equal(out.status, 1, which);
      assert.match(out.stderr, new RegExp(`^check-pins: ${which} is at [0-9a-f]{40}, not at the install's pin [0-9a-f]{40}$`, "m"), which);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }
});

test("a release tag on a commit off origin/main is refused", () => {
  const r = root(({ tooling }) => {
    git(tooling, "checkout", "-q", "-b", "side");
    commit(tooling, "two");
    git(tooling, "tag", "v1.2.3");
  });
  try {
    const out = r.run();
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^check-pins: cognitio-tooling v1\.2\.3 is not on origin\/main; a release is tagged on main$/m);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a tooling checkout without origin/main is refused", () => {
  const r = root({ noToolingMain: true, fn: ({ tooling }) => git(tooling, "tag", "v1.2.3") });
  try {
    const out = r.run();
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^check-pins: cognitio-tooling has no origin\/main \(fetch the main branch\)$/m);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
