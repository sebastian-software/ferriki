import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_CDN, digest, fetchBytes, objectPath, payloadPath } from "./asset-store.mjs";

const root = new URL("../", import.meta.url);
const lock = JSON.parse(await readFile(new URL("assets/catalog.json", root), "utf8"));
const sources = JSON.parse(await readFile(new URL("assets/grammars/sources.json", root), "utf8"));
const expected = new Map();
for (const [key, asset] of Object.entries(lock.release.assets))
  expected.set(payloadPath(key, asset, lock.release.storageLayout), asset);
for (const entry of sources.languages) {
  expected.set(objectPath("language", entry.id, entry.sha256), { sha256: entry.sha256 });
  expected.set(objectPath("language", entry.id, entry.upstream_sha256), {
    sha256: entry.upstream_sha256,
  });
}
for (const entry of lock.theme_sources)
  expected.set(objectPath("theme", entry.id, entry.sha256), { sha256: entry.sha256 });
const base = (process.env.FERRIKI_ASSETS_BASE_URL || DEFAULT_CDN).replace(/\/$/, "");
const entries = [...expected];
let cursor = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (cursor < entries.length) {
      const [key, asset] = entries[cursor++];
      const bytes = await fetchBytes(`${base}/${key}`, { limit: asset.size ?? 8 * 1024 * 1024 });
      if (
        digest(bytes) !== asset.sha256 ||
        (asset.size !== undefined && bytes.length !== asset.size)
      )
        throw new Error(`CDN integrity mismatch: ${key}`);
    }
  }),
);
console.log(
  `Verified ${expected.size} public immutable objects from ${base} (${fileURLToPath(new URL("assets/catalog.json", root))}).`,
);
