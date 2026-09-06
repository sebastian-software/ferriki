import assert from "node:assert/strict";
import { createHighlighter, ShikiError } from "../ferriki/index.mjs";

const highlighter = await createHighlighter({
  langs: ["javascript", "typescript"],
  themes: ["nord"],
});

try {
  const explained = highlighter.codeToTokens("const 😀 = 1\r\n", {
    lang: "javascript",
    theme: "nord",
    includeExplanation: "scopeName",
  });
  const first = explained.tokens[0][0];
  assert.equal(first.content, "const");
  assert.equal(first.offset, 0);
  assert(first.explanation?.[0]?.scopes.some((scope) => scope.scopeName === "source.js"));
  assert.equal("scopeNames" in first, false);

  const typed = highlighter.codeToTokens("const x = 1", {
    lang: "javascript",
    theme: "nord",
    includeExplanation: "tokenType",
  });
  assert.equal(typed.tokens[0][0].explanation, undefined);
  assert.equal(typeof typed.tokens[0][0].type, "number");

  const state = highlighter.getLastGrammarState('const value = "', {
    lang: "javascript",
    theme: "nord",
  });
  const roundTripped = JSON.parse(JSON.stringify(state));
  assert.deepEqual(roundTripped, state);
  const natural = highlighter.codeToTokens('text"', {
    lang: "javascript",
    theme: "nord",
  });
  const continued = highlighter.codeToTokens('text"', {
    lang: "javascript",
    theme: "nord",
    grammarState: roundTripped,
  });
  assert.notDeepEqual(continued.tokens, natural.tokens);
  assert.deepEqual(
    continued,
    highlighter.codeToTokens('text"', {
      lang: "javascript",
      theme: "nord",
      grammarState: roundTripped,
    }),
  );

  assert.throws(
    () =>
      highlighter.codeToTokens("x", {
        lang: "typescript",
        theme: "nord",
        grammarState: state,
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  assert.throws(
    () =>
      highlighter.codeToTokens("x", {
        lang: "javascript",
        theme: "nord",
        grammarState: { lang: "javascript", themes: ["nord"] },
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );

  const themes = highlighter.codeToTokens("let value = 1", {
    lang: "javascript",
    themes: { light: "nord", dark: "nord" },
  });
  assert(themes.grammarState);
  assert.equal(themes.tokens[0][0].variants.light.color, themes.tokens[0][0].variants.dark.color);
} finally {
  highlighter.dispose();
}

console.log("Ferriki token explanation and grammar-state contract verified");
