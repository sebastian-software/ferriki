import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { digest, objectPath, payloadPath } from "./asset-store.mjs";
import { uploadImmutable } from "./bunny-storage.mjs";
import { cleanupBootstrap } from "./cleanup-bootstrap-assets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
let mode = "upload";
let baseAssetCatalogPath = null;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--check") {
    if (mode !== "upload")
      throw new Error(
        "Usage: node scripts/publish-assets.mjs [--check [--base-asset-catalog <path>]|--cleanup-bootstrap]",
      );
    mode = "check";
  } else if (arg === "--cleanup-bootstrap") {
    if (mode !== "upload")
      throw new Error(
        "Usage: node scripts/publish-assets.mjs [--check [--base-asset-catalog <path>]|--cleanup-bootstrap]",
      );
    mode = "cleanup-bootstrap";
  } else if (arg === "--base-asset-catalog" && args[index + 1]) {
    baseAssetCatalogPath = args[++index];
  } else {
    throw new Error(
      "Usage: node scripts/publish-assets.mjs [--check [--base-asset-catalog <path>]|--cleanup-bootstrap]",
    );
  }
}
if (baseAssetCatalogPath && mode !== "check")
  throw new Error("--base-asset-catalog requires --check");

const lock = JSON.parse(await readFile(path.join(root, "assets/catalog.json"), "utf8"));
const sources = JSON.parse(await readFile(path.join(root, "assets/grammars/sources.json"), "utf8"));
if (baseAssetCatalogPath) {
  const baseLock = JSON.parse(await readFile(baseAssetCatalogPath, "utf8"));
  if (lock.release?.storageLayout !== baseLock.release?.storageLayout)
    throw new Error(
      `Release storage layout drift against BASE_SHA: expected ${baseLock.release?.storageLayout}, got ${lock.release?.storageLayout}`,
    );
  if (JSON.stringify(lock.themes) !== JSON.stringify(baseLock.themes))
    throw new Error("Theme catalog drift against BASE_SHA: themes");
  if (JSON.stringify(lock.theme_sources) !== JSON.stringify(baseLock.theme_sources))
    throw new Error("Theme catalog drift against BASE_SHA: theme_sources");
  const themeAssetKeysOf = (catalogLock) =>
    Object.keys(catalogLock?.release?.assets ?? {})
      .filter((key) => key.startsWith("themes/"))
      .sort((a, b) => a.localeCompare(b, "en"));
  if (JSON.stringify(themeAssetKeysOf(lock)) !== JSON.stringify(themeAssetKeysOf(baseLock)))
    throw new Error("Theme release payload key drift against BASE_SHA");
}
const CANONICAL_SEGMENT = /^[a-z0-9][\w.-]*$/i;
const objects = new Map();

async function readConfinedRegularFile(baseRelative, segments) {
  const repoRoot = path.resolve(root);
  const allParts = [...baseRelative.split("/"), ...segments];
  let current = repoRoot;
  for (let index = 0; index < allParts.length; index++) {
    const segment = allParts[index];
    if (typeof segment !== "string" || !CANONICAL_SEGMENT.test(segment)) {
      throw new Error(`Invalid asset path segment under ${baseRelative}: ${segment}`);
    }
    current = path.resolve(current, segment);
    if (!current.startsWith(`${repoRoot}${path.sep}`)) {
      throw new Error(`Asset path escapes repository root: ${allParts.join("/")}`);
    }
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Symlinked asset path is not allowed: ${allParts.slice(0, index + 1).join("/")}`,
      );
    }
    if (index === allParts.length - 1 && !stat.isFile()) {
      throw new Error(`Expected regular asset file: ${allParts.join("/")}`);
    }
    if (index < allParts.length - 1 && !stat.isDirectory()) {
      throw new Error(`Expected asset directory: ${allParts.slice(0, index + 1).join("/")}`);
    }
  }
  return readFile(current);
}

const languageEntries = lock.languages?.entries;
const themeEntries = lock.themes?.entries;
const themeSources = lock.theme_sources;
if (
  !Array.isArray(languageEntries) ||
  !Array.isArray(themeEntries) ||
  !Array.isArray(themeSources)
)
  throw new Error(
    "assets/catalog.json must declare languages.entries, themes.entries, and theme_sources",
  );
const catalogLanguageIds = new Set(languageEntries.map((entry) => entry.id));
if (catalogLanguageIds.size !== languageEntries.length)
  throw new Error("Duplicate language ID in assets/catalog.json");
const sourceLanguageIds = new Set(sources.languages.map((entry) => entry.id));
if (sourceLanguageIds.size !== sources.languages.length)
  throw new Error("Duplicate language ID in assets/grammars/sources.json");
if (
  catalogLanguageIds.size !== sourceLanguageIds.size ||
  sources.languages.some((entry) => !catalogLanguageIds.has(entry.id))
)
  throw new Error(
    "Language catalog drift between assets/catalog.json and assets/grammars/sources.json",
  );
const catalogThemeIds = new Set(themeEntries.map((entry) => entry.id));
if (catalogThemeIds.size !== themeEntries.length)
  throw new Error("Duplicate theme ID in assets/catalog.json");
const sourceThemeIds = new Set(themeSources.map((entry) => entry.id));
if (
  sourceThemeIds.size !== themeSources.length ||
  sourceThemeIds.size !== catalogThemeIds.size ||
  themeEntries.some((entry) => !sourceThemeIds.has(entry.id))
)
  throw new Error("Theme catalog drift between themes.entries and theme_sources");
const sourceLanguagesById = new Map(sources.languages.map((entry) => [entry.id, entry]));
const RUNTIME_LANGUAGE_FIELDS = [
  "scope_name",
  "display_name",
  "aliases",
  "embedded_langs",
  "embedded_langs_lazy",
  "inject_to",
];
const expectedAssetKeys = new Set();
for (const entry of languageEntries) {
  const sourceEntry = sourceLanguagesById.get(entry.id);
  for (const field of RUNTIME_LANGUAGE_FIELDS) {
    if (JSON.stringify(entry[field]) !== JSON.stringify(sourceEntry[field]))
      throw new Error(`Language runtime metadata drift: ${entry.id}.${field}`);
  }
  if (entry.asset_file !== `${entry.id}.fkgram`)
    throw new Error(`Invalid language asset_file for ${entry.id}: ${entry.asset_file}`);
  const fkgramKey = `languages/${entry.asset_file}`;
  expectedAssetKeys.add(fkgramKey);
  if (!Object.hasOwn(lock.release.assets, fkgramKey))
    throw new Error(`Missing release payload in assets/catalog.json: ${fkgramKey}`);
  const fkbcKey = `languages/${entry.id}.fkbc`;
  expectedAssetKeys.add(fkbcKey);
  if (!Object.hasOwn(lock.release.assets, fkbcKey))
    throw new Error(`Missing release bytecode payload in assets/catalog.json: ${fkbcKey}`);
}
for (const entry of themeEntries) {
  if (entry.asset_file !== `${entry.id}.fktheme`)
    throw new Error(`Invalid theme asset_file for ${entry.id}: ${entry.asset_file}`);
  const themeKey = `themes/${entry.asset_file}`;
  expectedAssetKeys.add(themeKey);
  if (!Object.hasOwn(lock.release.assets, themeKey))
    throw new Error(`Missing theme payload in assets/catalog.json: ${themeKey}`);
}
for (const key of Object.keys(lock.release.assets)) {
  if (!expectedAssetKeys.has(key))
    throw new Error(`Unreferenced release payload in assets/catalog.json: ${key}`);
}

async function add(key, baseRelative, segments, hash, size) {
  const file = `${baseRelative}/${segments.join("/")}`;
  const bytes = await readConfinedRegularFile(baseRelative, segments);
  if (digest(bytes) !== hash || (size !== undefined && bytes.length !== size))
    throw new Error(`Local asset integrity mismatch: ${file}`);
  if (objects.has(key) && !objects.get(key).equals(bytes))
    throw new Error(`Object identity conflict: ${key}`);
  objects.set(key, bytes);
}
for (const [key, asset] of Object.entries(lock.release.assets)) {
  if (!/^(?:languages|themes)\/[a-z0-9][\w.-]*$/i.test(key))
    throw new Error(`Invalid release asset key: ${key}`);
  await add(
    payloadPath(key, asset, lock.release.storageLayout),
    "assets/standard",
    key.split("/"),
    asset.sha256,
    asset.size,
  );
}
for (const entry of sources.languages) {
  if (typeof entry.id !== "string" || !/^[a-z0-9-]+$/.test(entry.id))
    throw new Error(`Invalid language ID: ${entry.id}`);
  if (entry.grammar_file !== `${entry.id}.json`)
    throw new Error(`Invalid grammar file for ${entry.id}: ${entry.grammar_file}`);
  if (typeof entry.upstream_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.upstream_sha256))
    throw new Error(`Invalid upstream digest for ${entry.id}: ${entry.upstream_sha256}`);
  await add(
    objectPath("language", entry.id, entry.sha256),
    "assets/upstream/curated/grammars",
    [entry.grammar_file],
    entry.sha256,
  );
  await add(
    objectPath("language", entry.id, entry.upstream_sha256),
    "assets/grammar-raw",
    [entry.id, entry.upstream_sha256],
    entry.upstream_sha256,
  );
}
for (const entry of lock.theme_sources) {
  if (typeof entry.theme_file !== "string" || !CANONICAL_SEGMENT.test(entry.theme_file))
    throw new Error(`Invalid theme file for ${entry.id}: ${entry.theme_file}`);
  await add(
    objectPath("theme", entry.id, entry.sha256),
    "assets/upstream/curated/themes",
    [entry.theme_file],
    entry.sha256,
  );
}
if (mode === "check") {
  console.log(`Verified ${objects.size} immutable source/payload objects for publication.`);
} else if (mode === "cleanup-bootstrap") {
  if (lock.release.storageLayout !== "language-hash-v2")
    throw new Error("Cleanup requires the short-hash catalog");
  const result = await cleanupBootstrap({
    hostname: process.env.BUNNY_STORAGE_HOSTNAME,
    zone: process.env.BUNNY_STORAGE_ZONE,
    accessKey: process.env.BUNNY_STORAGE_ACCESS_KEY,
    objects,
  });
  console.log(
    `Removed ${result.removedObjects} verified migration objects; staging directory removed: ${result.removedStaging}.`,
  );
} else {
  const result = await uploadImmutable({
    hostname: process.env.BUNNY_STORAGE_HOSTNAME,
    zone: process.env.BUNNY_STORAGE_ZONE,
    accessKey: process.env.BUNNY_STORAGE_ACCESS_KEY,
    objects,
    onProgress: ({ uploaded, skipped, total }) => {
      if ((uploaded + skipped) % 50 === 0)
        console.log(`Bunny Storage: ${uploaded + skipped}/${total} verified.`);
    },
  });
  console.log(`Bunny Storage: ${result.uploaded} uploaded; ${result.skipped} unchanged.`);
}
