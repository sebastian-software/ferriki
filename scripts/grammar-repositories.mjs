import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { parseGrammarSource } from "./grammar-source.mjs";

const run = promisify(execFile);
const COMMIT = /^[a-f0-9]{40}$/;
const GRAMMAR = /\.(?:tmLanguage(?:\.json)?|tmGrammar\.json|json|ya?ml|cson)$/i;

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function rawUrl(repository, commit, file) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !COMMIT.test(commit))
    throw new Error(`Invalid repository pin: ${repository}@${commit}`);
  if (file.startsWith("/") || file.split("/").some((part) => part === ".."))
    throw new Error(`Unsafe repository path: ${file}`);
  return `https://raw.githubusercontent.com/${repository}/${commit}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

export function createGitHubReader() {
  const apiCache = new Map();
  const fileCache = new Map();
  return {
    api(endpoint) {
      if (!apiCache.has(endpoint))
        apiCache.set(
          endpoint,
          (async () => {
            const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
            if (token) {
              const response = await fetch(`https://api.github.com/${endpoint}`, {
                headers: {
                  authorization: `Bearer ${token}`,
                  accept: "application/vnd.github+json",
                },
                signal: AbortSignal.timeout(60000),
              });
              if (!response.ok) throw new Error(`GitHub ${endpoint}: HTTP ${response.status}`);
              return response.json();
            }
            const { stdout } = await run("gh", ["api", endpoint], { maxBuffer: 32 * 1024 * 1024 });
            return JSON.parse(stdout);
          })(),
        );
      return apiCache.get(endpoint);
    },
    read(repository, commit, file) {
      const url = rawUrl(repository, commit, file);
      if (!fileCache.has(url))
        fileCache.set(
          url,
          (async () => {
            const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
            if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body) {
              size += chunk.length;
              if (size > 8 * 1024 * 1024) throw new Error(`${file}: source exceeds 8 MiB`);
              chunks.push(chunk);
            }
            return Buffer.concat(chunks);
          })(),
        );
      return fileCache.get(url);
    },
  };
}

async function mapLimit(items, work, limit = 6) {
  const output = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        output[index] = await work(items[index]);
      }
    }),
  );
  return output;
}

export function parseSubmodules(text) {
  const modules = new Map();
  for (const section of text.split(/\[submodule /).slice(1)) {
    const modulePath = /^\s*path\s*=\s*(.+)$/m.exec(section)?.[1].trim();
    const repository =
      /^\s*url\s*=\s*https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/m.exec(section)?.[1];
    if (modulePath?.startsWith("vendor/grammars/") && repository)
      modules.set(modulePath, repository);
  }
  return modules;
}

export async function resolveRepositorySnapshots(config, reader, locked) {
  if (
    locked &&
    JSON.stringify(config.repositories.map((source) => source.id).sort()) !==
      JSON.stringify(Object.keys(locked).sort())
  )
    throw new Error("Repository configuration drift: locked source IDs do not match");
  const snapshots = {};
  // Resolve each moving reference exactly once. All files in the repository
  // use that immutable commit, even when the branch advances during a run.
  for (const source of config.repositories) {
    const previous = locked?.[source.id];
    const commit =
      previous?.commit ||
      (await reader.api(`repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`))
        .sha;
    if (!COMMIT.test(commit)) throw new Error(`Invalid commit for ${source.id}`);
    if (previous && (previous.repository !== source.repository || previous.ref !== source.ref))
      throw new Error(`Repository configuration drift: ${source.id}`);
    const snapshot = { repository: source.repository, ref: source.ref, commit };
    if (source.adapter === "linguist") {
      if (
        previous &&
        JSON.stringify([...source.modules].sort()) !==
          JSON.stringify(Object.keys(previous.modules || {}).sort())
      )
        throw new Error(`Repository configuration drift: Linguist modules for ${source.id}`);
      const tree = await reader.api(`repos/${source.repository}/git/trees/${commit}?recursive=1`);
      if (tree.truncated) throw new Error(`Truncated repository tree: ${source.id}`);
      const modules = parseSubmodules(
        (await reader.read(source.repository, commit, ".gitmodules")).toString("utf8"),
      );
      snapshot.modules = {};
      for (const modulePath of source.modules) {
        const pin = tree.tree.find((item) => item.path === modulePath && item.type === "commit");
        const repository = modules.get(modulePath);
        if (!pin || !repository || !COMMIT.test(pin.sha))
          throw new Error(`Missing Linguist module: ${modulePath}`);
        const module = { repository, commit: pin.sha };
        if (previous && JSON.stringify(module) !== JSON.stringify(previous.modules?.[modulePath]))
          throw new Error(`Linguist module lock drift: ${modulePath}`);
        snapshot.modules[modulePath] = module;
      }
    }
    snapshots[source.id] = snapshot;
  }
  return snapshots;
}

export function grammarChanges(previous, languages) {
  const previousById = new Map(previous.map((entry) => [entry.id, entry]));
  const compared = [
    "sha256",
    "upstream_sha256",
    "license_file",
    "license",
    "upstream_repository",
    "upstream_path",
    "repository_id",
    "module",
  ];
  const changes = languages.flatMap((entry) => {
    const before = previousById.get(entry.id);
    if (before && compared.every((key) => before[key] === entry[key])) return [];
    return [
      {
        id: entry.id,
        added: !before,
        before: before?.upstream_sha256 || null,
        after: entry.upstream_sha256,
        repository_id: entry.repository_id,
        license_changed: before?.license_file !== entry.license_file,
      },
    ];
  });
  const activeIds = new Set(languages.map((entry) => entry.id));
  for (const entry of previous)
    if (!activeIds.has(entry.id))
      changes.push({
        id: entry.id,
        removed: true,
        before: entry.upstream_sha256,
        after: null,
        repository_id: entry.repository_id,
      });
  return changes;
}

export async function discoverRepository(source, snapshot, reader) {
  const candidates = [];
  const inventories =
    source.adapter === "linguist"
      ? Object.entries(snapshot.modules).map(([module, pin]) => ({ ...pin, module }))
      : [{ repository: snapshot.repository, commit: snapshot.commit }];
  for (const pin of inventories) {
    const tree = await reader.api(`repos/${pin.repository}/git/trees/${pin.commit}?recursive=1`);
    if (tree.truncated) throw new Error(`Truncated repository tree: ${pin.repository}`);
    if (source.adapter === "vscode") {
      const manifests = tree.tree.filter(
        (item) => item.type === "blob" && /^extensions\/[^/]+\/package\.json$/.test(item.path),
      );
      const entries = await mapLimit(manifests, async (item) => {
        const manifest = JSON.parse(
          (await reader.read(pin.repository, pin.commit, item.path)).toString("utf8"),
        );
        return (manifest.contributes?.grammars || []).map((grammar) => ({
          ...pin,
          path: path.posix.normalize(path.posix.join(path.posix.dirname(item.path), grammar.path)),
          scope: grammar.scopeName,
          upstream_language: grammar.language || null,
          inject_to: grammar.injectTo || [],
          embedded_scopes: Object.keys(grammar.embeddedLanguages || {}),
          license: source.license,
        }));
      });
      candidates.push(...entries.flat());
    } else {
      const paths = source.paths?.[pin.module] ||
        source.paths || ["syntaxes/", "grammars/", "Syntaxes/"];
      const grammarFiles = tree.tree.filter(
        (item) =>
          item.type === "blob" &&
          GRAMMAR.test(item.path) &&
          (Array.isArray(paths) ? paths : []).some((prefix) => item.path.startsWith(prefix)) &&
          !/(^|\/)(test|tests|fixtures|node_modules)\//.test(item.path),
      );
      candidates.push(
        ...(
          await mapLimit(grammarFiles, async (item) => {
            const bytes = await reader.read(pin.repository, pin.commit, item.path);
            const grammar = parseGrammarSource(bytes.toString("utf8"), item.path);
            if (grammar?.type === "tree-sitter") return null;
            if (!grammar?.scopeName || (!Array.isArray(grammar.patterns) && !grammar.repository))
              throw new Error(`Not a TextMate grammar: ${pin.repository}/${item.path}`);
            return {
              ...pin,
              path: item.path,
              scope: grammar.scopeName,
              upstream_language: grammar.name || null,
              inject_to: grammar.injectTo || [],
              embedded_scopes: [],
              license: source.module_licenses?.[pin.module] || source.license,
            };
          })
        ).filter(Boolean),
      );
    }
  }
  // One grammar can be registered for several editor language IDs.
  return candidates.filter(
    (entry, index) =>
      candidates.findIndex(
        (other) =>
          other.repository === entry.repository &&
          other.path === entry.path &&
          other.module === entry.module,
      ) === index,
  );
}

export function selectCandidate(candidates, selection) {
  const matches = candidates.filter(
    (candidate) =>
      candidate.module === selection.module &&
      (selection.path ? candidate.path === selection.path : candidate.scope === selection.scope),
  );
  if (matches.length !== 1)
    throw new Error(
      `Expected one grammar for ${JSON.stringify(selection)}; found ${matches.length}. Available: ${candidates.map((item) => `${item.scope} (${item.path})`).join(", ")}`,
    );
  return matches[0];
}
