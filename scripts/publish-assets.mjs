import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { digest, objectPath, payloadPath } from "./asset-store.mjs";
import { uploadImmutable } from "./bunny-storage.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(path.join(root, "assets/catalog.json"), "utf8"));
const sources = JSON.parse(await readFile(path.join(root, "assets/grammars/sources.json"), "utf8"));
const objects = new Map();
async function add(key, file, hash, size) {
  const bytes = await readFile(path.join(root, file));
  if (digest(bytes) !== hash || (size !== undefined && bytes.length !== size))
    throw new Error(`Local asset integrity mismatch: ${file}`);
  if (objects.has(key) && !objects.get(key).equals(bytes))
    throw new Error(`Object identity conflict: ${key}`);
  objects.set(key, bytes);
}
for (const [key, asset] of Object.entries(lock.release.assets))
  await add(payloadPath(key, asset), `assets/standard/${key}`, asset.sha256, asset.size);
for (const entry of sources.languages) {
  await add(
    objectPath("language", entry.id, entry.sha256),
    `assets/upstream/curated/grammars/${entry.grammar_file}`,
    entry.sha256,
  );
  await add(
    objectPath("language", entry.id, entry.upstream_sha256),
    `assets/grammar-raw/${entry.id}/${entry.upstream_sha256}`,
    entry.upstream_sha256,
  );
}
for (const entry of lock.theme_sources)
  await add(
    objectPath("theme", entry.id, entry.sha256),
    `assets/upstream/curated/themes/${entry.theme_file}`,
    entry.sha256,
  );
if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== "--check"))
  throw new Error("Usage: node scripts/publish-assets.mjs [--check]");
if (process.argv[2] === "--check") {
  console.log(`Verified ${objects.size} immutable source/payload objects for publication.`);
} else {
  if (process.argv.length !== 2)
    throw new Error("Usage: node scripts/publish-assets.mjs [--check]");
  const result = await uploadImmutable({
    hostname: process.env.BUNNY_STORAGE_HOSTNAME,
    zone: process.env.BUNNY_STORAGE_ZONE,
    accessKey: process.env.BUNNY_STORAGE_ACCESS_KEY,
    objects,
  });
  console.log(`Bunny Storage: ${result.uploaded} uploaded; ${result.skipped} unchanged.`);
}
