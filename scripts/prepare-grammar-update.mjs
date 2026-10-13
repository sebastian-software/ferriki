import { mkdir, mkdtemp, readFile, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyGrammarPatches, normalizeGrammar, parseGrammarSource } from "./grammar-source.mjs";
import {
  createGitHubReader,
  digest,
  discoverRepository,
  grammarChanges,
  rawUrl,
  resolveRepositorySnapshots,
  selectCandidate,
} from "./grammar-repositories.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const usage =
  "Usage: node scripts/prepare-grammar-update.mjs [--locked] [--output-dir <new-directory>]";
let outputRoot;
let created = false;
async function prepare() {
  const args = process.argv.slice(2);
  let locked = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--locked") locked = true;
    else if (args[index] === "--output-dir" && args[index + 1])
      outputRoot = path.resolve(args[++index]);
    else throw new Error(usage);
  }
  if (outputRoot) await mkdir(outputRoot); // Refuse an existing destination.
  else outputRoot = await mkdtemp(path.join(tmpdir(), "ferriki-grammar-update-"));
  created = true;
  const config = JSON.parse(
    await readFile(path.join(root, "assets/grammars/repositories.json"), "utf8"),
  );
  const catalogue = JSON.parse(
    await readFile(path.join(root, "assets/grammars/catalog.json"), "utf8"),
  );
  const previous = JSON.parse(
    await readFile(path.join(root, "assets/grammars/sources.json"), "utf8"),
  );
  if (locked && !previous.repositories)
    throw new Error("No repository snapshots are locked yet. Prepare the initial update first.");
  const reader = createGitHubReader();
  const snapshots = await resolveRepositorySnapshots(
    config,
    reader,
    locked ? previous.repositories : undefined,
  );
  const inventories = new Map();
  for (const repository of config.repositories) {
    const candidates = await discoverRepository(repository, snapshots[repository.id], reader);
    inventories.set(repository.id, candidates);
    console.log(
      `${repository.id}: ${candidates.length} TextMate grammar candidates at ${snapshots[repository.id].commit}`,
    );
  }

  const selections = catalogue.languages.map((entry) => ({ ...entry }));
  const allCandidates = [...inventories].flatMap(([repository_id, entries]) =>
    entries.map((entry) => ({ ...entry, repository_id })),
  );
  const languages = [];
  const grammarFiles = new Map();
  const retiredPatches = [];
  const externalScopes = [];
  for (let index = 0; index < selections.length; index++) {
    const selection = selections[index];
    const candidate = selectCandidate(inventories.get(selection.repository_id), selection.selector);
    const bytes = await reader.read(candidate.repository, candidate.commit, candidate.path);
    let grammar = parseGrammarSource(bytes.toString("utf8"), candidate.path);
    const rawFile = path.join(outputRoot, "assets/grammar-raw", selection.id, digest(bytes));
    await mkdir(path.dirname(rawFile), { recursive: true });
    await writeFile(rawFile, bytes);
    const originalScope = grammar.scopeName;
    if (selection.patch_file) {
      const patches = JSON.parse(await readFile(path.join(root, selection.patch_file), "utf8"));
      const active = patches.filter((patch) => {
        const keys = patch.path
          .split("/")
          .slice(1)
          .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
        let current = grammar;
        for (const key of keys) current = current?.[key];
        if (JSON.stringify(current) === JSON.stringify(patch.after)) {
          retiredPatches.push({ language: selection.id, path: patch.path });
          return false;
        }
        return true;
      });
      grammar = applyGrammarPatches(grammar, active);
      if (active.length === 0) delete selection.patch_file;
    }
    // Scope variants retain their public ID while includes refer to the same
    // normalized root. Pattern expressions and capture scopes stay untouched.
    function rebase(value) {
      if (Array.isArray(value)) return value.map(rebase);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          key === "include" &&
          typeof item === "string" &&
          (item === originalScope || item.startsWith(`${originalScope}#`))
            ? selection.scope_name + item.slice(originalScope.length)
            : rebase(item),
        ]),
      );
    }
    grammar = rebase(grammar);
    const includes = new Set();
    function scan(value) {
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if (key === "include" && typeof item === "string" && !/^[#$]/.test(item))
          includes.add(item.split("#")[0]);
        else scan(item);
      }
    }
    scan(grammar);
    const dependencies = new Set(selection.embedded_langs);
    for (const scope of includes) {
      if (scope === selection.scope_name || selection.external_embedded_scopes?.includes(scope))
        continue;
      const existing = selections.find((entry) => entry.scope_name === scope);
      if (existing) {
        function requires(id, target, visiting = new Set()) {
          if (id === target) return true;
          if (visiting.has(id)) return false;
          visiting.add(id);
          return (
            selections
              .find((entry) => entry.id === id)
              ?.embedded_langs.some((child) => requires(child, target, visiting)) || false
          );
        }
        // An injected child can include its host without making the host an
        // eager child dependency. Keep registration order and avoid back-edges.
        if (
          existing.id !== selection.id &&
          !config.lazy_grammars.includes(selection.id) &&
          !requires(existing.id, selection.id)
        )
          dependencies.add(existing.id);
        continue;
      }
      if (config.lazy_grammars.includes(selection.id)) continue;
      const matches = allCandidates.filter((entry) => entry.scope === scope);
      const dependency =
        matches.find(
          (entry) =>
            entry.repository_id === selection.repository_id && entry.module === candidate.module,
        ) ||
        matches.find((entry) => entry.repository_id === "vscode") ||
        (matches.length === 1 ? matches[0] : undefined);
      if (!dependency) {
        externalScopes.push({ language: selection.id, scope });
        continue;
      }
      const id = scope
        .replace(/^(source|text)\./, "")
        .replace(/[^a-z0-9-]+/gi, "-")
        .toLowerCase();
      if (selections.some((entry) => entry.id === id))
        throw new Error(`Dependency ID collision: ${id}`);
      selections.push({
        id,
        grammar_file: `${id}.json`,
        scope_name: scope,
        display_name: null,
        aliases: [],
        embedded_langs: [],
        embedded_langs_lazy: [],
        inject_to: dependency.inject_to || [],
        role: "dependency",
        repository_id: dependency.repository_id,
        selector: {
          ...(dependency.module ? { module: dependency.module } : {}),
          path: dependency.path,
        },
      });
      dependencies.add(id);
    }
    const metadata = { ...selection, embedded_langs: [...dependencies] };
    selections[index] = metadata;
    const normalized = `${JSON.stringify(normalizeGrammar(grammar, metadata), null, 2)}\n`;
    const license = candidate.license;
    if (!license?.id || !license.path)
      throw new Error(`No license declaration for ${selection.id}`);
    const licenseBytes = await reader.read(candidate.repository, candidate.commit, license.path);
    const license_file = `assets/grammars/licenses/${digest(licenseBytes)}.txt`;
    await mkdir(path.join(outputRoot, "assets/grammars/licenses"), { recursive: true });
    await writeFile(path.join(outputRoot, license_file), licenseBytes);
    const { selector, ...entry } = metadata;
    languages.push({
      ...entry,
      source: rawUrl(candidate.repository, candidate.commit, candidate.path),
      upstream_repository: candidate.repository,
      upstream_commit: candidate.commit,
      upstream_path: candidate.path,
      ...(candidate.module ? { module: candidate.module } : {}),
      license: license.id,
      license_url: rawUrl(candidate.repository, candidate.commit, license.path),
      license_file,
      upstream_sha256: digest(bytes),
      sha256: digest(normalized),
    });
    grammarFiles.set(entry.id, normalized);
  }
  languages.sort((a, b) => a.id.localeCompare(b.id, "en"));
  const changes = grammarChanges(previous.languages, languages);
  const configurationChanged =
    JSON.stringify(Object.keys(previous.repositories || {}).sort()) !==
      JSON.stringify(Object.keys(snapshots).sort()) ||
    Object.entries(snapshots).some(([id, snapshot]) => {
      const old = previous.repositories?.[id];
      return (
        !old ||
        old.repository !== snapshot.repository ||
        old.ref !== snapshot.ref ||
        JSON.stringify(Object.keys(old.modules || {}).sort()) !==
          JSON.stringify(Object.keys(snapshot.modules || {}).sort())
      );
    });
  const report = {
    version: 1,
    changed: changes.length > 0 || configurationChanged,
    configuration_changed: configurationChanged,
    repositories: snapshots,
    changes,
    retired_patches: retiredPatches,
    external_scopes: externalScopes,
    grammar_count: languages.length,
    discovery: [...inventories].map(([id, candidates]) => ({
      id,
      candidates: candidates.map((entry) => ({
        scope: entry.scope,
        path: entry.path,
        module: entry.module || null,
      })),
    })),
  };
  const sources = { version: 2, repositories: snapshots, languages };
  const sourceRoot = path.join(outputRoot, "assets/upstream/curated");
  await mkdir(path.join(sourceRoot, "grammars"), { recursive: true });
  for (const [id, content] of grammarFiles)
    await writeFile(path.join(sourceRoot, "grammars", `${id}.json`), content);
  const keys = [
    "id",
    "grammar_file",
    "scope_name",
    "display_name",
    "aliases",
    "embedded_langs",
    "embedded_langs_lazy",
    "inject_to",
  ];
  await writeFile(
    path.join(sourceRoot, "languages.json"),
    `${JSON.stringify({ languages: languages.map((entry) => Object.fromEntries(keys.map((key) => [key, entry[key]]))) }, null, 2)}\n`,
  );
  await cp(path.join(root, "assets/upstream/curated/themes"), path.join(sourceRoot, "themes"), {
    recursive: true,
  });
  await cp(
    path.join(root, "assets/upstream/curated/themes.json"),
    path.join(sourceRoot, "themes.json"),
  );
  await mkdir(path.join(outputRoot, "assets/standard"), { recursive: true });
  await writeFile(
    path.join(outputRoot, "assets/grammars/sources.json"),
    `${JSON.stringify(sources, null, 2)}\n`,
  );
  await writeFile(
    path.join(outputRoot, "assets/grammars/catalog.json"),
    `${JSON.stringify({ version: 1, languages: selections }, null, 2)}\n`,
  );
  await writeFile(path.join(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Prepared ${languages.length} grammars; ${changes.length} changed. Candidate: ${outputRoot}`,
  );
}
prepare().catch(async (error) => {
  if (created)
    await writeFile(
      path.join(outputRoot, "failure.json"),
      `${JSON.stringify({ status: "failed", error: error.message }, null, 2)}\n`,
    );
  console.error(error.message);
  process.exitCode = 1;
});
