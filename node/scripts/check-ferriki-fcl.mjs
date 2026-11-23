import assert from "node:assert/strict";
import { createHighlighter } from "../ferriki/index.mjs";
import { createEngine, theme } from "./tiobe-benchmark.mjs";
import "./test-asset-env.mjs";

// The first record mirrors Ferrocat's catalog examples. Subsequent records
// cover empty fields, escapes and nested ICU without crossing field boundaries.
const code = [
  "%FCL1\tsource=en\tlocale=de\torder=collated",
  "Hello {name}\tgreeting\tHallo {name}\tr=src/App.tsx#Checkout\tc=note\\nline\ttc=review\tf=fuzzy\to\tlock=abc\tai=model:0.9",
  "{count, plural, one {#\\n item} other {# items}}\t\t{count, select, one {eins} other {mehr}}",
  "back\\\\slash\\tfield\\nnext\tctx\\tvalue\t",
  "{broken, plural, one {x\tcontext\ttarget",
  // Ferrocat docs/app/routes/reference/api-overview.mdx.
  "Hello\t\tHallo\tlock=<hash>\tai=openai/gpt-5.5-high:0.95",
  "legacy\\r\tctx\t{count, plural, one {#\\r} other {#}}",
].join("\n");
const highlighter = await createHighlighter({
  langs: ["fcl"],
  themes: ["github-light-default", theme],
});
const reference = await createEngine("shiki-wasm", { textmate: "fcl" });
try {
  assert.equal(highlighter.codeToHtml(code, { lang: "fcl", theme }), reference.html(code));
  let lines;
  highlighter.codeToHtml(code, {
    lang: "fcl",
    theme: "github-light-default",
    styleMode: "classes",
    includeExplanation: "scopeName",
    mergeWhitespaces: false,
    mergeSameStyleTokens: false,
    transformers: [
      {
        tokens(value) {
          lines = value;
          return value;
        },
      },
    ],
  });
  assert(lines, "expected scoped tokens");
  const lineText = (line) => lines[line].map((token) => token.content).join("");
  for (const [index, line] of code.split("\n").entries()) assert.equal(lineText(index), line);
  function scopesAt(line, column) {
    let cursor = 0;
    for (const token of lines[line]) {
      const end = cursor + token.content.length;
      if (column < end) return token.scopeNames ?? [];
      cursor = end;
    }
    throw new Error(`Missing token at ${line}:${column}`);
  }
  function expectScope(line, text, scope, occurrence = 0) {
    const source = lineText(line);
    let offset = -1;
    for (let n = 0; n <= occurrence; n++) offset = source.indexOf(text, offset + 1);
    assert(offset >= 0, `missing ${JSON.stringify(text)} on line ${line}`);
    for (let i = 0; i < text.length; i++)
      assert(scopesAt(line, offset + i).includes(scope), `${line}:${offset + i} missing ${scope}`);
  }
  expectScope(0, "%FCL1", "keyword.control.header.fcl");
  for (const [index, line] of code.split("\n").entries())
    for (let column = 0; column < line.length; column++)
      if (line[column] === "\t")
        assert(
          scopesAt(index, column).includes("punctuation.separator.tab.fcl"),
          `tab ${index}:${column}`,
        );
  for (const tag of ["source", "locale", "order"])
    expectScope(0, tag, "entity.other.attribute-name.fcl");
  for (const tag of ["r", "c", "tc", "f", "lock", "ai"]) {
    const text = `${tag}=`;
    const index = lineText(1).indexOf(`\t${text}`);
    assert(index >= 0, `missing ${tag}`);
    assert(scopesAt(1, index + 1).includes("entity.other.attribute-name.fcl"), tag);
  }
  assert(scopesAt(1, lineText(1).indexOf("\to\t") + 1).includes("constant.language.flag.fcl"));
  expectScope(1, "Hello", "string.unquoted.id.fcl");
  expectScope(1, "greeting", "string.unquoted.context.fcl");
  expectScope(1, "Hallo", "string.unquoted.target.fcl");
  expectScope(1, "note", "string.unquoted.tag-value.fcl");
  expectScope(1, "\\n", "constant.character.escape.fcl");
  expectScope(1, "name", "variable.parameter.icu-message", 0);
  expectScope(1, "name", "variable.parameter.icu-message", 1);
  expectScope(2, "plural", "storage.type.icu-message");
  expectScope(2, "select", "storage.type.icu-message");
  expectScope(2, "other", "constant.language.selector.icu-message");
  expectScope(2, "#", "constant.language.pound.icu-message");
  expectScope(2, "\\n", "constant.character.escape.icu-message");
  for (const escape of ["\\\\", "\\t", "\\n"])
    expectScope(3, escape, "constant.character.escape.fcl");
  expectScope(4, "context", "string.unquoted.context.fcl");
  expectScope(4, "target", "string.unquoted.target.fcl");
  expectScope(5, "Hello", "string.unquoted.id.fcl");
  expectScope(5, "Hallo", "string.unquoted.target.fcl");
  expectScope(6, "\\r", "invalid.illegal.escape.fcl");
  expectScope(6, "\\r", "invalid.illegal.escape.fcl", 1);

  const current = [
    "%FCL2\tsource=en\tlocale=de\torder=collated",
    "Hello {name}\tn\tHallo {name}\tc=Zeile\\rEnde",
    "{count, plural, one {#\\r item} other {# items}}\tsgreeting\tWert\\rEnde",
    "Empty\ts\tLeer",
    // Updated Ferrocat API reference example, shown as an ordinary FCL fence.
    "Hello {name}\tn\tHallo {name}\tlock=<hash>\tai=openai/gpt-5.5-high:0.95",
  ].join("\r\n");
  assert.equal(highlighter.codeToHtml(current, { lang: "fcl", theme }), reference.html(current));
  highlighter.codeToHtml(current, {
    lang: "fcl",
    theme: "github-light-default",
    styleMode: "classes",
    includeExplanation: "scopeName",
    transformers: [
      {
        tokens(value) {
          lines = value;
          return value;
        },
      },
    ],
  });
  for (const [index, line] of current.split("\r\n").entries()) assert.equal(lineText(index), line);
  expectScope(0, "%FCL2", "keyword.control.header.fcl");
  expectScope(1, "n", "constant.language.context.fcl", 1);
  expectScope(2, "sgreeting", "string.unquoted.context.fcl");
  assert(
    scopesAt(2, lineText(2).indexOf("\tsgreeting") + 1).includes("constant.language.context.fcl"),
  );
  assert(scopesAt(3, lineText(3).indexOf("\ts\t") + 1).includes("constant.language.context.fcl"));
  expectScope(1, "\\r", "constant.character.escape.fcl");
  expectScope(2, "\\r", "constant.character.escape.icu-message");
  expectScope(2, "\\r", "constant.character.escape.fcl", 1);
  expectScope(4, "Hallo", "string.unquoted.target.fcl");
  expectScope(4, "name", "variable.parameter.icu-message", 0);
  expectScope(4, "name", "variable.parameter.icu-message", 1);
  for (const [index, line] of current.split("\r\n").entries())
    for (let column = 0; column < line.length; column++)
      if (line[column] === "\t")
        assert(scopesAt(index, column).includes("punctuation.separator.tab.fcl"));
} finally {
  highlighter.dispose();
  reference.dispose();
}
console.log("FCL fields, tabs, metadata, escapes and embedded ICU verified");
