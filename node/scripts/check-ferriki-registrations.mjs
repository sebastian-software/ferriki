import assert from "node:assert/strict";

import { createHighlighter, createHighlighterCoreSync, ShikiError } from "../ferriki/index.mjs";

const language = {
  name: "ferriki-registration",
  scopeName: "source.ferriki-registration",
  aliases: ["freg", "js"],
  patterns: [{ match: "\\bTODO\\b", name: "keyword.todo.ferriki" }],
};
const theme = {
  name: "ferriki-registration-theme",
  type: "light",
  fg: "#111111",
  bg: "#ffffff",
  settings: [
    {
      scope: "keyword.todo.ferriki",
      settings: { foreground: "#ff00aa", fontStyle: "bold" },
    },
  ],
};
const includedTheme = {
  name: "ferriki-registration-theme-included",
  include: "nord",
  settings: [
    {
      scope: "keyword.todo.ferriki",
      settings: { foreground: "#00aaff" },
    },
  ],
};
const childLanguage = {
  name: "ferriki-registration-child",
  scopeName: "source.ferriki-registration-child",
  patterns: [{ match: "\\bCHILD\\b", name: "keyword.child" }],
};
const parentLanguage = {
  name: "ferriki-registration-parent",
  scopeName: "source.ferriki-registration-parent",
  embeddedLangs: ["ferriki-registration-child"],
  patterns: [{ include: "source.ferriki-registration-child" }],
};
const injectionLanguage = {
  name: "ferriki-registration-injection",
  scopeName: "source.ferriki-registration-injection",
  injectTo: ["source.js"],
  patterns: [{ match: "\\bINJECTED\\b", name: "keyword.injected" }],
};

const highlighter = await createHighlighter({
  langs: [language],
  themes: [theme],
});
try {
  const html = highlighter.codeToHtml("TODO", {
    lang: "freg",
    theme: "ferriki-registration-theme",
  });
  assert.match(html, /ff00aa/i);

  const direct = highlighter.codeToHast("TODO", { lang: language, theme });
  assert.equal(direct.type, "root");
  const tokens = highlighter.codeToTokens("TODO", {
    lang: "ferriki-registration",
    theme,
  });
  assert.equal(tokens.tokens[0][0].content, "TODO");
  assert.equal(tokens.tokens[0][0].color?.toLowerCase(), "#ff00aa");

  highlighter.loadThemeSync(includedTheme);
  const included = highlighter.codeToHtml("TODO", {
    lang: "ferriki-registration",
    theme: "ferriki-registration-theme-included",
  });
  assert.match(included, /00aaff/i);

  // A user alias matching a standard alias must not hide the standard
  // catalog entry, even when the custom registration is loaded first.
  await highlighter.loadLanguage("js");
  assert(highlighter.getLoadedLanguages().includes("javascript"));

  assert.throws(
    () =>
      highlighter.loadLanguageSync({
        name: "invalid-registration",
        scopeName: "source.invalid-registration",
        patterns: [],
        unsupportedField: true,
      }),
    (error) =>
      error instanceof ShikiError && /Unsupported language registration field/.test(error.message),
  );
} finally {
  highlighter.dispose();
}

const grammarHighlighter = await createHighlighter({
  langs: [parentLanguage, childLanguage, injectionLanguage, "javascript"],
  themes: ["nord"],
});
try {
  const child = grammarHighlighter.codeToHtml("CHILD", {
    lang: "ferriki-registration-parent",
    theme: "nord",
  });
  assert.match(child, /CHILD/);
  const injected = grammarHighlighter.codeToHtml("INJECTED", {
    lang: "javascript",
    theme: "nord",
  });
  assert.match(injected, /INJECTED/);
} finally {
  grammarHighlighter.dispose();
}

const asyncHighlighter = await createHighlighter({
  langs: [async () => [language]],
  themes: [async () => theme],
});
asyncHighlighter.dispose();

assert.throws(
  () => createHighlighterCoreSync({ langs: [() => language] }),
  (error) => error instanceof ShikiError && /Async language\/theme input/.test(error.message),
);

console.log("Ferriki custom language/theme registrations verified");
