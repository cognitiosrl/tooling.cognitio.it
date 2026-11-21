// The tooling hosts' files service: plain HTTPS files, per publication, from the
// tooling registry's R2 bucket.
//
// This Worker serves a publication's files from the registry's bucket:
//
//   GET /<publication>/<path>   ->   <the publication's key prefix><path>
//
// It is routed in one of two ways, and the request's host says which applies:
//
//   - A host ANY_PUBLICATION_HOSTS names is routed whole, and every publication name is
//     a publication there, with the key prefix `_files/<publication>/` and the host's
//     immutable path prefixes. A new publication is served as soon as its files are
//     uploaded, with no change to this Worker or its routes; one never uploaded is 404.
//   - On any other host, the Worker is routed at one path prefix per publication, and a
//     publication exists only when PUBLICATIONS names it. Its key prefix is
//     `_files/<publication>/` unless its entry names another. On the registry's own
//     host, every path no route claims reaches the registry Worker, which serves the
//     OCI API under /v2/.
//
// A key prefix starts with "_", which no OCI repository name can, so a file never
// shares a key with an image.
//
// A request is answered in this order, and the first that applies wins:
//
//   500  the Worker is not configured: no bucket binding, no valid PUBLICATIONS or
//        ANY_PUBLICATION_HOSTS, or no valid consumer list. Nothing is read.
//   401  no Basic credential, or one matching no consumer. Nothing is looked up.
//   404  the credential's consumer is not allowed the publication the path names: the
//        answer a file that does not exist gets, the same body and headers, and nothing
//        is read, so a consumer learns nothing of the publications it is not allowed.
//   405  a method other than GET.
//   404  a publication not configured, a path outside the rules below, or no object.
//   200  the object.
//
// A path is one or more segments of letters, digits, "_", "~", "-" and ".", none
// empty and none starting with ".", so neither "..", a hidden name, a percent-encoded
// byte nor a doubled slash ever reaches the bucket, and a key never leaves the
// publication's prefix.
//
// THE CONSUMERS. The secret CONSUMERS is a JSON array, one entry per consumer:
//
//   {"name": "...", "username": "...", "passwordSha256": "<64 hex digits>",
//    "publications": ["...", ...]}
//
// passwordSha256 is the SHA-256 of the password's UTF-8 bytes, so the secret holds no
// password. A consumer whose publications hold "*" is allowed every publication,
// including one added after its entry was written. CONSUMERS is the only source of
// consumers: the tooling registry's read-only pair, which every machine pulling the
// TANDEM Features logs in with, is an ordinary entry allowed `tandemsdd`. An absent or
// empty list, and two consumers with one username, are a misconfiguration.

const REALM = "tooling files";
const ALL_PUBLICATIONS = "*";
const PUBLICATION_NAME = /^[a-z0-9][a-z0-9-]*$/;
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const FILES_PREFIX = "_files/";
const PATH_SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
const MAX_PATH = 1024;
const IMMUTABLE = "private, max-age=31536000, immutable";
const REVALIDATE = "private, no-cache";

const CONTENT_TYPES = {
  json: "application/json",
  zip: "application/zip",
  tgz: "application/gzip",
  gz: "application/gzip",
  tar: "application/x-tar",
  txt: "text/plain; charset=utf-8",
  sha256: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  sh: "text/plain; charset=utf-8",
};

function configError(message) {
  return { error: message };
}

/**
 * Whether a name can be a publication: lowercase letters, digits and "-", starting with
 * a letter or digit, and never "v2", the registry's own path. Pure.
 *
 * @param {string} name
 */
export function publicationName(name) {
  return PUBLICATION_NAME.test(name) && name !== "v2";
}

/**
 * The key prefix a publication's files sit under when nothing names another. Pure.
 *
 * @param {string} name
 */
export function defaultKeyPrefix(name) {
  return `${FILES_PREFIX}${name}/`;
}

function immutableFrom(entry, where) {
  const immutable = entry.immutable ?? [];
  if (!Array.isArray(immutable) || !immutable.every((p) => typeof p === "string" && p !== "")) {
    return configError(`${where}.immutable must be a list of path prefixes`);
  }
  return { immutable };
}

function objectFrom(value, name, { optional }) {
  let raw = value;
  if (optional && (raw === undefined || raw === "")) return { raw: {} };
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return configError(`${name} is not JSON`);
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return configError(`${name} is not an object`);
  }
  return { raw };
}

/**
 * The publications a PUBLICATIONS value names, each with its key prefix and the path
 * prefixes served as immutable, or `{error}` when the value is not a valid
 * configuration. The value is an object, or its JSON text, mapping a publication name
 * to `{keyPrefix?: string, immutable?: string[]}`. Pure.
 *
 * @param {unknown} value
 * @returns {{publications: Map<string, {keyPrefix: string, immutable: string[]}>} | {error: string}}
 */
export function publicationsFrom(value) {
  const { raw, error } = objectFrom(value, "PUBLICATIONS", { optional: false });
  if (error) return configError(error);
  const publications = new Map();
  for (const [name, entry] of Object.entries(raw)) {
    if (!publicationName(name)) {
      return configError(`PUBLICATIONS names "${name}", which is not a publication name`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return configError(`PUBLICATIONS.${name} is not an object`);
    }
    const keyPrefix = entry.keyPrefix ?? defaultKeyPrefix(name);
    if (typeof keyPrefix !== "string" || !/^_[A-Za-z0-9._~/-]*\/$/.test(keyPrefix) || keyPrefix.includes("//")) {
      return configError(`PUBLICATIONS.${name}.keyPrefix must start with "_" and end with "/"`);
    }
    const imm = immutableFrom(entry, `PUBLICATIONS.${name}`);
    if (imm.error) return imm;
    publications.set(name, { keyPrefix, immutable: imm.immutable });
  }
  if (publications.size === 0) return configError("PUBLICATIONS names no publication");
  // One publication's prefix inside another's would let a path of the outer one read
  // the inner one's files.
  const prefixes = [...publications].map(([name, p]) => [name, p.keyPrefix]);
  for (const [a, pa] of prefixes) {
    for (const [b, pb] of prefixes) {
      if (a !== b && pb.startsWith(pa)) {
        return configError(`PUBLICATIONS: the key prefix of "${b}" lies inside that of "${a}"`);
      }
    }
  }
  return { publications };
}

/**
 * The hosts an ANY_PUBLICATION_HOSTS value names, each with the path prefixes served as
 * immutable there, or `{error}` when the value is not a valid configuration. The value
 * is an object, or its JSON text, mapping a lowercase host name to `{immutable?:
 * string[]}`; absent or empty, it names no host. Pure.
 *
 * @param {unknown} value
 * @returns {{hosts: Map<string, {immutable: string[]}>} | {error: string}}
 */
export function anyPublicationHostsFrom(value) {
  const { raw, error } = objectFrom(value, "ANY_PUBLICATION_HOSTS", { optional: true });
  if (error) return configError(error);
  const hosts = new Map();
  for (const [host, entry] of Object.entries(raw)) {
    if (!HOST_NAME.test(host)) {
      return configError(`ANY_PUBLICATION_HOSTS names "${host}", which is not a lowercase host name`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return configError(`ANY_PUBLICATION_HOSTS["${host}"] is not an object`);
    }
    const imm = immutableFrom(entry, `ANY_PUBLICATION_HOSTS["${host}"]`);
    if (imm.error) return imm;
    hosts.set(host, { immutable: imm.immutable });
  }
  return { hosts };
}

/**
 * The Worker's whole serving configuration: the named publications and the hosts that
 * serve any publication, or `{error}`. While a host serves any publication, a named
 * publication whose key prefix holds `_files/` itself is refused, since its paths would
 * read every publication's files. Pure.
 *
 * @param {{PUBLICATIONS?: unknown, ANY_PUBLICATION_HOSTS?: unknown}} env
 * @returns {{publications: Map<string, {keyPrefix: string, immutable: string[]}>, hosts: Map<string, {immutable: string[]}>} | {error: string}}
 */
export function servingFrom(env) {
  const named = publicationsFrom(env.PUBLICATIONS);
  if (named.error) return named;
  const any = anyPublicationHostsFrom(env.ANY_PUBLICATION_HOSTS);
  if (any.error) return any;
  if (any.hosts.size > 0) {
    for (const [name, p] of named.publications) {
      if (FILES_PREFIX.startsWith(p.keyPrefix)) {
        return configError(`PUBLICATIONS: the key prefix of "${name}" holds the files of every publication ANY_PUBLICATION_HOSTS serves`);
      }
    }
  }
  return { publications: named.publications, hosts: any.hosts };
}

/**
 * The publication a request names on a host, or null when that host serves no such
 * publication. On a host ANY_PUBLICATION_HOSTS names, every publication name is one, at
 * its default key prefix; elsewhere only the named publications are. Pure.
 *
 * @param {{publications: Map<string, {keyPrefix: string, immutable: string[]}>, hosts: Map<string, {immutable: string[]}>}} serving
 * @param {string} host
 * @param {string} name
 * @returns {{keyPrefix: string, immutable: string[]} | null}
 */
export function publicationFor(serving, host, name) {
  const any = serving.hosts.get(host);
  if (any) return publicationName(name) ? { keyPrefix: defaultKeyPrefix(name), immutable: any.immutable } : null;
  return serving.publications.get(name) ?? null;
}

/**
 * The publication and the path inside it that a request path names, or null when the
 * path after the publication breaks the path rules. The publication is the first
 * segment, unchecked: whether it is configured, and whether a consumer is allowed it,
 * is the caller's. Pure.
 *
 * @param {string} pathname A URL pathname, still percent-encoded.
 * @returns {{publication: string, path: string | null}}
 */
export function splitPath(pathname) {
  const m = /^\/([^/]*)(?:\/(.*))?$/.exec(pathname);
  const publication = m ? m[1] : "";
  const rest = m && m[2] !== undefined ? m[2] : "";
  return { publication, path: servablePath(rest) ? rest : null };
}

/**
 * Whether a path inside a publication follows the path rules. Pure.
 *
 * @param {string} path
 */
export function servablePath(path) {
  if (typeof path !== "string" || path === "" || path.length > MAX_PATH) return false;
  return path.split("/").every((segment) => PATH_SEGMENT.test(segment));
}

/**
 * The R2 key a publication's path is stored under. The one home of the key rule: the
 * Worker reads with it and the publish script writes with it. Pure.
 *
 * @param {{keyPrefix: string}} publication
 * @param {string} path A path for which servablePath holds.
 */
export function objectKey(publication, path) {
  return publication.keyPrefix + path;
}

/**
 * The content type a path is served with, from its extension. Pure.
 *
 * @param {string} path
 */
export function contentTypeFor(path) {
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * The Cache-Control a path is served with: immutable under one of the publication's
 * immutable prefixes, whose names carry their version, and revalidated otherwise. Pure.
 *
 * @param {{immutable: string[]}} publication
 * @param {string} path
 */
export function cacheControlFor(publication, path) {
  return publication.immutable.some((prefix) => path.startsWith(prefix)) ? IMMUTABLE : REVALIDATE;
}

/**
 * The user and password of a Basic Authorization header, or null when the header is
 * absent or is not a well-formed Basic credential. The password is everything after the
 * first colon, so a password may itself contain colons.
 *
 * @param {string | null} header
 * @returns {[string, string] | null}
 */
export function basicCredential(header) {
  if (!header) return null;
  const m = /^basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(header);
  if (!m) return null;
  let decoded;
  try {
    const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return [decoded.slice(0, colon), decoded.slice(colon + 1)];
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function hexBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// Equal-length digests compared without an early exit, so the time taken depends on
// neither value's content.
function sameDigest(x, y) {
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * The consumers the CONSUMERS secret declares, each with the digests of its username and
 * password, or `{error}` when they are not a valid configuration.
 *
 * @param {{CONSUMERS?: string}} env
 * @returns {Promise<{consumers: {name: string, user: Uint8Array, pass: Uint8Array, publications: string[]}[]} | {error: string}>}
 */
export async function consumersFrom(env) {
  const declared = [];
  if (env.CONSUMERS !== undefined && env.CONSUMERS !== "") {
    let list;
    try {
      list = JSON.parse(env.CONSUMERS);
    } catch {
      return configError("CONSUMERS is not JSON");
    }
    if (!Array.isArray(list)) return configError("CONSUMERS is not a list");
    for (const [i, c] of list.entries()) {
      const ok =
        c &&
        typeof c === "object" &&
        typeof c.name === "string" &&
        c.name !== "" &&
        typeof c.username === "string" &&
        c.username !== "" &&
        !c.username.includes(":") &&
        typeof c.passwordSha256 === "string" &&
        /^[0-9a-fA-F]{64}$/.test(c.passwordSha256) &&
        Array.isArray(c.publications) &&
        c.publications.every((p) => typeof p === "string");
      if (!ok) return configError(`CONSUMERS[${i}] is not {name, username, passwordSha256, publications}`);
      declared.push({
        name: c.name,
        username: c.username,
        pass: hexBytes(c.passwordSha256.toLowerCase()),
        publications: [...c.publications],
      });
    }
  }
  if (declared.length === 0) return configError("no consumer: set CONSUMERS");
  const seen = new Set();
  for (const c of declared) {
    if (seen.has(c.username)) return configError(`two consumers share the username of "${c.name}"`);
    seen.add(c.username);
  }
  const consumers = await Promise.all(
    declared.map(async (c) => ({ name: c.name, user: await sha256(c.username), pass: c.pass, publications: c.publications })),
  );
  return { consumers };
}

/**
 * The consumer whose credential the request carries, or null. Every consumer is
 * compared, on both halves, whatever matched before it, so the time taken depends on
 * neither which consumer matched nor which half was wrong.
 *
 * @param {Request} request
 * @param {{name: string, user: Uint8Array, pass: Uint8Array, publications: string[]}[]} consumers
 */
export async function consumerFor(request, consumers) {
  const cred = basicCredential(request.headers.get("Authorization"));
  if (!cred) return null;
  const [user, pass] = await Promise.all([sha256(cred[0]), sha256(cred[1])]);
  let found = null;
  for (const c of consumers) {
    const userOk = sameDigest(user, c.user);
    const passOk = sameDigest(pass, c.pass);
    if (userOk && passOk) found = c;
  }
  return found;
}

/**
 * Whether a consumer is allowed a publication: it lists the publication, or "*". Pure.
 *
 * @param {{publications: string[]}} consumer
 * @param {string} publication
 */
export function allows(consumer, publication) {
  return consumer.publications.includes(ALL_PUBLICATIONS) || consumer.publications.includes(publication);
}

function refusal(status, message, headers = {}) {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

// The one 404: a file that does not exist, and a publication the consumer is not allowed.
const notFound = () => refusal(404, "Not found.");

export default {
  /**
   * @param {Request} request
   * @param {{FILES?: R2Bucket, PUBLICATIONS?: unknown, ANY_PUBLICATION_HOSTS?: unknown, CONSUMERS?: string}} env
   */
  async fetch(request, env) {
    const config = env.FILES ? servingFrom(env) : configError("no FILES bucket binding");
    const people = config.error ? null : await consumersFrom(env);
    const problem = config.error ?? people.error;
    if (problem) {
      console.error(`not configured: ${problem}`);
      return refusal(500, "This service is not configured.");
    }
    const consumer = await consumerFor(request, people.consumers);
    if (!consumer) {
      return refusal(401, "Authentication required.", {
        "www-authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      });
    }
    const url = new URL(request.url);
    const { publication, path } = splitPath(url.pathname);
    if (!allows(consumer, publication)) {
      return notFound();
    }
    if (request.method !== "GET") {
      return refusal(405, "Only GET is served.", { allow: "GET" });
    }
    const target = publicationFor(config, url.hostname, publication);
    if (!target || path === null) {
      return notFound();
    }
    const object = await env.FILES.get(objectKey(target, path));
    if (!object) {
      return notFound();
    }
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": contentTypeFor(path),
        "cache-control": cacheControlFor(target, path),
        etag: object.httpEtag,
        "x-content-type-options": "nosniff",
      },
    });
  },
};
