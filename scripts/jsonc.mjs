// JSONC reading for the Wrangler configurations: the comment stripper that the tests and the
// deploy scripts under scripts/ share. files/wrangler-config.mjs carries its own, deliberately:
// the files Worker's tools run from files/ alone and import nothing from outside it.

/**
 * The JSON of a JSONC text: comments and trailing commas go, string contents stay.
 * Throws on an unterminated string or block comment.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) throw new Error("unterminated string");
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated comment");
      i = end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * The parsed value of a JSONC text.
 *
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}
