#!/usr/bin/env node
//
// consumers.mjs [--file <path>] <command> ...
//
// Keeps the files Worker's consumers in a local file, one consumer per line, the way
// htpasswd keeps a web server's users, and puts them to the Worker as its CONSUMERS
// secret:
//
//   <username>:<sha256 of the password, hex>:<publications, comma-separated, or *>
//
// Lines starting with "#" and blank lines are kept as they are. The file holds no
// password, but its hashes are unsalted, so it is kept out of git and with the
// operator's other secrets. The default file is ../consumers.htpasswd, beside this
// directory; --file names another.
//
// Commands:
//   add <username> <publications> [--generate]   a new consumer; prompts for the password
//   passwd <username> [--generate]               a new password for a consumer
//   allow <username> <publications>              replaces a consumer's publications
//   remove <username>                            deletes a consumer
//   list                                         the consumers and their publications
//   json                                         the CONSUMERS value the file stands for
//   push                                         puts that value as the Worker's CONSUMERS
//
// <publications> is a comma-separated list of publication names, or "*" for every
// publication, including one added later. A name starts with a lowercase letter or digit
// and continues with lowercase letters, digits and "-"; "v2" is not one. The files Worker serves the publications its wrangler.jsonc
// configures and ignores any other name in an entry. --generate makes a random
// password and prints it once; without it the password is read twice from the
// terminal, or once from standard input when that is not a terminal.
//
// Every change, and every push, is checked by the Worker's own consumer parser first,
// so the file never holds what the Worker would refuse. `push` runs
// `wrangler secret put CONSUMERS --config ./wrangler.jsonc` with the wrangler on PATH;
// the new list is live within seconds, with no deploy.
//
// Exit codes: 0 done; 1 the push failed; 2 usage, file or validation error.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { consumersFrom, publicationName } from "./worker.js";

const ALL = "*";
const USERNAME = /^[A-Za-z0-9._-]+$/;
const HASH = /^[0-9a-f]{64}$/;
const WRANGLER = new URL("./wrangler.jsonc", import.meta.url);
const DEFAULT_FILE = fileURLToPath(new URL("../consumers.htpasswd", import.meta.url));

export class UsageError extends Error {}

/** The SHA-256 of a password's UTF-8 bytes, in hex: what the Worker compares. */
export const hashPassword = (password) => createHash("sha256").update(password, "utf8").digest("hex");

/**
 * The file's lines: each consumer as `{username, hash, publications}`, every other
 * line as `{raw}`, so a rewrite keeps comments where they were.
 *
 * @param {string} text
 */
export function parseFile(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, i) => {
    if (line.trim() === "" || line.startsWith("#")) return { raw: line };
    const parts = line.split(":");
    if (parts.length !== 3) throw new UsageError(`line ${i + 1}: not <username>:<sha256>:<publications>`);
    const [username, hash, pubs] = parts;
    if (!USERNAME.test(username)) throw new UsageError(`line ${i + 1}: "${username}" is not a username: letters, digits, ".", "_" and "-"`);
    if (!HASH.test(hash)) throw new UsageError(`line ${i + 1}: the password hash is not 64 lowercase hex digits`);
    return { username, hash, publications: splitPublications(pubs, `line ${i + 1}`) };
  });
}

/** @param {ReturnType<typeof parseFile>} entries */
export function formatFile(entries) {
  return entries.map((e) => ("raw" in e ? e.raw : `${e.username}:${e.hash}:${e.publications.join(",")}`)).join("\n") + "\n";
}

/** `a,b` or `*` as a list; an empty list, a repeat, or "*" beside a name is refused. */
export function splitPublications(text, where = "publications") {
  const list = text.split(",").map((p) => p.trim());
  if (list.some((p) => p === "")) throw new UsageError(`${where}: "${text}" holds an empty publication`);
  if (new Set(list).size !== list.length) throw new UsageError(`${where}: "${text}" names a publication twice`);
  if (list.includes(ALL) && list.length > 1) throw new UsageError(`${where}: "*" already allows every publication; name nothing beside it`);
  return list;
}

/** The CONSUMERS value: one entry per consumer, named after its username. */
export function consumersJson(entries) {
  const list = entries
    .filter((e) => !("raw" in e))
    .map((e) => ({ name: e.username, username: e.username, passwordSha256: e.hash, publications: e.publications }));
  return JSON.stringify(list);
}

/**
 * Refuses a publication that is not a well-formed name, and a file with no consumer at
 * all. The name check is this tool's own: the Worker's consumer parser accepts any
 * string. A well-formed name the files Worker does not configure is kept; the Worker
 * ignores it.
 *
 * @param {ReturnType<typeof parseFile>} entries
 */
export async function validate(entries) {
  const consumers = entries.filter((e) => !("raw" in e));
  if (consumers.length === 0) throw new UsageError("the file holds no consumer");
  for (const c of consumers) {
    for (const p of c.publications) {
      if (p === ALL || publicationName(p)) continue;
      throw new UsageError(`${c.username}: "${p}" is not a publication name: it starts with a lowercase letter or digit and continues with lowercase letters, digits and "-", and is never "v2"`);
    }
  }
  const parsed = await consumersFrom({ CONSUMERS: consumersJson(entries) });
  if (parsed.error) throw new UsageError(parsed.error);
}

function readEntries(file, { mustExist }) {
  if (!existsSync(file)) {
    if (mustExist) throw new UsageError(`${file} does not exist; "add" creates it`);
    return [];
  }
  return parseFile(readFileSync(file, "utf8"));
}

function writeEntries(file, entries) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, formatFile(entries), { mode: 0o600 });
  renameSync(tmp, file);
}

function find(entries, username) {
  const entry = entries.find((e) => e.username === username);
  if (!entry) throw new UsageError(`no consumer "${username}"`);
  return entry;
}

/** Reads one line, with no echo when standard input is a terminal. */
function ask(prompt) {
  const tty = process.stdin.isTTY;
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: tty });
  if (tty) {
    process.stderr.write(prompt);
    rl._writeToOutput = () => {};
  }
  return new Promise((resolve) => {
    rl.once("line", (line) => {
      if (tty) process.stderr.write("\n");
      // Resolved before closing: close() emits "close" at once, which resolves with "".
      resolve(line);
      rl.close();
    });
    rl.once("close", () => resolve(""));
  });
}

async function newPassword(generate) {
  if (generate) {
    const password = randomBytes(24).toString("base64url");
    console.log(`password: ${password}`);
    console.log("It is shown once and stored nowhere; hand it to the consumer now.");
    return password;
  }
  const password = await ask("password: ");
  if (password === "") throw new UsageError("an empty password");
  if (process.stdin.isTTY && (await ask("again: ")) !== password) throw new UsageError("the two passwords differ");
  return password;
}

export async function main(argv) {
  const args = [...argv];
  let file = DEFAULT_FILE;
  const at = args.indexOf("--file");
  if (at !== -1) {
    file = args[at + 1];
    if (!file) throw new UsageError("--file needs a path");
    args.splice(at, 2);
  }
  const generate = args.includes("--generate");
  const [command, ...rest] = args.filter((a) => a !== "--generate");

  switch (command) {
    case "add": {
      const [username, pubs] = rest;
      if (!username || !pubs || rest.length !== 2) throw new UsageError("usage: add <username> <publications> [--generate]");
      const entries = readEntries(file, { mustExist: false });
      if (!USERNAME.test(username)) throw new UsageError(`"${username}" is not a username: letters, digits, ".", "_" and "-"`);
      if (entries.some((e) => e.username === username)) throw new UsageError(`"${username}" already exists; use passwd or allow`);
      // A placeholder hash, so the entry is validated before a password is asked for.
      const entry = { username, hash: "0".repeat(64), publications: splitPublications(pubs) };
      await validate([...entries, entry]);
      entry.hash = hashPassword(await newPassword(generate));
      writeEntries(file, [...entries, entry]);
      console.log(`added ${username}: ${entry.publications.join(",")}. Run "push" to make it live.`);
      return 0;
    }
    case "passwd": {
      const [username] = rest;
      if (!username || rest.length !== 1) throw new UsageError("usage: passwd <username> [--generate]");
      const entries = readEntries(file, { mustExist: true });
      const entry = find(entries, username);
      entry.hash = hashPassword(await newPassword(generate));
      writeEntries(file, entries);
      console.log(`changed the password of ${username}. Run "push" to make it live.`);
      return 0;
    }
    case "allow": {
      const [username, pubs] = rest;
      if (!username || !pubs || rest.length !== 2) throw new UsageError("usage: allow <username> <publications>");
      const entries = readEntries(file, { mustExist: true });
      find(entries, username).publications = splitPublications(pubs);
      await validate(entries);
      writeEntries(file, entries);
      console.log(`${username} is allowed ${pubs}. Run "push" to make it live.`);
      return 0;
    }
    case "remove": {
      const [username] = rest;
      if (!username || rest.length !== 1) throw new UsageError("usage: remove <username>");
      const entries = readEntries(file, { mustExist: true });
      find(entries, username);
      const kept = entries.filter((e) => e.username !== username);
      await validate(kept);
      writeEntries(file, kept);
      console.log(`removed ${username}. Run "push" to make it live.`);
      return 0;
    }
    case "list": {
      for (const e of readEntries(file, { mustExist: true })) {
        if (!("raw" in e)) console.log(`${e.username}\t${e.publications.join(",")}`);
      }
      return 0;
    }
    case "json":
    case "push": {
      const entries = readEntries(file, { mustExist: true });
      await validate(entries);
      const json = consumersJson(entries);
      if (command === "json") {
        console.log(json);
        return 0;
      }
      const run = spawnSync("wrangler", ["secret", "put", "CONSUMERS", "--config", fileURLToPath(WRANGLER)], {
        input: json,
        stdio: ["pipe", "inherit", "inherit"],
      });
      if (run.error || run.status !== 0) {
        console.error("consumers.mjs: wrangler secret put CONSUMERS failed");
        return 1;
      }
      console.log(`consumers.mjs: put ${entries.filter((e) => !("raw" in e)).length} consumer(s) as CONSUMERS`);
      return 0;
    }
    case "--help":
    case "-h":
    case undefined: {
      const self = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
      console.log(self.slice(2, self.indexOf("") ).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      return command === undefined ? 2 : 0;
    }
    default:
      throw new UsageError(`unknown command "${command}"; --help lists them`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`consumers.mjs: ${err.message}`);
      process.exit(err instanceof UsageError ? 2 : 1);
    },
  );
}
