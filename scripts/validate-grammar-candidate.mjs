import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHighlighterCoreSync } from "../node/ferriki/index.mjs";

const candidate = process.argv[2] && path.resolve(process.argv[2]);
if (!candidate)
  throw new Error("Usage: node scripts/validate-grammar-candidate.mjs <candidate-directory>");
const { languages } = JSON.parse(
  await readFile(path.join(candidate, "assets/grammars/sources.json"), "utf8"),
);
const fields = new Set([
  "name",
  "scopeName",
  "displayName",
  "aliases",
  "patterns",
  "repository",
  "injections",
  "injectionSelector",
  "fileTypes",
  "firstLineMatch",
  "embeddedLangs",
  "embeddedLangsLazy",
  "injectTo",
  "balancedBracketSelectors",
  "unbalancedBracketSelectors",
  "foldingStartMarker",
  "foldingStopMarker",
]);
const registrations = await Promise.all(
  languages.map(async (entry) => {
    const grammar = JSON.parse(
      await readFile(
        path.join(candidate, "assets/upstream/curated/grammars", entry.grammar_file),
        "utf8",
      ),
    );
    return {
      ...Object.fromEntries(Object.entries(grammar).filter(([key]) => fields.has(key))),
      name: `candidate-${entry.id}`,
      aliases: [],
    };
  }),
);
const highlighter = createHighlighterCoreSync({
  langs: registrations,
  themes: [{ name: "candidate-validation", fg: "#111111", bg: "#ffffff", settings: [] }],
  assets: { remote: false },
});
try {
  for (const entry of languages) {
    const html = highlighter.codeToHtml("TODO 123", {
      lang: `candidate-${entry.id}`,
      theme: "candidate-validation",
    });
    assert.match(html, /TODO/);
    assert.match(html, /123/);
  }
} finally {
  highlighter.dispose();
}
console.log(`Candidate native registration and compilation verified: ${languages.length} grammars`);
