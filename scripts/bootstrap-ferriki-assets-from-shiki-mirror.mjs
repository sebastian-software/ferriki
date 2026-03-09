import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_SHIKI_ROOT = path.resolve('node/compat/upstream/shiki');
const DEFAULT_UPSTREAM_DIR = path.resolve('assets/upstream/textmate-grammars-themes');
const DEFAULT_OUTPUT_DIR = path.resolve('assets/shiki');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await bootstrapFromShikiMirror(opts);
}

function parseArgs(args) {
  let shikiRoot = DEFAULT_SHIKI_ROOT;
  let upstreamDir = DEFAULT_UPSTREAM_DIR;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let sourceVersion = 'bootstrap';
  let sourceCommit = 'shiki-mirror';

  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === '--shiki-root') {
      shikiRoot = path.resolve(value);
    } else if (flag === '--upstream-dir') {
      upstreamDir = path.resolve(value);
    } else if (flag === '--output-dir') {
      outputDir = path.resolve(value);
    } else if (flag === '--source-version') {
      sourceVersion = value;
    } else if (flag === '--source-commit') {
      sourceCommit = value;
    } else {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return { shikiRoot, upstreamDir, outputDir, sourceVersion, sourceCommit };
}

async function bootstrapFromShikiMirror({ shikiRoot, upstreamDir, outputDir, sourceVersion, sourceCommit }) {
  const langDistDir = path.join(shikiRoot, 'packages/langs/dist');
  const themeDistDir = path.join(shikiRoot, 'packages/themes/dist');

  const languages = await readCanonicalLangEntries(langDistDir);
  const themes = await readCanonicalThemeEntries(themeDistDir);

  await rm(upstreamDir, { recursive: true, force: true });
  await mkdir(path.join(upstreamDir, 'grammars'), { recursive: true });
  await mkdir(path.join(upstreamDir, 'themes'), { recursive: true });

  const languageCatalog = [];
  for (const entry of languages) {
    const grammarFile = `${entry.id}.json`;
    await writeFile(
      path.join(upstreamDir, 'grammars', grammarFile),
      `${JSON.stringify(entry.raw, null, 2)}\n`,
      'utf8'
    );
    languageCatalog.push({
      id: entry.id,
      grammar_file: grammarFile,
      scope_name: entry.raw.scopeName,
      display_name: entry.raw.displayName ?? null,
      aliases: Array.isArray(entry.raw.aliases) ? entry.raw.aliases : [],
      embedded_langs: Array.isArray(entry.raw.embeddedLangs) ? entry.raw.embeddedLangs : [],
      embedded_langs_lazy: Array.isArray(entry.raw.embeddedLangsLazy) ? entry.raw.embeddedLangsLazy : [],
      inject_to: Array.isArray(entry.raw.injectTo) ? entry.raw.injectTo : []
    });
  }

  const themeCatalog = [];
  for (const entry of themes) {
    const themeFile = `${entry.id}.json`;
    await writeFile(
      path.join(upstreamDir, 'themes', themeFile),
      `${JSON.stringify(entry.raw, null, 2)}\n`,
      'utf8'
    );
    themeCatalog.push({
      id: entry.id,
      theme_file: themeFile,
      display_name: typeof entry.raw.name === 'string' ? entry.raw.name : null,
      theme_type: typeof entry.raw.type === 'string' ? entry.raw.type : null
    });
  }

  await writeFile(
    path.join(upstreamDir, 'languages.json'),
    `${JSON.stringify({ languages: languageCatalog }, null, 2)}\n`,
    'utf8'
  );
  await writeFile(
    path.join(upstreamDir, 'themes.json'),
    `${JSON.stringify({ themes: themeCatalog }, null, 2)}\n`,
    'utf8'
  );
  await writeFile(
    path.join(upstreamDir, '.source.json'),
    `${JSON.stringify({
      source: 'shiki-mirror-bootstrap',
      shikiRoot,
      sourceVersion,
      sourceCommit
    }, null, 2)}\n`,
    'utf8'
  );

  const result = spawnSync(
    'node',
    [
      './scripts/generate-ferriki-assets.mjs',
      '--upstream-dir',
      upstreamDir,
      '--output-dir',
      outputDir,
      '--source-version',
      sourceVersion,
      '--source-commit',
      sourceCommit
    ],
    {
      cwd: path.resolve('.'),
      stdio: 'inherit'
    }
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function readCanonicalLangEntries(dir) {
  const files = await readdir(dir);
  const entries = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.mjs') || file === 'index.mjs') {
      continue;
    }
    const raw = await readFrozenJson(path.join(dir, file));
    if (!raw || typeof raw.name !== 'string' || typeof raw.scopeName !== 'string') {
      continue;
    }
    if (`${raw.name}.mjs` !== file) {
      continue;
    }
    entries.push({ id: raw.name, raw });
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

async function readCanonicalThemeEntries(dir) {
  const files = await readdir(dir);
  const entries = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.mjs') || file === 'index.mjs') {
      continue;
    }
    const raw = await readFrozenJson(path.join(dir, file));
    const id = path.basename(file, '.mjs');
    if (!raw || typeof raw.name !== 'string') {
      continue;
    }
    entries.push({ id, raw });
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

async function readFrozenJson(file) {
  const source = await readFile(file, 'utf8');
  const marker = 'JSON.parse(';
  const start = source.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const quote = source[start + marker.length];
  if (quote !== '"' && quote !== '\'') {
    return null;
  }
  let index = start + marker.length + 1;
  let escaped = false;
  let literal = '';
  while (index < source.length) {
    const ch = source[index];
    if (escaped) {
      literal += ch;
      escaped = false;
    } else if (ch === '\\') {
      literal += ch;
      escaped = true;
    } else if (ch === quote) {
      return JSON.parse(JSON.parse(`${quote}${literal}${quote}`));
    } else {
      literal += ch;
    }
    index += 1;
  }
  throw new Error(`Failed to parse embedded JSON string in ${file}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
