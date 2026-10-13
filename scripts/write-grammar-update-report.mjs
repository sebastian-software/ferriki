import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error("Usage: node scripts/write-grammar-update-report.mjs <report.json> <report.md>");
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
  "The workflow artifact contains normalized grammar diffs in `diffs/` and the complete candidate. Sources and payloads are stored by content hash outside Git.",
  "",
  "## Validation",
  "",
  "I ran native candidate compilation, the mandatory Ferriki core compatibility gate, and both corpus output-agreement checks, and immutable Bunny Storage upload/read-back verification.",
  "",
  "Refs #152; ADR 0020.",
  "",
);
await writeFile(output, lines.join("\n"));
