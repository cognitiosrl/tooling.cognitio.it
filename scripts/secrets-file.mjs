// Writes the secrets a deploy uploads, for `wrangler deploy --secrets-file`.
//
//   node scripts/secrets-file.mjs <out> <NAME>...
//
// <out> becomes a JSON object {NAME: value} taken from the environment variables of those
// names, created with mode 600. An existing <out>, and an unset or empty variable, stop the
// script with exit 1, naming the file or the variable; nothing it did not create is removed.
// No value is printed.

import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) {
  console.error(`secrets-file: ${message}`);
  process.exit(1);
}

const [outArg, ...names] = process.argv.slice(2);
if (!outArg || names.length === 0) fail("usage: secrets-file.mjs <out> <NAME>...");
const out = resolve(outArg);

const secrets = {};
for (const name of names) {
  const value = process.env[name];
  if (value === undefined || value === "") fail(`${name} is unset or empty`);
  secrets[name] = value;
}

let fd;
try {
  // "wx" creates the file or fails if it exists, atomically.
  fd = openSync(out, "wx", 0o600);
} catch (error) {
  if (error.code === "EEXIST") fail(`${out} already exists`);
  fail(`cannot create ${out}: ${error.code}`);
}
try {
  writeFileSync(fd, JSON.stringify(secrets));
} catch (error) {
  closeSync(fd);
  unlinkSync(out);
  fail(`cannot write ${out}: ${error.code}`);
}
closeSync(fd);
