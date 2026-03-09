import { mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SHIKI_ROOT = path.resolve('node/compat/upstream/shiki');
const DEFAULT_OUTPUT_DIR = path.resolve('assets/upstream/textmate-grammars-themes');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await syncTextmateGrammarsThemes(opts);
}

function parseArgs(args) {
  let textmateRepo;
  let shikiRoot = DEFAULT_SHIKI_ROOT;
  let outputDir = DEFAULT_OUTPUT_DIR;

  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === '--textmate-repo') {
      textmateRepo = path.resolve(value);
    } else if (flag === '--shiki-root') {
      shikiRoot = path.resolve(value);
    } else if (flag === '--output-dir') {
      outputDir = path.resolve(value);
    } else {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (!textmateRepo) {
    throw new Error('Usage: node scripts/sync-textmate-grammars-themes.mjs --textmate-repo <path> [--shiki-root <path>] [--output-dir <path>]');
  }

  return { textmateRepo, shikiRoot, outputDir };
}

async function syncTextmateGrammarsThemes({ textmateRepo, shikiRoot, outputDir }) {
  const grammarSourceDir = path.join(textmateRepo, 'packages/tm-grammars/grammars');
  const themeSourceDir = path.join(textmateRepo, 'packages/tm-themes/themes');
  const shikiLangDistDir = path.join(shikiRoot, 'packages/langs/dist');

  await assertDir(grammarSourceDir, 'textmate grammar source');
  await assertDir(themeSourceDir, 'textmate theme source');
  await assertDir(shikiLangDistDir, 'Shiki language metadata source');

  const grammarFiles = await listJsonFiles(grammarSourceDir);
  const themeFiles = await listJsonFiles(themeSourceDir);
  const grammarsByName = await indexGrammarFilesByName(grammarSourceDir, grammarFiles);
  const languageMetadata = await loadShikiLanguageMetadata(shikiLangDistDir);

  const outputGrammarDir = path.join(outputDir, 'grammars');
  const outputThemeDir = path.join(outputDir, 'themes');
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputGrammarDir, { recursive: true });
  await mkdir(outputThemeDir, { recursive: true });

  for (const file of grammarFiles) {
    await copyFile(path.join(grammarSourceDir, file), path.join(outputGrammarDir, file));
  }
  for (const file of themeFiles) {
    await copyFile(path.join(themeSourceDir, file), path.join(outputThemeDir, file));
  }

  const languages = languageMetadata.map((entry) => {
    const id = entry.name;
    const grammarFile = grammarsByName.get(id) || `${id}.json`;
    return {
      id,
      grammar_file: grammarFile,
      scope_name: entry.scopeName,
      display_name: entry.displayName ?? null,
      aliases: entry.aliases ?? [],
      embedded_langs: entry.embeddedLangs ?? [],
      embedded_langs_lazy: entry.embeddedLangsLazy ?? [],
      inject_to: entry.injectTo ?? []
    };
  });

  const themes = [];
  for (const file of themeFiles.sort()) {
    const raw = JSON.parse(await readFile(path.join(themeSourceDir, file), 'utf8'));
    themes.push({
      id: path.basename(file, '.json'),
      theme_file: file,
      display_name: typeof raw.name === 'string' ? raw.name : null,
      theme_type: typeof raw.type === 'string' ? raw.type : null
    });
  }

  await writeFile(
    path.join(outputDir, 'languages.json'),
    `${JSON.stringify({ languages }, null, 2)}\n`,
    'utf8'
  );
  await writeFile(
    path.join(outputDir, 'themes.json'),
    `${JSON.stringify({ themes }, null, 2)}\n`,
    'utf8'
  );
  await writeFile(
    path.join(outputDir, '.source.json'),
    `${JSON.stringify({
      textmateRepo,
      shikiRoot
    }, null, 2)}\n`,
    'utf8'
  );
}

async function assertDir(dir, label) {
  let info;
  try {
    info = await stat(dir);
  } catch (error) {
    throw new Error(`Missing ${label}: ${dir}\n${String(error)}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Expected ${label} to be a directory: ${dir}`);
  }
}

async function listJsonFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

async function indexGrammarFilesByName(grammarDir, files) {
  const byName = new Map();
  for (const file of files) {
    const raw = JSON.parse(await readFile(path.join(grammarDir, file), 'utf8'));
    if (typeof raw.name === 'string') {
      byName.set(raw.name, file);
    }
  }
  return byName;
}

async function loadShikiLanguageMetadata(distDir) {
  const files = await readdir(distDir, { withFileTypes: true });
  const records = [];

  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.mjs')) {
      continue;
    }
    const absPath = path.join(distDir, file.name);
    const source = await readFile(absPath, 'utf8');
    const match = source.match(/JSON\.parse\((['"])([\s\S]*?)\1\)/);
    if (!match) {
      continue;
    }
    const parsed = JSON.parse(JSON.parse(`${match[1]}${match[2]}${match[1]}`));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string' || typeof parsed.scopeName !== 'string') {
      continue;
    }
    if (parsed.name !== path.basename(file.name, '.mjs')) {
      continue;
    }
    records.push(parsed);
  }

  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
