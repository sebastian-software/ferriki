import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyGrammarPatches, normalizeGrammar, parseGrammarSource } from "./grammar-source.mjs";
import { rawUrl } from "./grammar-repositories.mjs";

const root = new URL("../", import.meta.url);
const sourceRoot = new URL("assets/upstream/textmate-grammars-themes/", root);
const sources = JSON.parse(await readFile(new URL("assets/grammars/sources.json", root), "utf8"));
const writeNotices = process.argv.includes("--check-sources");
const check = process.argv.includes("--check") || writeNotices;
if (process.argv.slice(2).some((arg) => !["--check", "--check-sources"].includes(arg)))
  throw new Error("Usage: node scripts/sync-grammars.mjs [--check|--check-sources]");
const { languages } = sources;
const ids = new Set();
const keys = new Set();
const licenses = new Set(["MIT", "Apache-2.0", "BSD-3-Clause", "MPL-2.0", "LicenseRef-TextMate-Bundle"]);
for (const entry of languages) {
  if (
    !/^[a-z0-9-]+$/.test(entry.id) ||
    ids.has(entry.id) ||
    entry.grammar_file !== `${entry.id}.json`
  )
    throw new Error(`Invalid or duplicate grammar ID/file: ${entry.id}`);
  ids.add(entry.id);
  for (const key of [entry.id, ...entry.aliases]) {
    if (keys.has(key)) throw new Error(`Duplicate language key: ${key}`);
    keys.add(key);
  }
  if (!/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\/.+/.test(entry.source))
    throw new Error(`Unpinned grammar source: ${entry.id}`);
  if (
    !licenses.has(entry.license) ||
    !entry.license_url ||
    !entry.license_file ||
    !/^[a-f0-9]{64}$/.test(entry.upstream_sha256)
  )
    throw new Error(`Incomplete grammar provenance: ${entry.id}`);
  if (sources.repositories) {
    const snapshot = sources.repositories[entry.repository_id];
    const pin = entry.module ? snapshot?.modules?.[entry.module] : snapshot;
    if (
      !pin ||
      pin.repository !== entry.upstream_repository ||
      pin.commit !== entry.upstream_commit ||
      entry.source !== rawUrl(pin.repository, pin.commit, entry.upstream_path)
    )
      throw new Error(`Repository snapshot drift: ${entry.id}`);
  }
}
for (const entry of languages)
  for (const dependency of [...entry.embedded_langs, ...entry.embedded_langs_lazy])
    if (!ids.has(dependency))
      throw new Error(`${entry.id}: missing embedded language ${dependency}`);

let cursor = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (cursor < languages.length) {
      const entry = languages[cursor++];
      const file = new URL(`grammars/${entry.grammar_file}`, sourceRoot);
      if (check) {
        const bytes = await readFile(file);
        if (digest(bytes) !== entry.sha256) throw new Error(`Grammar drift: ${entry.id}`);
        const grammar = JSON.parse(bytes);
        if (JSON.stringify(normalizeGrammar(grammar, entry)) !== JSON.stringify(grammar))
          throw new Error(`Grammar metadata drift: ${entry.id}`);
      } else {
        const response = await fetch(entry.source, { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error(`${entry.id}: HTTP ${response.status}`);
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) throw new Error(`${entry.id}: grammar exceeds 8 MiB`);
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        if (digest(bytes) !== entry.upstream_sha256)
          throw new Error(`Upstream digest mismatch: ${entry.id}`);
        const patches = entry.patch_file
          ? JSON.parse(await readFile(new URL(entry.patch_file, root), "utf8"))
          : [];
        const grammar = normalizeGrammar(
          applyGrammarPatches(parseGrammarSource(bytes.toString("utf8"), entry.source), patches),
          entry,
        );
        const normalized = `${JSON.stringify(grammar, null, 2)}\n`;
        if (digest(normalized) !== entry.sha256)
          throw new Error(`Normalized grammar drift: ${entry.id}`);
        await writeFile(file, normalized);
      }
    }
  }),
);

const metadata = languages.map(
  ({
    id,
    grammar_file,
    scope_name,
    display_name,
    aliases,
    embedded_langs,
    embedded_langs_lazy,
    inject_to,
  }) => ({
    id,
    grammar_file,
    scope_name,
    display_name,
    aliases,
    embedded_langs,
    embedded_langs_lazy,
    inject_to,
  }),
);
const catalogFile = new URL("languages.json", sourceRoot);
const catalog = `${JSON.stringify({ languages: metadata }, null, 2)}\n`;
if (check) {
  if ((await readFile(catalogFile, "utf8")) !== catalog) throw new Error("Language catalog drift");
} else {
  await writeFile(catalogFile, catalog);
}
const notices = [
  "# Third-party grammar notices",
  "",
  "Ferriki standard grammars come from the following pinned sources. The notices below apply to grammar data, separately from Ferriki's own license.",
  "",
];
for (const file of [...new Set(languages.map((entry) => entry.license_file))].sort()) {
  const text = await readFile(new URL(file, root), "utf8");
  if (!file.endsWith(`${digest(text)}.txt`)) throw new Error(`License notice drift: ${file}`);
  const entries = languages.filter((entry) => entry.license_file === file);
  notices.push(`## ${entries.map((entry) => entry.id).join(", ")}`, "");
  for (const entry of entries)
    notices.push(`- [${entry.id}](${entry.source}) — [${entry.license}](${entry.license_url})`);
  notices.push("", text.trim(), "");
}
const noticeFile = new URL("assets/shiki/GRAMMAR-NOTICES.md", root);
const noticeText = `${notices.join("\n")}\n`;
if (check && !writeNotices) {
  if ((await readFile(noticeFile, "utf8")) !== noticeText) throw new Error("Grammar notices drift");
} else await writeFile(noticeFile, noticeText);
console.log(
  `${check ? "Verified" : "Synced"} ${languages.length} Ferriki grammars (${fileURLToPath(sourceRoot)}).`,
);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
