/* eslint-disable antfu/no-top-level-await -- This executable prepares a fixed browser validation corpus. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { gzipSync } from "node:zlib";
import { createHighlighter } from "../../ferriki/index.mjs";
import { syntheticGrammar, syntheticTheme } from "./corpus.mjs";

const generated = new URL("../../.generated/class-highlighting/", import.meta.url);
const data = JSON.parse(await readFile(new URL("data.json", generated), "utf8"));
const themeNames = Object.keys(data.styles);
const themes = Object.fromEntries(
  themeNames.map((name) => [name, name === syntheticTheme.name ? syntheticTheme : name]),
);
const highlighter = await createHighlighter({
  langs: [...new Set(data.cases.map((item) => item.lang))].map((lang) =>
    lang === syntheticGrammar.name ? syntheticGrammar : lang,
  ),
  themes: Object.values(themes),
});
const cases = [];
try {
  for (const item of data.cases) {
    const options = {
      lang: item.lang,
      themes,
      defaultColor: false,
      styleMode: "classes",
      tokenizeTimeLimit: 0,
    };
    let renderedTokens;
    const output = highlighter.codeToHtmlWithCss(item.code, {
      ...options,
      transformers: [
        {
          tokens(tokens) {
            renderedTokens = tokens;
          },
        },
      ],
    });
    assert(renderedTokens, `${item.id}: HTML token hook must run`);
    const raw = renderedTokens.flat();
    const expected = item.tokens.filter((token) => token.end > token.start);
    assert.equal(raw.length, expected.length, item.id);
    for (const [index, token] of raw.entries()) {
      assert.deepEqual(token.scopeNames, expected[index].scopes, `${item.id} scope ${index}`);
      assert.equal(token.content, item.code.slice(expected[index].start, expected[index].end));
    }
    assert(!output.html.includes(" style="));
    cases.push({ id: item.id, code: item.code, expected, ...output });
  }
} finally {
  highlighter.dispose();
}
const html = cases.map((item) => item.html).join("");
const css = [...new Set(cases.flatMap((item) => item.css.split("\n")))].join("\n");
const result = {
  cases,
  css,
  themes: themeNames,
  styles: data.styles,
  defaults: data.defaults,
  metrics: {
    htmlBytes: Buffer.byteLength(html),
    gzipHtmlBytes: gzipSync(html).length,
    cssBytes: Buffer.byteLength(css),
    gzipCssBytes: gzipSync(css).length,
  },
};
for (const item of cases) delete item.css;
await writeFile(new URL("production.json", generated), JSON.stringify(result));
process.stdout.write(
  `Production class output prepared: ${cases.length} cases, ${themeNames.length} themes. ${JSON.stringify(result.metrics)}\n`,
);
