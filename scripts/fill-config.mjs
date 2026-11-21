// Fills a Wrangler configuration's placeholders from the environment.
//
//   node scripts/fill-config.mjs <source>.jsonc
//
// Each REPLACE_<X> in the source is replaced by the value of the environment variable <X>,
// escaped as the body of a JSON string. The result is written beside the source as
// <name>.filled.jsonc, where <name> is the source's name without `.wrangler` and `.jsonc`
// (workers/admin.wrangler.jsonc gives workers/admin.filled.jsonc, which .gitignore covers).
// An unset or empty variable, a REPLACE_ left after filling, or a result that does not
// parse as JSONC stops the script with exit 1 and no file written. No value is printed.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { parseJsonc } from "./jsonc.mjs";

const PLACEHOLDER = /REPLACE_[A-Z][A-Z0-9_]*/g;

function fail(message) {
  console.error(`fill-config: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 1 || args[0].startsWith("-")) fail("usage: fill-config.mjs <source>.jsonc");
const source = resolve(args[0]);
if (!source.endsWith(".jsonc")) fail(`${basename(source)} is not a .jsonc file`);

const text = readFileSync(source, "utf8");
const missing = new Set();
const filled = text.replace(PLACEHOLDER, (placeholder) => {
  const value = process.env[placeholder.slice("REPLACE_".length)];
  if (value === undefined || value === "") {
    missing.add(placeholder);
    return placeholder;
  }
  return JSON.stringify(value).slice(1, -1);
});
if (missing.size > 0) {
  fail(`${[...missing].join(", ")} ${missing.size === 1 ? "has" : "have"} no value: the environment variable named without the REPLACE_ prefix is unset or empty`);
}

const left = filled.match(PLACEHOLDER);
if (left) fail(`${[...new Set(left)].join(", ")} left after filling`);

try {
  parseJsonc(filled);
} catch {
  fail(`the filled ${basename(source)} does not parse as JSONC`);
}

const name = basename(source, ".jsonc").replace(/\.wrangler$/, "");
const out = resolve(dirname(source), `${name}.filled.jsonc`);
writeFileSync(out, filled);
console.log(`fill-config: wrote ${basename(out)}`);
