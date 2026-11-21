#!/usr/bin/env node
//
// publish.mjs <publication> <path> <file> [--dry-run]
//
// Uploads <file> to the R2 key the files Worker serves as
// https://<host>/<publication>/<path>, on the host that routes the publication or on a
// host that serves any publication (see ../iac/variables.tf). The publication, its key
// prefix and the bucket come from ./wrangler.jsonc, and the key and content type from
// the Worker's own functions, so what is written is what the Worker reads. A name
// PUBLICATIONS does not configure is accepted when a host serves any publication, and is
// written at its default key prefix.
//
// It runs the wrangler on PATH as
//   wrangler r2 object put <bucket>/<key> --file <file> --content-type <type> --remote
// with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment; --dry-run
// prints that command and runs nothing. A package's release workflow in another
// repository runs the same command with the key this script prints.
//
// Reads ./wrangler.jsonc and <file>; writes one R2 object, or nothing under --dry-run.
// Exit codes: 0 uploaded (or printed), 1 the upload failed, 2 usage or configuration
// error.

import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { servingFrom, publicationName, defaultKeyPrefix, servablePath, objectKey, contentTypeFor } from "./worker.js";
import { readWranglerConfig, filesBucket } from "./wrangler-config.mjs";

const USAGE = "usage: publish.mjs <publication> <path> <file> [--dry-run]";

function fail(message) {
  console.error(`publish.mjs: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => a !== "--dry-run");
if (positional.length !== 3) fail(USAGE);
const [publication, path, file] = positional;

const config = readWranglerConfig(new URL("./wrangler.jsonc", import.meta.url));
const bucket = filesBucket(config);
if (!bucket) fail("wrangler.jsonc binds no FILES bucket");
const parsed = servingFrom(config.vars ?? {});
if (parsed.error) fail(`wrangler.jsonc: ${parsed.error}`);
const target =
  parsed.publications.get(publication) ??
  (parsed.hosts.size > 0 && publicationName(publication) ? { keyPrefix: defaultKeyPrefix(publication) } : null);
if (!target) fail(`"${publication}" is not a publication in wrangler.jsonc`);
if (!servablePath(path)) fail(`"${path}" is not a path the Worker serves`);
if (!existsSync(file) || !statSync(file).isFile()) fail(`${file} is not a file`);

const command = [
  "r2", "object", "put", `${bucket}/${objectKey(target, path)}`,
  "--file", file, "--content-type", contentTypeFor(path), "--remote",
];
if (dryRun) {
  console.log(["wrangler", ...command].join(" "));
  process.exit(0);
}
for (const v of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (!process.env[v]) fail(`${v} is not set`);
}
const run = spawnSync("wrangler", command, { stdio: "inherit" });
if (run.error || run.status !== 0) {
  console.error(`publish.mjs: uploading ${publication}/${path} failed`);
  process.exit(1);
}
console.log(`publish.mjs: uploaded ${publication}/${path}`);
