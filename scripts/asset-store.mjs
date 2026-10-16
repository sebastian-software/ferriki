import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_CDN = "https://assets.ferriki.dev";
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export { objectPath, payloadPath, shortHash } from "../node/ferriki/scripts/asset-path.mjs";

export async function verifiedRead(file, hash, size) {
  try {
    const bytes = await readFile(file);
    return digest(bytes) === hash && (size === undefined || bytes.length === size) ? bytes : null;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

const transientDownloadCodes = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

// Maintainer GETs can safely restart after a reset or a temporary CDN failure.
// Keep retries bounded and never retry certificate, integrity, or size errors.
export async function fetchBytes(url, options = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchBytesOnce(url, options);
    } catch (error) {
      const retryable =
        [502, 503, 504].includes(error.status) ||
        transientDownloadCodes.has(error.cause?.code ?? error.code) ||
        error.name === "TimeoutError";
      if (attempt === 2 || !retryable) throw error;
      await delay(250 * 2 ** attempt);
    }
  }
}

async function fetchBytesOnce(
  url,
  { missing = false, limit = 8 * 1024 * 1024, fetchImpl = fetch } = {},
) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000), redirect: "error" });
  if (missing && response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(`Asset request failed: HTTP ${response.status}`), {
      status: response.status,
    });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) {
      await response.body.cancel().catch(() => {});
      throw new Error("Asset exceeds its size limit");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function writeVerified(file, bytes, hash, size) {
  if (digest(bytes) !== hash || (size !== undefined && bytes.length !== size))
    throw new Error(`Asset integrity mismatch: ${path.basename(file)}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

// The two tiny catalog indexes use the existing postcard v3 wire layout.
// Rust's build script encodes the same reviewed lock through ferriki-asset-gen.
export function encodeCatalog(catalog, kind) {
  const chunks = [];
  function integer(value) {
    do {
      const byte = value % 128;
      value = Math.floor(value / 128);
      chunks.push(Buffer.from([byte | (value ? 128 : 0)]));
    } while (value);
  }
  function string(value) {
    const bytes = Buffer.from(value);
    integer(bytes.length);
    chunks.push(bytes);
  }
  function optional(value) {
    chunks.push(Buffer.from([value === null ? 0 : 1]));
    if (value !== null) string(value);
  }
  function strings(values) {
    integer(values.length);
    for (const value of values) string(value);
  }
  integer(catalog.format_version);
  string(catalog.source.upstream);
  optional(catalog.source.version);
  optional(catalog.source.commit);
  integer(catalog.entries.length);
  for (const entry of catalog.entries) {
    string(entry.id);
    if (kind === "language") string(entry.scope_name);
    string(entry.asset_file);
    optional(entry.display_name);
    if (kind === "language") {
      strings(entry.aliases);
      strings(entry.embedded_langs);
      strings(entry.embedded_langs_lazy);
      strings(entry.inject_to);
    } else optional(entry.theme_type);
  }
  return Buffer.concat(chunks);
}

export async function writeMetadata(root, lock) {
  if (
    lock.version !== 1 ||
    !["language-hash-v1", "language-hash-v2"].includes(lock.release.storageLayout)
  )
    throw new Error("Unsupported asset catalog lock");
  const output = path.join(root, "assets/standard");
  for (const [kind, catalog] of [
    ["language", lock.languages],
    ["theme", lock.themes],
  ]) {
    const folder = kind === "language" ? "languages" : "themes";
    await mkdir(path.join(output, folder), { recursive: true });
    await writeFile(path.join(output, folder, "manifest.fkindex"), encodeCatalog(catalog, kind));
  }
  const camel = (row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
        value,
      ]),
    );
  await writeFile(
    path.join(output, "release-manifest.json"),
    JSON.stringify(lock.release, null, 2) + "\n",
  );
  await writeFile(
    path.join(output, "catalog.mjs"),
    [
      "// Generated from assets/catalog.json; do not edit.",
      "export const ferrikiCatalogVersion = 1",
      `export const languageCatalog = Object.freeze(${JSON.stringify(lock.languages.entries.map(camel), null, 2)})`,
      `export const themeCatalog = Object.freeze(${JSON.stringify(lock.themes.entries.map(camel), null, 2)})`,
      "",
    ].join("\n"),
  );
}
