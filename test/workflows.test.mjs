// The two workflows, read line by line (no YAML library): where each credential can reach, how
// actions are pinned, what a run without secrets still does. A workflow's steps all start at
// `      - name:`; comments are dropped before any search, so a header may name a secret freely.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workflowDir = resolve(here, "..", ".github", "workflows");

function load(file) {
  const lines = readFileSync(resolve(workflowDir, file), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"));
  const head = [];
  const steps = [];
  for (const line of lines) {
    const start = /^ {6}- name: (.+)$/.exec(line);
    if (start) steps.push({ name: start[1].trim(), lines: [line] });
    else if (steps.length === 0) head.push(line);
    else steps[steps.length - 1].lines.push(line);
  }
  for (const step of steps) step.text = step.lines.join("\n");
  return { file, text: lines.join("\n"), head: head.join("\n"), steps };
}

const deploy = load("deploy.yml");
const plan = load("plan.yml");
const both = [deploy, plan];
const code = (step) => step.text;
const stepsMentioning = (workflow, pattern) => workflow.steps.filter((step) => pattern.test(code(step))).map((s) => s.name);
const named = (workflow, name) => {
  const found = workflow.steps.filter((step) => step.name === name);
  assert.equal(found.length, 1, `${workflow.file} has no single step named "${name}"`);
  return found[0];
};

test("every action is pinned to a commit with its tag", () => {
  for (const workflow of both) {
    const uses = workflow.text.split("\n").filter((line) => /^\s*(- )?uses:/.test(line));
    assert.ok(uses.length > 0, `${workflow.file} uses no action`);
    for (const line of uses) {
      assert.match(line.trim(), /^(- )?uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${workflow.file}: ${line}`);
    }
  }
});

test("permissions are contents: read only", () => {
  for (const workflow of both) {
    const all = workflow.text.split("\n");
    const at = all.findIndex((line) => line === "permissions:");
    assert.ok(at >= 0, `${workflow.file} has no top-level permissions`);
    const block = [];
    for (const line of all.slice(at + 1)) {
      if (!line.startsWith(" ")) break;
      block.push(line);
    }
    assert.deepEqual(block, ["  contents: read"], workflow.file);
    assert.equal(all.filter((line) => /^\s*permissions:/.test(line)).length, 1, `${workflow.file} sets permissions twice`);
    assert.doesNotMatch(workflow.text, /id-token|: write/, workflow.file);
  }
});

test("no pull_request_target", () => {
  for (const workflow of both) assert.doesNotMatch(workflow.text, /pull_request_target/, workflow.file);
  assert.match(plan.head, /^ {2}pull_request:$/m);
});

test("CLOUDFLARE_API_TOKEN appears only in the OpenTofu, D1, deploy and verify steps", () => {
  const allowed = /^(OpenTofu|D1 |Deploy |Verify )/;
  for (const workflow of both) {
    assert.doesNotMatch(workflow.head, /CLOUDFLARE_API_TOKEN/, `${workflow.file}: job-level`);
    const holders = stepsMentioning(workflow, /CLOUDFLARE_API_TOKEN/);
    for (const name of holders) assert.match(name, allowed, `${workflow.file}: ${name}`);
  }
  const holders = stepsMentioning(deploy, /CLOUDFLARE_API_TOKEN/);
  for (const expected of ["OpenTofu apply", "D1 migrations", "Deploy the admin Worker", "Verify the deployments"]) {
    assert.ok(holders.includes(expected), `${expected} does not hold the token`);
  }
  assert.ok(!holders.includes("Write the secrets files"));
});

test("TOFU_STATE_PASSPHRASE and ACCESS_ALLOWED_EMAILS appear only in the OpenTofu step", () => {
  for (const [workflow, step] of [[deploy, "OpenTofu apply"], [plan, "OpenTofu plan"]]) {
    for (const name of ["TOFU_STATE_PASSPHRASE", "ACCESS_ALLOWED_EMAILS"]) {
      assert.doesNotMatch(workflow.head, new RegExp(name), `${workflow.file}: job-level`);
      assert.deepEqual(stepsMentioning(workflow, new RegExp(name)), [step], `${workflow.file}: ${name}`);
    }
  }
});

test("COGNITIO_TOOLING_DEPLOY_KEY appears only in the cognitio-tooling checkout", () => {
  for (const workflow of both) {
    assert.doesNotMatch(workflow.head, /COGNITIO_TOOLING_DEPLOY_KEY/, workflow.file);
    assert.deepEqual(stepsMentioning(workflow, /COGNITIO_TOOLING_DEPLOY_KEY/), ["Check out cognitio-tooling"], workflow.file);
    const step = named(workflow, "Check out cognitio-tooling");
    assert.match(step.text, /ssh-key: \$\{\{ secrets\.COGNITIO_TOOLING_DEPLOY_KEY \}\}/);
    assert.match(step.text, /persist-credentials: false/);
  }
});

test("the secrets files are removed in an always() step, right after the last deploy that reads them", () => {
  const writer = deploy.steps.findIndex((step) => step.name === "Write the secrets files");
  const remover = deploy.steps.findIndex((step) => step.name === "Remove the secrets files");
  const serve = deploy.steps.findIndex((step) => step.name === "Deploy the serve Worker");
  assert.ok(writer >= 0 && serve > writer, "order: write, then the deploys");
  assert.equal(remover, serve + 1, "the remover is the step after Deploy the serve Worker");
  for (const [at, step] of deploy.steps.entries()) {
    if (/secrets\.json/.test(code(step))) assert.ok(at >= writer && at <= remover, `${step.name} reads a secrets file outside write..remove`);
  }
  const step = deploy.steps[remover];
  assert.match(step.text, /^ {8}if: \$\{\{ always\(\) \}\}$/m);
  assert.match(step.text, /rm -f .*serve-secrets\.json.*admin-secrets\.json|rm -f .*admin-secrets\.json.*serve-secrets\.json/);
  assert.match(deploy.steps[writer].text, /umask 077/);
});

test("no job-level env holds a secret or a secret-bearing output", () => {
  for (const workflow of both) {
    assert.doesNotMatch(workflow.head, /secrets\./, workflow.file);
    assert.doesNotMatch(workflow.head, /VERIFIER_KEY|CSRF_KEY/, workflow.file);
  }
});

test("the generated keys and the filled ids are read only by the steps that need them", () => {
  assert.deepEqual(stepsMentioning(deploy, /steps\.\w+\.outputs\.(VERIFIER_KEY|CSRF_KEY)/), ["Write the secrets files"]);
  assert.deepEqual(stepsMentioning(deploy, /steps\.\w+\.outputs\.(D1_DATABASE_ID|ADMIN_ACCESS_AUD)/), ["Fill the Wrangler configuration"]);
  const fill = named(deploy, "Fill the Wrangler configuration").text;
  assert.match(fill, /D1_DATABASE_ID: \$\{\{ steps\.tofu\.outputs\.D1_DATABASE_ID \}\}/);
  assert.match(fill, /ACCESS_AUD: \$\{\{ steps\.tofu\.outputs\.ADMIN_ACCESS_AUD \}\}/);
  assert.match(fill, /ACCESS_TEAM_DOMAIN: \$\{\{ vars\.ACCESS_TEAM_DOMAIN \}\}/);
  const secrets = named(deploy, "Write the secrets files").text;
  assert.match(secrets, /VERIFIER_KEY: \$\{\{ steps\.tofu\.outputs\.VERIFIER_KEY \}\}/);
  assert.match(secrets, /CSRF_KEY: \$\{\{ steps\.tofu\.outputs\.CSRF_KEY \}\}/);
});

test("no expression is interpolated into a script", () => {
  for (const workflow of both) {
    for (const step of workflow.steps) {
      const at = step.lines.findIndex((line) => /^ {8}run:/.test(line));
      if (at === -1) continue;
      const script = step.lines.slice(at).join("\n");
      assert.doesNotMatch(script, /\$\{\{/, `${workflow.file}: ${step.name}`);
      assert.equal(step.lines.slice(at + 1).some((line) => /^ {8}\w[\w-]*:/.test(line)), false, `${step.name}: run is not the last key`);
    }
  }
});

test("deploy.yml triggers, guards and limits", () => {
  assert.match(deploy.head, /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.match(deploy.head, /^ {2}workflow_dispatch:$/m);
  for (const input of ["plan_only", "infra_change_confirmed", "delete_confirmed"]) {
    assert.match(deploy.head, new RegExp(`^ {6}${input}:\\n {8}description: .+\\n {8}type: boolean\\n {8}default: false$`, "m"), input);
  }
  assert.match(deploy.head, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(deploy.head, /^ {2}group: deploy-\$\{\{ github\.repository \}\}\n {2}cancel-in-progress: false$/m);
  assert.match(deploy.head, /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(deploy.head, /^ {4}timeout-minutes: 30$/m);
});

test("the deploys carry a message and an output file, in order", () => {
  const order = deploy.steps.filter((s) => s.name.startsWith("Deploy ")).map((s) => s.name);
  assert.deepEqual(order, ["Deploy the admin Worker", "Deploy the serve Worker", "Deploy the registry", "Deploy the files Worker"]);
  for (const name of order) {
    const step = named(deploy, name).text;
    assert.match(step, /--message "\$MESSAGE"/, name);
    assert.match(step, /WRANGLER_OUTPUT_FILE_PATH: /, name);
  }
  assert.match(named(deploy, "Deploy the admin Worker").text, /--secrets-file "\$RUNNER_TEMP\/admin-secrets\.json"/);
  assert.match(named(deploy, "Deploy the serve Worker").text, /--secrets-file "\$RUNNER_TEMP\/serve-secrets\.json"/);
  const registry = named(deploy, "Deploy the registry").text;
  assert.match(registry, /pnpm exec wrangler deploy --config \.\.\/workers\/registry\.wrangler\.jsonc/);
  assert.match(registry, /working-directory: serverless-registry/);
});

test("the dependency installs run no install script and hold no credential", () => {
  const installs = [
    [deploy, "Install the install's dependencies", /^ {8}run: npm ci --ignore-scripts$/m],
    [plan, "Install the install's dependencies", /^ {8}run: npm ci --ignore-scripts$/m],
    [deploy, "Install the registry's dependencies", /^ {8}run: pnpm install --frozen-lockfile --ignore-scripts$/m],
  ];
  for (const [workflow, name, command] of installs) {
    const step = named(workflow, name);
    assert.match(code(step), command, `${workflow.file}: ${name}`);
    assert.doesNotMatch(step.text, /secrets\.|CLOUDFLARE|env:/, `${workflow.file}: ${name}`);
  }
  for (const workflow of both) {
    for (const step of workflow.steps) {
      for (const line of code(step).split("\n").filter((l) => /\b(npm (ci|install|i)|pnpm (install|i|add))\b/.test(l))) {
        assert.match(line, /--ignore-scripts/, `${workflow.file}: ${step.name}`);
      }
    }
  }
});

test("a plan_only run stops after the plan", () => {
  const names = deploy.steps.map((s) => s.name);
  const after = deploy.steps.slice(names.indexOf("OpenTofu apply") + 1);
  assert.ok(after.length > 0);
  for (const step of after) {
    if (step.name === "Remove the secrets files") continue;
    assert.match(step.text, /^ {8}if: \$\{\{ inputs\.plan_only != true \}\}$/m, step.name);
  }
  const tofu = named(deploy, "OpenTofu apply").text;
  assert.match(tofu, /PLAN_ONLY: \$\{\{ inputs\.plan_only \}\}/);
  assert.match(tofu, /scripts\/tofu\.sh plan/);
  assert.match(tofu, /scripts\/tofu\.sh output --github-output "\$GITHUB_OUTPUT"/);
  assert.match(tofu, /^ {8}id: tofu$/m);
});

test("the setup actions read the committed versions", () => {
  assert.match(named(deploy, "Set up Node").text, /node-version-file: \.nvmrc/);
  const tofu = named(deploy, "Set up OpenTofu").text;
  assert.match(tofu, /tofu_version_file: iac\/\.opentofu-version/);
  assert.match(tofu, /tofu_wrapper: false/);
  assert.match(named(deploy, "Set up pnpm").text, /package_json_file: serverless-registry\/package\.json/);
});

test("the smoke step holds no credential and checks the three public hosts", () => {
  const smoke = named(deploy, "Smoke test the public hosts").text;
  assert.doesNotMatch(smoke, /CLOUDFLARE|secrets\./);
  for (const url of ["https://tooling.aggrega.ai/v2/", "https://tooling.aggrega.ai/tandemsdd/marketplace.json", "https://tooling.cognitio.it/l10n/index.json"]) {
    assert.ok(smoke.includes(url), url);
  }
});

test("a run without secrets skips the steps that need them", () => {
  const flag = /^ {6}WITHOUT_SECRETS: \$\{\{ (.+) \}\}$/m.exec(plan.head);
  assert.ok(flag, "plan.yml states the condition once, in the job's env");
  assert.ok(flag[1].includes("github.event.pull_request.head.repo.full_name != github.repository"));
  assert.ok(flag[1].includes("github.actor == 'dependabot[bot]'"));
  assert.ok(flag[1].includes("github.event.pull_request.user.login == 'dependabot[bot]'"), "a reopened Dependabot pull request is still without secrets");
  assert.equal(plan.text.split("github.actor == 'dependabot[bot]'").length, 2, "the condition is written once");
  const skipped = /^ {8}if: \$\{\{ env\.WITHOUT_SECRETS != 'true' \}\}$/m;
  for (const name of ["Read the pins", "Check out cognitio-tooling", "Check out serverless-registry", "Check the pins", "Test cognitio-tooling", "Test the install", "Set up OpenTofu", "OpenTofu plan"]) {
    assert.match(named(plan, name).text, skipped, name);
  }
  const without = named(plan, "Test the install without the checkouts").text;
  assert.match(without, /^ {8}if: \$\{\{ env\.WITHOUT_SECRETS == 'true' \}\}$/m);
  assert.match(without, /node --test test\/tofu\.test\.mjs test\/scripts\.test\.mjs test\/pins\.test\.mjs test\/workflows\.test\.mjs/);
  // Whatever has no condition must not touch a checkout or the secrets.
  for (const step of plan.steps) {
    if (/if: \$\{\{ env\.WITHOUT_SECRETS != 'true' \}\}/.test(step.text)) continue;
    assert.doesNotMatch(code(step), /cognitio-tooling|check-pins|tofu\.sh|secrets\.|configs\.test/, step.name);
    if (!/working-directory: files/.test(step.text)) assert.doesNotMatch(code(step), /run: npm test/, step.name);
  }
  assert.match(named(plan, "OpenTofu plan").text, /scripts\/tofu\.sh plan/);
});

test("plan.yml runs for a pull request to main and cancels older runs", () => {
  assert.match(plan.head, /^ {2}pull_request:\n {4}branches: \[main\]$/m);
  assert.match(plan.head, /^ {2}group: plan-\$\{\{ github\.event\.pull_request\.number \}\}\n {2}cancel-in-progress: true$/m);
  assert.doesNotMatch(plan.text, /tofu\.sh apply|wrangler/);
});

test("the pin-reading steps are the same in both workflows", () => {
  const strip = (step) => step.lines.filter((line) => !/^ {8}if: /.test(line)).join("\n");
  for (const name of ["Read the pins", "Check out cognitio-tooling", "Check out serverless-registry"]) {
    assert.equal(strip(named(plan, name)), strip(named(deploy, name)), name);
  }
});

test("a workflow reads secrets, step outputs and the environment only by name", () => {
  for (const workflow of both) {
    for (const [at, line] of workflow.text.split("\n").entries()) {
      if (/^ {6}- name: /.test(line)) continue;
      const expressions = /^\s*if: /.test(line) ? line : (line.match(/\$\{\{.*?\}\}/g) ?? []).join(" ");
      for (const token of expressions.matchAll(/\bsecrets\b/g)) {
        const rest = expressions.slice(token.index);
        assert.match(rest, /^secrets\.(CLOUDFLARE_API_TOKEN|TOFU_STATE_PASSPHRASE|ACCESS_ALLOWED_EMAILS|COGNITIO_TOOLING_DEPLOY_KEY)\b/, `${workflow.file}: ${line.trim()}`);
      }
      for (const token of line.matchAll(/steps\.tofu\.outputs/g)) {
        assert.match(line.slice(token.index), /^steps\.tofu\.outputs\.[A-Z0-9_]+/, `${workflow.file}: ${line.trim()}`);
      }
      assert.doesNotMatch(line, /toJSON|GITHUB_ENV/, `${workflow.file}:${at}`);
    }
    for (const line of workflow.text.split("\n")) {
      if (/^ {6}- /.test(line)) assert.match(line, /^ {6}- name: /, `${workflow.file}: ${line}`);
    }
  }
});

test("the pins are checked again after the tests, just before the D1 migrations", () => {
  const names = deploy.steps.map((s) => s.name);
  const d1 = names.indexOf("D1 migrations");
  const lastTest = names.reduce((last, name, i) => (name.startsWith("Test ") ? i : last), -1);
  const check = deploy.steps[d1 - 1];
  assert.ok(d1 > 0 && lastTest >= 0);
  assert.match(code(check), /^ {8}run: scripts\/check-pins\.sh$/m, `the step before D1 migrations is "${check.name}"`);
  assert.ok(d1 - 1 > lastTest, "after every test step");
  assert.doesNotMatch(check.text, /secrets\.|CLOUDFLARE|env:/);
  assert.equal(stepsMentioning(deploy, /scripts\/check-pins\.sh/).length, 2);
});

test("the deploy takes the tag and the Worker names from their homes", () => {
  const checked = named(deploy, "Check the pins").text;
  assert.match(checked, /pins=\$\(scripts\/check-pins\.sh\)/);
  assert.doesNotMatch(checked, /tag --points-at|describe/);
  const verify = named(deploy, "Verify the deployments").text;
  assert.doesNotMatch(verify, /--name/);
  assert.match(verify, /deployments status --json --config "\$1"/);
});

test("the no-secrets test list is every test file but the one needing a checkout", () => {
  const listed = /node --test ((?:test\/\S+\.test\.mjs ?)+)$/m.exec(named(plan, "Test the install without the checkouts").text);
  assert.ok(listed);
  const expected = readdirSync(here).filter((f) => f.endsWith(".test.mjs") && f !== "configs.test.mjs").map((f) => `test/${f}`).sort();
  assert.deepEqual(listed[1].trim().split(" ").sort(), expected);
});
