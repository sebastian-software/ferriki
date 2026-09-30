// Capture the public token/state contract before a native tokenizer change,
// then compare with --compare. Hashes include explanations and grammarState.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createHighlighter } from "../ferriki/index.mjs";
import { readReport, sha256 } from "./tiobe-benchmark.mjs";

const { values } = parseArgs({
  options: { write: { type: "string" }, compare: { type: "string" } },
});
const fixtures = [
  { lang: "javascript", prefix: "/* open", code: '😀 comment */\r\nconst value = "אב😀";\n' },
  { lang: "typescript", prefix: 'const text = "', code: '😀";\r\nconst n: number = 42;\n' },
  {
    lang: "markdown",
    prefix: "```typescript",
    code: 'const value: string = "😀";\n```\n**text**\n',
  },
  {
    lang: "vue",
    prefix: '<script lang="ts">',
    code: "const n: number = 1\n</script>\n<template><b>{{ n }}</b></template>\n",
  },
  {
    lang: "html",
    prefix: "<script>",
    code: 'const n = "😀";\n</script>\n<style>b { color: red }</style>\n',
  },
  { lang: "json", prefix: '{"a":', code: '"😀", "b": [1, true]}\r\n' },
  { lang: "rust", prefix: "/* open", code: '😀 */\nfn main() { let x = "אב"; }\n' },
];
const highlighter = await createHighlighter({
  langs: fixtures.map(({ lang }) => lang),
  themes: ["nord", "github-dark"],
  assets: { remote: false },
});
const cases = [];
try {
  for (const fixture of fixtures) {
    for (const styleMode of ["inline", "classes"]) {
      for (const includeExplanation of [undefined, false, true, "scopeName", "tokenType"]) {
        for (const multitheme of [false, true]) {
          const options = {
            lang: fixture.lang,
            styleMode,
            includeExplanation,
            ...(multitheme
              ? { themes: { dark: "nord", light: "github-dark" } }
              : { theme: "nord" }),
          };
          const state = highlighter.getLastGrammarState(fixture.prefix, options);
          const grammarState = JSON.parse(JSON.stringify(state));
          const resumed = highlighter.codeToTokens(fixture.code, { ...options, grammarState });
          assert.deepEqual(
            resumed,
            highlighter.codeToTokens(fixture.code, { ...options, grammarState }),
          );
          const full = highlighter.codeToTokens(`${fixture.prefix}\n${fixture.code}`, options);
          cases.push({
            fixture,
            options,
            stateSha256: sha256(JSON.stringify(state)),
            resumedSha256: sha256(JSON.stringify(resumed)),
            fullSha256: sha256(JSON.stringify(full)),
          });
        }
      }
    }
  }
} finally {
  highlighter.dispose();
}
// Normalize omitted properties before comparing a saved JSON report.
const report = JSON.parse(JSON.stringify({ cases }));
if (values.compare) assert.deepEqual(report, readReport(values.compare));
if (values.write) writeFileSync(values.write, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Verified ${cases.length} public token, explanation, multi-theme and resumed-state cases`,
);
