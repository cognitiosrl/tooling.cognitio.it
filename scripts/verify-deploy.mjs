// Verifies that a deploy's uploaded version is the one serving.
//
//   node scripts/verify-deploy.mjs --wrangler-output <ndjson> --deployment <json>
//
// <ndjson> is the file `wrangler deploy` appends one JSON entry per line to
// (WRANGLER_OUTPUT_FILE_PATH): the last entry of type "deploy" carries the uploaded
// `version_id`. <json> is the output of `wrangler deployments status --json`: the latest
// deployment, whose `versions` list each `version_id` with its `percentage`. Exit 0 when
// the uploaded version is the only one in the deployment, at 100 %; exit 1 naming the
// uploaded version and the deployment's versions otherwise.

import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`verify-deploy: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const outputPath = option("--wrangler-output");
const deploymentPath = option("--deployment");
if (!outputPath || !deploymentPath || args.length !== 4) {
  fail("usage: verify-deploy.mjs --wrangler-output <ndjson> --deployment <json>");
}

function readFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    return fail(`cannot read ${path}: ${error.code}`);
  }
}

let uploaded;
for (const line of readFile(outputPath).split("\n")) {
  if (line.trim() === "") continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    fail(`${outputPath} has a line that is not JSON`);
  }
  if (entry?.type === "deploy" && typeof entry.version_id === "string") uploaded = entry.version_id;
}
if (uploaded === undefined) fail(`${outputPath} has no deploy entry carrying a version_id`);

let deployment;
try {
  deployment = JSON.parse(readFile(deploymentPath));
} catch {
  fail(`${deploymentPath} is not JSON`);
}
if (!Array.isArray(deployment?.versions) || deployment.versions.length === 0) {
  fail(`${deploymentPath} lists no versions`);
}

const serving = deployment.versions.map((v) => `${v.version_id} at ${v.percentage}%`).join(", ");
const [only] = deployment.versions;
if (deployment.versions.length !== 1 || only.version_id !== uploaded || only.percentage !== 100) {
  fail(`the uploaded version ${uploaded} is not the only version serving at 100%; the deployment serves ${serving}`);
}
console.log(`verify-deploy: ${uploaded} serves at 100%`);
