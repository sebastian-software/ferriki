import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHighlighter as createShikiHighlighter } from "shiki";

import { createHighlighter, ShikiError } from "../ferriki/index.mjs";
import { comparisonCorpus } from "./shiki-comparison-corpus.mjs";

import "./test-asset-env.mjs";

const highlighter = await createHighlighter({
  langs: ["typescript"],
  themes: ["vitesse-light", "vitesse-dark"],
});

try {
  const options = {
    lang: "typescript",
    themes: {
      light: "vitesse-light",
      dark: "vitesse-dark",
    },
    defaultColor: false,
  };
  const tokens = highlighter.codeToTokens("const answer: number = 42", options);
  assert.equal(tokens.themeName, "shiki-themes vitesse-light vitesse-dark");
  assert.match(tokens.fg, /--shiki-light:/);
  assert.match(tokens.fg, /--shiki-dark:/);
  assert(Object.hasOwn(tokens.tokens[0][0], "htmlStyle"));
  assert.match(tokens.tokens[0][0].htmlStyle, /--shiki-light:/);
  assert.match(tokens.tokens[0][0].htmlStyle, /--shiki-dark:/);

  const html = highlighter.codeToHtml("const answer: number = 42", options);
  assert.match(html, /class="shiki shiki-themes vitesse-light vitesse-dark"/);
  assert.match(html, /--shiki-light:/);
  assert.match(html, /--shiki-dark:/);

  const lightDark = highlighter.codeToHtml("const answer = 42", {
    ...options,
    defaultColor: "light-dark()",
  });
  assert.match(lightDark, /light-dark\(/);
  assert.match(lightDark, /--shiki-light:/);
  assert.match(lightDark, /--shiki-dark:/);

  assert.throws(
    () =>
      highlighter.codeToHtml("const answer = 42", {
        lang: "typescript",
        themes: { dark: "vitesse-dark" },
      }),
    (error) => error instanceof ShikiError && error.message.includes("defaultColor key `light`"),
  );
  assert.throws(
    () =>
      highlighter.codeToHtml("const answer = 42", {
        lang: "typescript",
        themes: {},
        defaultColor: false,
      }),
    (error) => error instanceof ShikiError && error.message === "`themes` option must not be empty",
  );

  const none = highlighter.codeToHtml("const answer = 42", {
    lang: "typescript",
    theme: "none",
  });
  assert.match(none, /class="none"/);
  assert.match(none, /color:inherit/);
} finally {
  highlighter.dispose();
}

console.log("Ferriki multi-theme contract verified");

// Compare the actual rendering contract, including Ardo's defaultColor:false.
const themes = ["github-light", "github-dark"];
const native = await createHighlighter({ langs: comparisonCorpus.map(([lang]) => lang), themes });
const reference = await createShikiHighlighter({
  langs: comparisonCorpus.map(([lang]) => lang),
  themes,
});
try {
  for (const [lang, code] of [
    ["typescript", "  const a = 1; \n\t// comment\n\nconst emoji = '😀';"],
    ["rust", readFileSync(new URL("../../src/highlighter.rs", import.meta.url), "utf8")],
  ]) {
    for (const defaultColor of [undefined, false]) {
      for (const mergeWhitespaces of [true, false]) {
        for (const mergeSameStyleTokens of [false, true]) {
          for (const transformers of [undefined, [{ tokens: (tokens) => tokens }]]) {
            const options = {
              lang,
              themes: { light: themes[0], dark: themes[1] },
              defaultColor,
              mergeWhitespaces,
              mergeSameStyleTokens,
              transformers,
            };
            assert.equal(
              native.codeToHtml(code, options),
              reference.codeToHtml(code, options),
              JSON.stringify({
                lang,
                defaultColor,
                mergeWhitespaces,
                mergeSameStyleTokens,
                transformed: !!transformers,
              }),
            );
            assert.deepEqual(
              JSON.parse(JSON.stringify(native.codeToHast(code, options))),
              JSON.parse(JSON.stringify(reference.codeToHast(code, options))),
            );
          }
        }
      }
    }
  }
  for (const [lang, path] of comparisonCorpus) {
    const code = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    for (const defaultColor of [undefined, false]) {
      const options = { lang, themes: { light: themes[0], dark: themes[1] }, defaultColor };
      assert.equal(native.codeToHtml(code, options), reference.codeToHtml(code, options), path);
      assert.deepEqual(
        JSON.parse(JSON.stringify(native.codeToHast(code, options))),
        JSON.parse(JSON.stringify(reference.codeToHast(code, options))),
        path,
      );
    }
  }
} finally {
  native.dispose();
  reference.dispose();
}
console.log("Multi-theme HTML and HAST match Shiki, including whitespace options and transformers");
