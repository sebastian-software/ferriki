import { cp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { digest, rawUrl } from "./grammar-repositories.mjs";
import { normalizeGrammar } from "./grammar-source.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const candidateRoot = process.argv[2] && path.resolve(process.argv[2]);
if (!candidateRoot || process.argv.length !== 3)
  throw new Error("Usage: node scripts/apply-grammar-update.mjs <candidate-directory>");
if (candidateRoot === root) throw new Error("A candidate must be outside the current catalog");
const sources = JSON.parse(
  await readFile(path.join(candidateRoot, "assets/grammars/sources.json"), "utf8"),
);
if (sources.version !== 2 || !sources.repositories)
  throw new Error("A candidate requires locked repository snapshots");
const old = JSON.parse(await readFile(path.join(root, "assets/grammars/sources.json"), "utf8"));
const paths = [
  "assets/grammars/sources.json",
  "assets/grammars/catalog.json",
  "assets/upstream/curated/languages.json",
];
// Validate the complete candidate before changing any current source file.
const catalog = JSON.parse(await readFile(path.join(candidateRoot, paths[1]), "utf8"));
const metadata = JSON.parse(await readFile(path.join(candidateRoot, paths[2]), "utf8"));
const fields = [
  "id",
  "grammar_file",
  "scope_name",
  "display_name",
  "aliases",
  "embedded_langs",
  "embedded_langs_lazy",
  "inject_to",
];
const languageIds = new Set(sources.languages.map((entry) => entry.id));
if (languageIds.size !== sources.languages.length)
  throw new Error("Duplicate candidate language IDs");
if (
  JSON.stringify(metadata.languages) !==
  JSON.stringify(
    sources.languages.map((entry) => Object.fromEntries(fields.map((key) => [key, entry[key]]))),
  )
)
  throw new Error("Candidate language catalog drift");
if (
  catalog.languages.length !== languageIds.size ||
  new Set(catalog.languages.map((entry) => entry.id)).size !== languageIds.size ||
  catalog.languages.some((entry) => !languageIds.has(entry.id))
)
  throw new Error("Candidate selection drift");
const languageKeys = new Set();
const licenses = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "MPL-2.0",
  "LicenseRef-TextMate-Bundle",
]);
for (const entry of sources.languages) {
  if (
    !licenses.has(entry.license) ||
    !entry.license_url ||
    !/^[a-f0-9]{64}$/.test(entry.upstream_sha256)
  )
    throw new Error(`Incomplete candidate provenance: ${entry.id}`);
  if (!/^[a-z0-9-]+$/.test(entry.id) || entry.grammar_file !== `${entry.id}.json`)
    throw new Error(`Invalid grammar file: ${entry.id}`);
  const repository = sources.repositories[entry.repository_id];
  const pin = entry.module ? repository?.modules?.[entry.module] : repository;
  if (
    !pin ||
    pin.repository !== entry.upstream_repository ||
    pin.commit !== entry.upstream_commit ||
    entry.source !== rawUrl(pin.repository, pin.commit, entry.upstream_path)
  )
    throw new Error(`Candidate repository pin drift: ${entry.id}`);
  const file = `assets/upstream/curated/grammars/${entry.grammar_file}`;
  const bytes = await readFile(path.join(candidateRoot, file));
  if (digest(bytes) !== entry.sha256) throw new Error(`Candidate grammar drift: ${entry.id}`);
  const grammar = JSON.parse(bytes);
  if (JSON.stringify(normalizeGrammar(grammar, entry)) !== JSON.stringify(grammar))
    throw new Error(`Candidate metadata drift: ${entry.id}`);
  const selection = catalog.languages.find((item) => item.id === entry.id);
  if (fields.some((key) => JSON.stringify(selection[key]) !== JSON.stringify(entry[key])))
    throw new Error(`Candidate selection metadata drift: ${entry.id}`);
  for (const key of [entry.id, ...entry.aliases]) {
    if (languageKeys.has(key)) throw new Error(`Duplicate candidate language key: ${key}`);
    languageKeys.add(key);
  }
  for (const dependency of [...entry.embedded_langs, ...entry.embedded_langs_lazy])
    if (!languageIds.has(dependency))
      throw new Error(`Candidate dependency missing: ${entry.id}/${dependency}`);
  if (!/^assets\/grammars\/licenses\/[a-f0-9]{64}\.txt$/.test(entry.license_file))
    throw new Error(`Invalid license file: ${entry.id}`);
  if (
    !entry.license_file.endsWith(
      `${digest(await readFile(path.join(candidateRoot, entry.license_file)))}.txt`,
    )
  )
    throw new Error(`Candidate license drift: ${entry.id}`);
  paths.push(file, entry.license_file);
}
await cp(path.join(candidateRoot, "assets/grammar-raw"), path.join(root, "assets/grammar-raw"), {
  recursive: true,
});
for (const file of new Set(paths)) await cp(path.join(candidateRoot, file), path.join(root, file));
const ids = new Set(sources.languages.map((entry) => entry.id));
const activeLicenses = new Set(sources.languages.map((entry) => entry.license_file));
for (const entry of old.languages)
  if (
    /^assets\/grammars\/licenses\/[a-f0-9]{64}\.txt$/.test(entry.license_file) &&
    !activeLicenses.has(entry.license_file)
  )
    await rm(path.join(root, entry.license_file), { force: true });
for (const entry of old.languages)
  if (!ids.has(entry.id)) {
    await rm(path.join(root, "assets/upstream/curated/grammars", entry.grammar_file));
    await rm(path.join(root, "assets/standard/languages", `${entry.id}.fkgram`), { force: true });
    await rm(path.join(root, "assets/standard/languages", `${entry.id}.fkbc`), { force: true });
  }
// Rebuild local artifacts and update the small reviewed catalog lock.
execFileSync(process.execPath, ["scripts/generate-ferriki-assets.mjs"], {
  cwd: root,
  stdio: "inherit",
});
execFileSync(process.execPath, ["scripts/write-asset-lock.mjs"], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, ["scripts/sync-grammars.mjs", "--check-sources"], {
  cwd: root,
  stdio: "inherit",
});
console.log(
  `Applied ${sources.languages.length} grammars. Run build:native and the compatibility gate before merging.`,
);
