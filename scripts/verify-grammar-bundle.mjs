import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUIRED_FILES = [
  "assets/grammars/sources.json",
  "assets/grammars/catalog.json",
  "assets/catalog.json",
  "assets/standard/GRAMMAR-NOTICES.md",
  "report.json",
];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function collectBundleFiles(bundleRoot, label) {
  const rootPath = path.resolve(bundleRoot);
  const rootStat = await lstat(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${label} bundle root must be a non-symlink directory: ${bundleRoot}`);
  }
  const files = new Map();
  async function walk(currentDir, relativeDir) {
    const entries = (await readdir(currentDir)).sort((a, b) => a.localeCompare(b, "en"));
    for (const name of entries) {
      const fullPath = path.resolve(currentDir, name);
      if (!fullPath.startsWith(`${rootPath}${path.sep}`)) {
        throw new Error(`${label} bundle path escapes root: ${name}`);
      }
      const relPath = relativeDir ? `${relativeDir}/${name}` : name;
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`${label} bundle must not contain symlinks: ${relPath}`);
      }
      if (stat.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (stat.isFile()) {
        files.set(relPath, digest(await readFile(fullPath)));
      } else {
        throw new Error(`${label} bundle must contain only regular files: ${relPath}`);
      }
    }
  }
  await walk(rootPath, "");
  return files;
}

export async function verifyGrammarBundles(rebuiltDir, candidateDir) {
  const rebuilt = await collectBundleFiles(rebuiltDir, "rebuilt");
  const candidate = await collectBundleFiles(candidateDir, "prepare");

  for (const required of REQUIRED_FILES) {
    if (!rebuilt.has(required)) {
      throw new Error(`Rebuilt publish bundle is missing required file: ${required}`);
    }
  }
  const rebuiltKeys = [...rebuilt.keys()];
  if (!rebuiltKeys.some((key) => /^assets\/standard\/languages\/[^/]+\.fkgram$/.test(key))) {
    throw new Error("Rebuilt publish bundle contains no compiled .fkgram assets");
  }
  if (!rebuiltKeys.some((key) => /^assets\/standard\/languages\/[^/]+\.fkbc$/.test(key))) {
    throw new Error("Rebuilt publish bundle contains no compiled .fkbc assets");
  }

  for (const [relPath, expectedHash] of rebuilt) {
    if (!candidate.has(relPath)) {
      throw new Error(`Missing file in prepare publish bundle: ${relPath}`);
    }
    const actualHash = candidate.get(relPath);
    if (actualHash !== expectedHash) {
      throw new Error(
        `Publish bundle digest mismatch for ${relPath}: rebuilt ${expectedHash}, prepare ${actualHash}`,
      );
    }
  }
  for (const relPath of candidate.keys()) {
    if (!rebuilt.has(relPath)) {
      throw new Error(`Unexpected file in prepare publish bundle: ${relPath}`);
    }
  }
  return rebuilt.size;
}

async function main() {
  const [rebuiltDir, candidateDir] = process.argv.slice(2);
  if (!rebuiltDir || !candidateDir || process.argv.length !== 4) {
    throw new Error(
      "Usage: node scripts/verify-grammar-bundle.mjs <rebuilt-bundle-dir> <prepare-bundle-dir>",
    );
  }
  const count = await verifyGrammarBundles(rebuiltDir, candidateDir);
  console.log(`Verified ${count} files in grammar publish bundle match the isolated rebuild.`);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
