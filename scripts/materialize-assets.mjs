import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CDN,
  objectPath,
  payloadPath,
  fetchBytes,
  verifiedRead,
  writeVerified,
  writeMetadata,
} from "./asset-store.mjs";
import { applyGrammarPatches, normalizeGrammar, parseGrammarSource } from "./grammar-source.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const argv = process.argv.slice(2);
let outputRoot = root;
const outputIndex = argv.indexOf("--output-dir");
if (outputIndex !== -1) {
  if (!argv[outputIndex + 1] || argv[outputIndex + 1].startsWith("--"))
    throw new Error("--output-dir needs a directory");
  outputRoot = path.resolve(argv[outputIndex + 1]);
  argv.splice(outputIndex, 2);
}
const flags = new Set(argv);
if (
  [...flags].some(
    (flag) => !["--payloads", "--sources", "--metadata-only", "--bootstrap"].includes(flag),
  )
)
  throw new Error(
    "Usage: node scripts/materialize-assets.mjs [--payloads|--sources|--metadata-only]",
  );
const lock = JSON.parse(await readFile(path.join(root, "assets/catalog.json"), "utf8"));
const sources = JSON.parse(await readFile(path.join(root, "assets/grammars/sources.json"), "utf8"));
const bootstrap = flags.has("--bootstrap") || process.env.FERRIKI_ASSETS_BOOTSTRAP === "1";
const cdn = (process.env.FERRIKI_ASSETS_BASE_URL || DEFAULT_CDN).replace(/\/$/, "");
await writeMetadata(outputRoot, lock);

async function obtain(file, kind, id, hash, source, size) {
  if (await verifiedRead(file, hash, size)) return;
  const bytes =
    (bootstrap
      ? null
      : await fetchBytes(`${cdn}/${objectPath(kind, id, hash)}`, {
          missing: true,
          limit: size ?? 8 * 1024 * 1024,
        })) ?? (source ? await fetchBytes(source, { limit: size ?? 8 * 1024 * 1024 }) : null);
  if (!bytes) throw new Error(`Missing immutable asset: ${id}/${hash}`);
  await writeVerified(file, bytes, hash, size);
}

async function parallel(entries, run) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (cursor < entries.length) await run(entries[cursor++]);
    }),
  );
}

if (flags.has("--sources")) {
  const upstream = path.join(outputRoot, "assets/upstream/curated");
  await parallel(sources.languages, async (entry) => {
    const raw = path.join(outputRoot, "assets/grammar-raw", entry.id, entry.upstream_sha256);
    await obtain(raw, "language", entry.id, entry.upstream_sha256, entry.source);
    const normalized = path.join(upstream, "grammars", entry.grammar_file);
    if (!(await verifiedRead(normalized, entry.sha256))) {
      let bytes = bootstrap
        ? null
        : await fetchBytes(`${cdn}/${objectPath("language", entry.id, entry.sha256)}`, {
            missing: true,
          });
      if (!bytes) {
        const patches = entry.patch_file
          ? JSON.parse(await readFile(path.join(root, entry.patch_file), "utf8"))
          : [];
        const grammar = normalizeGrammar(
          applyGrammarPatches(
            parseGrammarSource((await readFile(raw)).toString("utf8"), entry.upstream_path),
            patches,
          ),
          entry,
        );
        bytes = Buffer.from(JSON.stringify(grammar, null, 2) + "\n");
      }
      await writeVerified(normalized, bytes, entry.sha256);
    }
  });
  await parallel(lock.theme_sources, (entry) =>
    obtain(
      path.join(upstream, "themes", entry.theme_file),
      "theme",
      entry.id,
      entry.sha256,
      entry.source,
    ),
  );
  await mkdir(upstream, { recursive: true });
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
  await writeFile(
    path.join(upstream, "languages.json"),
    JSON.stringify(
      {
        languages: sources.languages.map((entry) =>
          Object.fromEntries(fields.map((key) => [key, entry[key]])),
        ),
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(upstream, "themes.json"),
    JSON.stringify(
      { themes: lock.theme_sources.map(({ sha256, source, ...entry }) => entry) },
      null,
      2,
    ) + "\n",
  );
}
if (flags.has("--payloads") || flags.size === 0) {
  await parallel(Object.entries(lock.release.assets), async ([key, asset]) => {
    const file = path.join(outputRoot, "assets/standard", key);
    if (await verifiedRead(file, asset.sha256, asset.size)) return;
    const bytes =
      (bootstrap
        ? null
        : await fetchBytes(`${cdn}/${payloadPath(key, asset)}`, {
            missing: true,
            limit: asset.size,
          })) ??
      (lock.bootstrap_commit
        ? await fetchBytes(
            `https://raw.githubusercontent.com/sebastian-software/ferriki/${lock.bootstrap_commit}/assets/shiki/${key}`,
            { limit: asset.size },
          )
        : null);
    if (!bytes) throw new Error(`Missing immutable payload: ${key}`);
    await writeVerified(file, bytes, asset.sha256, asset.size);
  });
}
console.log(
  `Materialized locked asset metadata${flags.has("--sources") ? " and sources" : ""}${flags.has("--payloads") || flags.size === 0 ? " and payloads" : ""}.`,
);
