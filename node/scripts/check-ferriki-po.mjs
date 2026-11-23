import assert from "node:assert/strict";
import { fromHtml } from "hast-util-from-html";
import { createHighlighter } from "../ferriki/index.mjs";
import { createEngine, theme } from "./tiobe-benchmark.mjs";
import "./test-asset-env.mjs";

// Ferrocat crates/ferrocat-po/tests/fixtures/three-way/complex.base.po.
const ferrocat =
  'msgid "{count, plural, one {One file} other {# files}}"\nmsgstr "{count, plural, one {Eine Datei} other {# Dateien}}"';
const fixtures = [
  ferrocat,
  'msgctxt "context"\nmsgid "{name}"\nmsgid_plural "{count, number}"\nmsgstr[0] "{n, date}"\nmsgstr[1] "{n, time}"',
  'msgid "{gender, select, other {# literal}}"\nmsgstr "{n, selectordinal, =0 {none} other {# files}}"',
  'msgid ""\n"{"\n"count, "\n"plural, one "\n"{# item} other {# items}}"\nmsgstr "\\"quoted\\"\\n"',
  '# translator\n#. extracted\n#: src.rs:1\n#, fuzzy\n#| msgid "previous"\n#~ msgid "obsolete"\nmsgid "{n, plural, other {unfinished"\nmsgstr "{name}"\n\nmsgid "next"\nmsgstr "end"',
  "msgid \"ordinary apostrophe isn't a quote, '{literal}' and '' escaped\"\nmsgstr \"{name}\"",
  'msgid "{date} {time} {select} {plural, number}"\nmsgstr "{gender, select, other {\'#\' literal}}"',
  // Ferrocat crates/ferrocat-bench/fixtures/stress.po, header.
  'msgid ""\nmsgstr ""\n"Project-Id-Version: Test\\n"\n"Plural-Forms: nplurals=3; plural=(n != 1);\\n"\n\nmsgid "hello"\nmsgstr "world"',
  'msgid "{count,\tplural, one {# item} other {# items}} {user.name} {größe}"\nmsgstr "{n, plural, other {{gender, select, female {# files} other {# files}}}}"',
  'msgid "{count, plu"\n"ral, other {# files}}"\nmsgstr "next"',
];
const highlighter = await createHighlighter({ langs: ["po"], themes: [theme] });
const reference = await createEngine("shiki-wasm", { textmate: "po", embedded: ["icu-message"] });
function leaves(code) {
  const html = highlighter.codeToHtml(code, { lang: "po", theme, styleMode: "classes" });
  const result = [];
  function visit(node, parents = []) {
    const classes = [...parents, ...(node.properties?.className ?? [])];
    if (node.type === "text" && node.value) result.push({ text: node.value, classes });
    for (const child of node.children ?? []) visit(child, classes);
  }
  visit(fromHtml(html, { fragment: true }));
  return result;
}
function has(tokens, text, scope) {
  assert(
    tokens.some(
      (token) => token.text.includes(text) && token.classes.some((value) => value.includes(scope)),
    ),
    `${JSON.stringify(text)} missing ${scope}: ${JSON.stringify(tokens)}`,
  );
}
try {
  for (const code of fixtures) {
    assert.equal(highlighter.codeToHtml(code, { lang: "po", theme }), reference.html(code), code);
  }
  const actual = leaves(ferrocat);
  for (const [text, scope] of [
    ["msgid", "keyword-control-msgid"],
    ["msgstr", "keyword-control-msgstr"],
    ["count", "variable-parameter-icu"],
    ["plural", "storage-type-icu"],
    ["one", "constant-language-selector-icu"],
    ["other", "constant-language-selector-icu"],
    ["#", "constant-language-pound-icu"],
  ])
    has(actual, text, scope);
  const select = leaves(fixtures[2]);
  const literal = select.find((token) => token.text.includes("# literal"));
  assert(
    literal && !literal.classes.some((value) => value.includes("constant-language-pound-icu")),
  );
  const split = leaves(fixtures[3]);
  for (const [text, scope] of [
    ["count", "variable-parameter-icu"],
    ["plural", "storage-type-icu"],
    ["one", "constant-language-selector-icu"],
    ["#", "constant-language-pound-icu"],
    ['\\"', "constant-character-escape-po"],
  ])
    has(split, text, scope);
  const recovery = leaves(fixtures[4]);
  for (const [text, scope] of [
    ["msgstr", "keyword-control-msgstr"],
    ["name", "variable-parameter-icu"],
    ["next", "string-quoted-double-po"],
    ["obsolete", "comment-line-number_2d_sign-obsolete-po"],
  ])
    has(recovery, text, scope);
  const next = recovery.find((token) => token.text === "next");
  assert(
    !next.classes.some((value) => value.includes("meta-argument-icu")),
    "ICU scope leaked into next entry",
  );
  const names = leaves(fixtures[6]);
  for (const name of ["date", "time", "select", "plural"])
    has(names, name, "variable-parameter-icu");
  has(names, "number", "storage-type-icu");
  const hash = names.find((token) => token.text.includes("'#'"));
  assert(
    hash &&
      !hash.classes.some(
        (value) => value.includes("quoted-single-icu") || value.includes("pound-icu"),
      ),
  );
  const header = leaves(fixtures[7]);
  has(header, "Project-Id-Version", "constant-language-po");
  has(header, "Test", "meta-header-po");
  has(header, "msgid", "keyword-control-msgid-po");
  has(header, "msgstr", "keyword-control-msgstr-po");
  has(header, '""', "string-quoted-double-po");
  assert(
    !header.some(
      (token) =>
        (token.text === "msgid" || token.text === "msgstr") &&
        token.classes.some((value) => value.includes("comment-line")),
    ),
  );
  const extended = leaves(fixtures[8]);
  has(extended, "plural", "storage-type-icu");
  has(extended, "user.name", "variable-parameter-icu");
  has(extended, "größe", "variable-parameter-icu");
  assert(
    extended.filter(
      (token) =>
        token.text.includes("#") &&
        token.classes.some((value) => value.includes("constant-language-pound-icu")),
    ).length >= 4,
  );
  // TextMate tokenizes one physical line at a time, so a keyword split across
  // gettext strings cannot be identified as one ICU type.
  const splitKeyword = leaves(fixtures[9]);
  assert(
    !splitKeyword.some(
      (token) =>
        (token.text.includes("plu") || token.text.includes("ral")) &&
        token.classes.some((value) => value.includes("storage-type-icu")),
    ),
  );
  has(splitKeyword, "msgstr", "keyword-control-msgstr");
  assert.equal(
    highlighter.codeToHtml(ferrocat, { lang: "pot", theme }),
    highlighter.codeToHtml(ferrocat, { lang: "po", theme }),
  );
} finally {
  highlighter.dispose();
  reference.dispose();
}
console.log(`Gettext and embedded ICU verified against WASM: ${fixtures.length} fixtures`);
