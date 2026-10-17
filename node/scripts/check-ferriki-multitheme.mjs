import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHighlighter as createShikiHighlighter } from "shiki";

import { createHighlighter, ShikiError } from "../ferriki/index.mjs";
import { comparisonCorpus } from "./shiki-comparison-corpus.mjs";
import { standardGrammarRegistrations } from "./standard-grammar-reference.mjs";

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
  assert.throws(
    () => highlighter.codeToHtml("\u001B[31mred\u001B[0m", { ...options, lang: "ansi" }),
    (error) => error instanceof ShikiError && error.code === "ERR_UNSUPPORTED",
  );
  const html = highlighter.codeToHtml("const answer: number = 42", options);
  assert.match(html, /class="shiki shiki-themes vitesse-light vitesse-dark"/);
  assert.match(html, /--shiki-light:/);
  assert.match(html, /--shiki-dark:/);

  let callbackToken;
  const callbackHtml = highlighter.codeToHtml("const answer: number = 42", {
    ...options,
    transformers: [
      {
        tokens(lines) {
          callbackToken = lines.flat().find((token) => token.content.startsWith("const"));
          return lines;
        },
      },
    ],
  });
  assert.match(callbackHtml, /--shiki-light:/);
  assert.match(callbackHtml, /--shiki-dark:/);
  assert(callbackToken.variants.light.color);
  assert(callbackToken.variants.dark.color);

  const lightOnly = highlighter.codeToHtml("const answer = 42", {
    lang: "typescript",
    themes: { light: "vitesse-light" },
    defaultColor: "light",
  });
  const lightWithUndefinedDark = highlighter.codeToHtml("const answer = 42", {
    lang: "typescript",
    themes: { light: "vitesse-light", dark: undefined },
    defaultColor: "light",
  });
  assert.equal(lightWithUndefinedDark, lightOnly);

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
  langs: standardGrammarRegistrations(comparisonCorpus.map(([lang]) => lang)),
  themes,
});
try {
  for (const [lang, code] of [
    ["typescript", "  const a = 1; \n\t// comment\n\nconst emoji = '😀';"],
    ["text", "plain <&> 😀\r\n  text"],
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
    }
  }
} finally {
  native.dispose();
  reference.dispose();
}
console.log("Multi-theme HTML matches Shiki, including whitespace options and transformers");

// Check the private fast path against the retained callback renderer. This
// covers presentation controls Ferriki owns beyond the Shiki parity matrix.
const { loadFerrikiNativeBinding } = await import("../ferriki/native.mjs");
const binding = loadFerrikiNativeBinding();
const prototype = binding.FerrikiHighlighter.prototype;
const nativeMethods = ["codeToHtmlWithThemes", "getHtmlRenderDataWithThemes"];
const originals = new Map(nativeMethods.map((name) => [name, prototype[name]]));
assert.equal(typeof originals.get("codeToHtmlWithThemes"), "function");
let nativeCalls = [];
for (const name of nativeMethods)
  prototype[name] = function (...args) {
    nativeCalls.push(name);
    return originals.get(name).apply(this, args);
  };
const darkName = 'multi-dark<&"';
const custom = await createHighlighter({
  langs: [
    {
      name: "multi-order",
      scopeName: "source.multi-order",
      patterns: [
        { match: "a", name: "letter.a" },
        { match: "b", name: "letter.b" },
        { match: "c", name: "letter.c" },
      ],
    },
  ],
  themes: [
    {
      name: "multi-light",
      fg: "#111111",
      bg: "#eeeeee",
      settings: [
        { scope: "letter.a", settings: { foreground: "#123456", fontStyle: "underline" } },
        { scope: "letter.b", settings: { fontStyle: "italic" } },
      ],
    },
    {
      name: darkName,
      fg: "#eeeeee",
      bg: "#111111",
      settings: [
        { scope: "letter.a", settings: { foreground: "#abcdef", fontStyle: "bold" } },
        { scope: "letter.b", settings: { fontStyle: "strikethrough underline" } },
      ],
    },
    {
      name: "multi-extra",
      fg: "#112233",
      bg: "#ddeeff",
      settings: [{ scope: "letter.c", settings: { fontStyle: "italic bold" } }],
    },
  ],
});
let comparisons = 0;
try {
  const configurations = [
    { themes: { light: "multi-light", dark: darkName } },
    { themes: { dark: darkName, light: "multi-light" }, defaultColor: "dark" },
    { themes: { dark: darkName, light: "multi-light", extra: "multi-extra" }, defaultColor: false },
    {
      themes: { light: "multi-light", dark: darkName, extra: "multi-extra" },
      defaultColor: "extra",
    },
    { themes: { dark: darkName, light: "multi-light" }, defaultColor: "light-dark()" },
    { themes: { light: "multi-light" }, defaultColor: "" },
  ];
  for (const source of [
    "",
    'a b c\t\n😀 é a<&"',
    " \t ",
    "a \u0085 b \uFEFF c",
    "a\r\nb\r\n",
    "a\uD800b",
  ])
    for (const configuration of configurations)
      for (const mergeWhitespaces of [false, true])
        for (const mergeSameStyleTokens of [false, true])
          for (const controls of [
            {},
            { rootStyle: false, tabindex: null },
            { rootStyle: "", tabindex: 2 },
            { rootStyle: 'color:var(--x-<&")', tabindex: '<&"' },
            { cssVariablePrefix: '--custom-<&"', tabindex: "" },
          ]) {
            const options = {
              lang: "multi-order",
              ...configuration,
              mergeWhitespaces,
              mergeSameStyleTokens,
              ...controls,
            };
            const expected = custom.codeToHtml(source, { ...options, transformers: [{}] });
            nativeCalls = [];
            assert.equal(
              custom.codeToHtml(source, options),
              expected,
              JSON.stringify({ source, options }),
            );
            assert.deepEqual(nativeCalls, ["codeToHtmlWithThemes"]);
            comparisons++;
          }
  for (const extra of [
    { rootStyle: "\uD800" },
    { tabindex: "\uDC00" },
    { cssVariablePrefix: "--\uD800" },
    { themes: { light: "multi-light", dark: "none" } },
    { structure: "inline" },
    { decorations: [] },
    { transformers: [{}] },
  ]) {
    const options = {
      lang: "multi-order",
      themes: { light: "multi-light", dark: darkName },
      ...extra,
    };
    const expected = custom.codeToHtml("a b c", { ...options, transformers: [{}] });
    nativeCalls = [];
    assert.equal(custom.codeToHtml("a b c", options), expected);
    assert(!nativeCalls.includes("codeToHtmlWithThemes"));
  }
  // A previous sidecar must still use the existing host path.
  prototype.codeToHtmlWithThemes = undefined;
  const options = { lang: "multi-order", themes: { light: "multi-light", dark: darkName } };
  assert.equal(
    custom.codeToHtml("a b c", options),
    custom.codeToHtml("a b c", { ...options, transformers: [{}] }),
  );
} finally {
  custom.dispose();
  for (const [name, original] of originals) prototype[name] = original;
}
console.log(
  `Native multi-theme HTML matches the callback renderer (${comparisons} cases); fast-path and fallback transport verified`,
);
