import assert from "node:assert/strict";
import {
  codeToHtml,
  createHighlighterCoreSync,
  FerrikiError,
  ShikiError,
} from "../ferriki/index.mjs";

function hasCode(code) {
  return (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, code);
    return true;
  };
}

assert.throws(() => createHighlighterCoreSync({ langs: "javascript" }), hasCode("ERR_USAGE"));
assert.throws(
  () => createHighlighterCoreSync({ langAlias: { javascript: 42 } }),
  hasCode("ERR_USAGE"),
);

const highlighter = createHighlighterCoreSync({
  langs: ["javascript"],
  themes: ["nord"],
});

assert.throws(
  () =>
    highlighter.codeToHtml("const answer = 42", {
      lang: "javascript",
      theme: "nord",
      tokenizeTimeLimit: -1,
    }),
  hasCode("ERR_USAGE"),
);
assert.throws(
  () =>
    highlighter.codeToHtml("const answer = 42", { lang: "javascript", theme: "nord", engine: {} }),
  hasCode("ERR_UNSUPPORTED"),
);
assert.throws(
  () =>
    highlighter.codeToHtml("const answer = 42", {
      lang: "missing-ferriki-language",
      theme: "nord",
    }),
  hasCode("ERR_UNSUPPORTED"),
);
assert.throws(
  () => highlighter.codeToHtml("\u001B[31mred\u001B[0m", { lang: "ansi", theme: "nord" }),
  hasCode("ERR_UNSUPPORTED"),
);

assert.throws(
  () =>
    highlighter.loadLanguageSync({
      name: "broken",
      scopeName: "source.broken",
      patterns: "not-an-array",
    }),
  hasCode("ERR_USAGE"),
);
assert.throws(
  () =>
    highlighter.loadLanguageSync({
      name: "broken-native",
      scopeName: "source.broken",
      patterns: [{ match: 5 }],
    }),
  (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, "ERR_ASSET");
    assert(error.cause instanceof Error);
    return true;
  },
);
assert.throws(
  () => highlighter.codeToHtml("const answer = 42", { lang: "javascript" }),
  hasCode("ERR_USAGE"),
);
const limited = highlighter.codeToTokens("const answer = 42", {
  lang: "javascript",
  theme: "nord",
  tokenizeMaxLineLength: 4,
});
assert.equal(limited.tokens[0][0].color, "");

const rendered = await codeToHtml("const answer = 42", { lang: "javascript", theme: "nord" });
assert(rendered.includes("const"));

highlighter.dispose();
assert.throws(
  () => highlighter.codeToHtml("const answer = 42", { lang: "javascript", theme: "nord" }),
  hasCode("ERR_USAGE"),
);

const internal = new FerrikiError("internal failure", "ERR_INTERNAL");
assert(internal instanceof ShikiError);
assert.equal(internal.name, "FerrikiError");
assert.equal(internal.code, "ERR_INTERNAL");

console.log("Ferriki error taxonomy and recovery verified");
