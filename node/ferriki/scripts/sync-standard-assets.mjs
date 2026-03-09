import { cp, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pkgDir, '..', '..');
const args = parseArgs(process.argv.slice(2));
const sourceDir = args.sourceDir ?? join(repoRoot, 'assets', 'shiki');
const destDir = args.destDir ?? join(pkgDir, 'assets', 'shiki');

if (!(await existsDir(sourceDir))) {
  console.log(`[ferriki] No standard asset catalog found at ${sourceDir}; skipping package asset sync.`);
  process.exit(0);
}

await rm(destDir, { recursive: true, force: true });
await cp(sourceDir, destDir, { recursive: true });
console.log(`[ferriki] Standard assets synced: ${sourceDir} -> ${destDir}`);

function parseArgs(argv) {
  let sourceDir;
  let destDir;

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === '--source-dir') {
      sourceDir = resolve(value);
    } else if (flag === '--dest-dir') {
      destDir = resolve(value);
    } else {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return { sourceDir, destDir };
}

async function existsDir(dir) {
  try {
    const info = await stat(dir);
    return info.isDirectory();
  } catch {
    return false;
  }
}
