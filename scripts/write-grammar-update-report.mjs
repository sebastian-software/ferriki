import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const USAGE =
  "Usage: node scripts/write-grammar-update-report.mjs [--pre-publish] [--diffs-artifact <name>] <report.json> <report.md>\n" +
  "   or: node scripts/write-grammar-update-report.mjs --check-locks --base-sources <path> --base-catalog <path> --sources <path> --catalog <path> <report.json>";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, "en"));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function computeGrammarChanges(previous, languages) {
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
  for (const entry of previous) {
    if (!activeIds.has(entry.id)) {
      changes.push({
        id: entry.id,
        removed: true,
        before: entry.upstream_sha256,
        after: null,
        repository_id: entry.repository_id,
      });
    }
  }
  return changes;
}

export function verifyReportLocks({ report, baseSources, baseCatalog, sources, catalog }) {
  if (!report || typeof report !== "object") throw new Error("Invalid grammar update report");
  if (report.version !== 1) throw new Error(`Unsupported report version: ${report.version}`);
  if (
    !Array.isArray(baseSources?.languages) ||
    !Array.isArray(sources?.languages) ||
    !Array.isArray(baseCatalog?.languages) ||
    !Array.isArray(catalog?.languages)
  ) {
    throw new TypeError("Invalid base or candidate grammar lock inputs");
  }
  if (
    report.grammar_count !== sources.languages.length ||
    catalog.languages.length !== sources.languages.length
  ) {
    throw new Error(
      `Report grammar_count drift: report has ${report.grammar_count}, sources has ${sources.languages.length}, catalog has ${catalog.languages.length}`,
    );
  }
  if (canonicalJson(report.repositories ?? null) !== canonicalJson(sources.repositories ?? null)) {
    throw new Error("Report repository pins drift from candidate sources.json");
  }
  const expectedChanges = computeGrammarChanges(baseSources.languages, sources.languages);
  if (
    !Array.isArray(report.changes) ||
    canonicalJson(report.changes) !== canonicalJson(expectedChanges)
  ) {
    throw new Error("Report changes drift from verified base/candidate lock diff");
  }
  const expectedConfigurationChanged =
    JSON.stringify(Object.keys(baseSources.repositories || {}).sort()) !==
      JSON.stringify(Object.keys(sources.repositories || {}).sort()) ||
    Object.entries(sources.repositories || {}).some(([id, snapshot]) => {
      const old = baseSources.repositories?.[id];
      return (
        !old ||
        old.repository !== snapshot.repository ||
        old.ref !== snapshot.ref ||
        JSON.stringify(Object.keys(old.modules || {}).sort()) !==
          JSON.stringify(Object.keys(snapshot.modules || {}).sort())
      );
    });
  if (report.configuration_changed !== expectedConfigurationChanged) {
    throw new Error(
      `Report configuration_changed drift: expected ${expectedConfigurationChanged}, got ${report.configuration_changed}`,
    );
  }
  const expectedChanged = expectedChanges.length > 0 || expectedConfigurationChanged;
  if (report.changed !== expectedChanged) {
    throw new Error(
      `Report changed flag drift: expected ${expectedChanged}, got ${report.changed}`,
    );
  }
  const languageIds = new Set(sources.languages.map((entry) => entry.id));
  if (!Array.isArray(report.external_scopes)) {
    throw new TypeError("Report external_scopes must be an array");
  }
  for (const item of report.external_scopes) {
    if (
      !item ||
      typeof item.language !== "string" ||
      !languageIds.has(item.language) ||
      typeof item.scope !== "string" ||
      !item.scope
    ) {
      throw new Error(`Invalid external_scopes entry in report: ${JSON.stringify(item)}`);
    }
  }
  if (!Array.isArray(report.retired_patches)) {
    throw new TypeError("Report retired_patches must be an array");
  }
  const baseCatalogById = new Map(baseCatalog.languages.map((entry) => [entry.id, entry]));
  const catalogById = new Map(catalog.languages.map((entry) => [entry.id, entry]));
  const retiredLanguages = new Set();
  for (const item of report.retired_patches) {
    if (
      !item ||
      typeof item.language !== "string" ||
      !languageIds.has(item.language) ||
      typeof item.path !== "string" ||
      !item.path ||
      !baseCatalogById.get(item.language)?.patch_file
    ) {
      throw new Error(`Invalid retired_patches entry in report: ${JSON.stringify(item)}`);
    }
    retiredLanguages.add(item.language);
  }
  for (const baseEntry of baseCatalog.languages) {
    if (baseEntry.patch_file && catalogById.has(baseEntry.id)) {
      const candidateEntry = catalogById.get(baseEntry.id);
      if (!candidateEntry.patch_file && !retiredLanguages.has(baseEntry.id)) {
        throw new Error(`Report missing retired_patches entry for ${baseEntry.id}`);
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--check-locks") {
    let baseSourcesPath = null;
    let baseCatalogPath = null;
    let sourcesPath = null;
    let catalogPath = null;
    let reportPath = null;
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--base-sources" && args[index + 1]) baseSourcesPath = args[++index];
      else if (arg === "--base-catalog" && args[index + 1]) baseCatalogPath = args[++index];
      else if (arg === "--sources" && args[index + 1]) sourcesPath = args[++index];
      else if (arg === "--catalog" && args[index + 1]) catalogPath = args[++index];
      else if (!arg.startsWith("--") && !reportPath) reportPath = arg;
      else throw new Error(USAGE);
    }
    if (!baseSourcesPath || !baseCatalogPath || !sourcesPath || !catalogPath || !reportPath) {
      throw new Error(USAGE);
    }
    const [report, baseSources, baseCatalog, sources, catalog] = await Promise.all([
      readFile(reportPath, "utf8").then(JSON.parse),
      readFile(baseSourcesPath, "utf8").then(JSON.parse),
      readFile(baseCatalogPath, "utf8").then(JSON.parse),
      readFile(sourcesPath, "utf8").then(JSON.parse),
      readFile(catalogPath, "utf8").then(JSON.parse),
    ]);
    verifyReportLocks({ report, baseSources, baseCatalog, sources, catalog });
    console.log(
      `Verified grammar update report (${report.grammar_count} grammars, ${report.changes.length} changes).`,
    );
    return;
  }

  let prePublish = false;
  let diffsArtifact = "grammar-verified-diffs";
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--pre-publish") {
      prePublish = true;
    } else if (arg === "--diffs-artifact") {
      if (index + 1 >= args.length) throw new Error(USAGE);
      diffsArtifact = args[++index];
    } else if (arg.startsWith("--diffs-artifact=")) {
      diffsArtifact = arg.slice("--diffs-artifact=".length);
    } else if (arg.startsWith("--")) {
      throw new Error(USAGE);
    } else {
      positional.push(arg);
    }
  }
  if (!/^[a-z0-9][\w.-]*$/i.test(diffsArtifact)) {
    throw new Error(`Invalid diffs artifact name: ${diffsArtifact}`);
  }
  const [input, output] = positional;
  if (!input || !output || positional.length !== 2) throw new Error(USAGE);
  const report = JSON.parse(await readFile(input, "utf8"));
  const lines = [
    "I refreshed the configured grammar repository snapshots and regenerated the standard catalog.",
    "",
    `The candidate contains ${report.grammar_count} grammars; ${report.changes.length} changed, were added, or were removed.`,
    "",
    "## Repository snapshots",
    "",
  ];
  for (const [id, snapshot] of Object.entries(report.repositories))
    lines.push(
      `- ${id}: [${snapshot.repository}@${snapshot.commit.slice(0, 12)}](https://github.com/${snapshot.repository}/commit/${snapshot.commit})`,
    );
  lines.push(
    "",
    "## Changed grammars",
    "",
    report.changes
      .map(
        (change) =>
          `\`${change.id}\`${change.removed ? " (removed)" : change.added ? " (added)" : ""}${change.license_changed ? " (license notice changed)" : ""}`,
      )
      .join(", "),
    "",
  );
  if (report.external_scopes.length) {
    lines.push(
      "## External scope references",
      "",
      "These scopes are outside the selected source set and retain the host grammar fallback:",
      "",
    );
    for (const reference of report.external_scopes)
      lines.push(`- ${reference.language}: \`${reference.scope}\``);
  }
  lines.push(
    "",
    "## Review artifacts",
    "",
    prePublish
      ? "The `grammar-candidate` diagnostic artifact contains pre-verification diffs in `diffs/` and the candidate snapshot. Once independent rebuild verification succeeds, the `grammar-verified-diffs` artifact from the isolated `verify` job provides the verified review diffs and report."
      : `The \`${diffsArtifact}\` workflow artifact (produced by the isolated \`verify\` job) contains normalized grammar diffs in \`diffs/\` and the verified \`report.json\`. Sources and payloads are stored by content hash outside Git.`,
    "",
    "## Validation",
    "",
    prePublish
      ? "I ran native candidate compilation, the mandatory Ferriki core compatibility gate, and both corpus output-agreement checks. Independent locked rebuild verification, immutable Bunny Storage upload, and public CDN read-back verification run in separate jobs before opening or updating the pull request."
      : "I ran native candidate compilation, the mandatory Ferriki core compatibility gate, both corpus output-agreement checks, independent locked rebuild verification, and immutable Bunny Storage upload/read-back verification.",
    "",
    "Refs #152; ADR 0020.",
    "",
  );
  await writeFile(output, lines.join("\n"));
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
