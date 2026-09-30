import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The package ships no grammar or theme payloads (ADR 0013): only the catalog
// projection, the two binary catalog manifests and the release manifest, which
// the native runtime needs to resolve, fetch and verify payloads. The release
// workflow stamps the release commit into the packaged release manifest.
const PACKAGED_FILES = [
  "catalog.mjs",
  "release-manifest.json",
  "languages/manifest.fkindex",
  "themes/manifest.fkindex",
];

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgDir, "..", "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = args.sourceDir ?? join(repoRoot, "assets", "shiki");
const destDir = args.destDir ?? join(pkgDir, "assets", "shiki");
// Tests and CI read payloads from this cache instead of the network:
// FERRIKI_CACHE_DIR points here and FERRIKI_ASSETS_REMOTE is 0.
const testCacheDir = args.testCacheDir ?? join(repoRoot, "node", ".cache", "ferriki-assets");

if (!(await existsDir(sourceDir))) {
  console.log(
    `[ferriki] No standard asset catalog found at ${sourceDir}; skipping package asset sync.`,
  );
  process.exit(0);
}

await rm(destDir, { recursive: true, force: true });
for (const file of PACKAGED_FILES) {
  await mkdir(dirname(join(destDir, file)), { recursive: true });
  await copyFile(join(sourceDir, file), join(destDir, file));
}
console.log(`[ferriki] Standard asset manifests synced: ${sourceDir} -> ${destDir}`);

// A release pins its payloads to the commit it was built from; without it the
// runtime cannot download (ADR 0013). Only the release workflow passes it.
if (args.releaseCommit) {
  if (!/^[0-9a-f]{40}$/.test(args.releaseCommit))
    throw new Error(`[ferriki] --release-commit must be a full commit SHA: ${args.releaseCommit}`);
  const packaged = join(destDir, "release-manifest.json");
  const { manifestVersion, assets } = JSON.parse(await readFile(packaged, "utf8"));
  await writeFile(
    packaged,
    `${JSON.stringify({ manifestVersion, commit: args.releaseCommit, assets }, null, 2)}\n`,
  );
  console.log(`[ferriki] Release manifest pinned to ${args.releaseCommit}`);
}

const release = JSON.parse(await readFile(join(sourceDir, "release-manifest.json"), "utf8"));
await mkdir(testCacheDir, { recursive: true });
let seeded = 0;
for (const [path, asset] of Object.entries(release.assets)) {
  const target = join(testCacheDir, asset.sha256);
  if (await existsFile(target)) continue;
  const bytes = await readFile(join(sourceDir, path));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256 || bytes.length !== asset.size)
    throw new Error(`[ferriki] ${path} does not match the release manifest; regenerate the assets`);
  await copyFile(join(sourceDir, path), `${target}.tmp`);
  await rename(`${target}.tmp`, target);
  seeded++;
}
console.log(`[ferriki] Test asset cache ready: ${testCacheDir} (${seeded} added)`);

function parseArgs(argv) {
  let sourceDir;
  let destDir;
  let testCacheDir;
  let releaseCommit;

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === "--source-dir") {
      sourceDir = resolve(value);
    } else if (flag === "--dest-dir") {
      destDir = resolve(value);
    } else if (flag === "--test-cache-dir") {
      testCacheDir = resolve(value);
    } else if (flag === "--release-commit") {
      releaseCommit = value;
    } else {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return { sourceDir, destDir, testCacheDir, releaseCommit };
}

async function existsDir(dir) {
  try {
    const info = await stat(dir);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function existsFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
