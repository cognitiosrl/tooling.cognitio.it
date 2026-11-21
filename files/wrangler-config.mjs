// Reads the files Worker's wrangler.jsonc, so the publish script and the tests take the
// publications, and the bucket, from the same file wrangler deploys.

import { readFileSync } from "node:fs";

/**
 * The JSON text of a JSONC document: `//` and `/* *\/` comments outside strings are
 * removed. A trailing comma is not, so a configuration carrying one fails to parse. Pure.
 *
 * @param {string} text
 */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * The parsed wrangler configuration at a path. Reads that one file and writes nothing.
 *
 * @param {string | URL} path
 */
export function readWranglerConfig(path) {
  return JSON.parse(stripJsonc(readFileSync(path, "utf8")));
}

/**
 * The bucket name the FILES binding names in a parsed wrangler configuration, or null.
 *
 * @param {{r2_buckets?: {binding: string, bucket_name: string}[]}} config
 */
export function filesBucket(config) {
  const binding = (config.r2_buckets ?? []).find((b) => b.binding === "FILES");
  return binding ? binding.bucket_name : null;
}
