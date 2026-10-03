// Capture HTML scope-class continuation before a native tokenizer change,
// then compare with --compare. Reports hash class HTML and callback scope paths.
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
const scopeSignature = (lines) =>
  lines.map((line) => line.map(({ content, scopeNames, type }) => ({ content, scopeNames, type })));
function renderWithScopes(code, options) {
  let lines;
  const html = highlighter.codeToHtml(code, {
    ...options,
    transformers: [
      {
        tokens(tokens) {
          lines = tokens;
          return tokens;
        },
      },
    ],
  });
  return { html, scopes: scopeSignature(lines) };
}

try {
  for (const fixture of fixtures) {
    for (const multitheme of [false, true]) {
      const options = {
        lang: fixture.lang,
        styleMode: "classes",
        ...(multitheme ? { themes: { dark: "nord", light: "github-dark" } } : { theme: "nord" }),
      };
      const state = highlighter.getLastGrammarState(fixture.prefix, options);
      const grammarState = JSON.parse(JSON.stringify(state));
      const resumed = renderWithScopes(fixture.code, { ...options, grammarState });
      const full = renderWithScopes(`${fixture.prefix}\n${fixture.code}`, options);
      const prefixLines = fixture.prefix.split("\n").length;
      assert.deepEqual(resumed.scopes, full.scopes.slice(prefixLines));
      assert.match(resumed.html, /class="ferriki/);
      cases.push({
        fixture,
        options,
        stateSha256: sha256(JSON.stringify(state)),
        resumedHtmlSha256: sha256(resumed.html),
        resumedScopesSha256: sha256(JSON.stringify(resumed.scopes)),
        fullHtmlSha256: sha256(full.html),
        fullScopesSha256: sha256(JSON.stringify(full.scopes)),
      });
    }
  }
} finally {
  highlighter.dispose();
}
const report = JSON.parse(JSON.stringify({ cases }));
if (values.compare) assert.deepEqual(report, readReport(values.compare));
if (values.write) writeFileSync(values.write, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Verified ${cases.length} HTML scope-class and resumed-state cases`);
