import assert from "node:assert/strict";
import { createHighlighter, createHighlighterCoreSync, ShikiError } from "../ferriki/index.mjs";
import { loadFerrikiNativeBinding } from "../ferriki/native.mjs";
import "./test-asset-env.mjs";

const highlighter = await createHighlighter({
  langs: ["javascript"],
  themes: ["nord", "github-light-default"],
});
const binding = loadFerrikiNativeBinding();
const prototype = binding.FerrikiHighlighter.prototype;
let calls = [];
const originals = new Map();
for (const name of ["codeToHtmlWithDecorations", "getHtmlRenderData"]) {
  const original = prototype[name];
  originals.set(name, original);
  prototype[name] = function (...args) {
    const result = original.apply(this, args);
    calls.push({ name, completed: result !== null && result !== undefined });
    return result;
  };
}
const source = Array.from({ length: 12 }, (_, i) => `const value${i} = "β😀 <&>";`).join("\n");
const rows = source.split("\n");
const cases = [
  {
    name: "lines-4-through-10",
    source,
    decorations: [
      {
        start: { line: 3, character: 0 },
        end: { line: 9, character: rows[9].length },
        properties: { class: "selected" },
      },
    ],
  },
  {
    name: "word-and-attributes",
    source: "const value = '<&>';",
    decorations: [
      {
        start: 6,
        end: 11,
        properties: { class: "mark mark extra", title: '<&"', "data-mark": "yes" },
      },
    ],
  },
  {
    name: "nested",
    source: "alpha beta",
    decorations: [
      { start: 0, end: 10, alwaysWrap: true, properties: { class: "outer" } },
      { start: 1, end: 4, tagName: "strong", properties: { class: "inner" } },
    ],
  },
  {
    name: "equal-start",
    source: "alpha beta",
    decorations: [
      { start: 1, end: 4, alwaysWrap: true, properties: { class: "first" } },
      { start: 1, end: 7, alwaysWrap: true, properties: { class: "second" } },
    ],
  },
  {
    name: "empty-range",
    source: "alpha",
    decorations: [{ start: 2, end: 2, properties: { class: "empty" } }],
  },
  {
    name: "unicode",
    source: "a😀z",
    decorations: [{ start: 1, end: 3, properties: { class: "emoji" } }],
  },
  {
    name: "crlf-negative-column",
    source: "alpha\r\nbeta",
    decorations: [
      {
        start: { line: 0, character: -2 },
        end: { line: 1, character: -1 },
        properties: { class: "multi" },
      },
    ],
  },
];
let compared = 0;
try {
  for (const scenario of cases)
    for (const theme of ["nord", "github-light-default"])
      for (const extra of [
        {},
        { mergeWhitespaces: false, mergeSameStyleTokens: true },
        { rootStyle: false, tabindex: null },
        { rootStyle: "", tabindex: 2 },
      ]) {
        const options = { lang: "javascript", theme, decorations: scenario.decorations, ...extra };
        const expected = highlighter.codeToHtml(scenario.source, {
          ...options,
          transformers: [{}],
        });
        calls = [];
        const actual = highlighter.codeToHtml(scenario.source, options);
        assert.equal(actual, expected, `${scenario.name}/${theme}/${JSON.stringify(extra)}`);
        assert.deepEqual(
          calls,
          [{ name: "codeToHtmlWithDecorations", completed: true }],
          scenario.name,
        );
        if (scenario.name === "lines-4-through-10") {
          assert.equal(actual.match(/class="selected"/gu)?.length, 7);
          assert.equal(actual.match(/class="line"/gu)?.length, 5);
        }
        compared++;
      }
  const fallbackCases = [
    {
      source: "alpha",
      decorations: [{ start: 1, end: 4, properties: { class: ["mark", "extra"] } }],
    },
    {
      source: "alpha",
      decorations: [{ start: 1, end: 4, properties: { style: { color: "red" } } }],
    },
    { source: "a\uD800z", decorations: [{ start: 1, end: 2, properties: { class: "lone" } }] },
    { source: "alpha", decorations: [{ start: 1, end: 4, properties: { title: "\uD800" } }] },
    { source: "a\uFEFFb", decorations: [{ start: 0, end: 3, properties: { class: "bom" } }] },
    { source: "a\u0085b", decorations: [{ start: 0, end: 3, properties: { class: "nel" } }] },
    {
      source: "alpha",
      decorations: [{ start: 1, end: 4, properties: { 0: "first", title: "second" } }],
    },
    {
      source: "alpha",
      decorations: [
        {
          start: 1,
          end: 4,
          transform(node) {
            node.properties.title = "callback";
            return node;
          },
        },
      ],
    },
  ];
  for (const scenario of fallbackCases) {
    const options = { lang: "text", theme: "nord", decorations: scenario.decorations };
    const expected = highlighter.codeToHtml(scenario.source, { ...options, transformers: [{}] });
    calls = [];
    assert.equal(highlighter.codeToHtml(scenario.source, options), expected);
    assert.deepEqual(
      calls.map((call) => call.name),
      ["getHtmlRenderData"],
    );
  }
  const half = {
    lang: "text",
    theme: "nord",
    decorations: [{ start: 2, end: 3, properties: { class: "half" } }],
  };
  const expected = highlighter.codeToHtml("a😀z", { ...half, transformers: [{}] });
  calls = [];
  assert.equal(highlighter.codeToHtml("a😀z", half), expected);
  assert.deepEqual(calls, [
    { name: "codeToHtmlWithDecorations", completed: false },
    { name: "getHtmlRenderData", completed: true },
  ]);
  for (const extra of [
    { transformers: [{}] },
    { structure: "inline" },
    { styleMode: "classes" },
    { themes: { light: "github-light-default", dark: "nord" } },
    { theme: "none" },
    { meta: { title: "block" } },
  ]) {
    calls = [];
    highlighter.codeToHtml("alpha", {
      lang: "text",
      theme: "nord",
      decorations: [{ start: 0, end: 5, properties: { class: "mark" } }],
      ...extra,
    });
    assert(!calls.some((call) => call.name === "codeToHtmlWithDecorations"));
  }
  let reads = 0;
  const properties = {
    get class() {
      reads++;
      return "mark";
    },
  };
  const options = { lang: "text", theme: "nord", decorations: [{ start: 0, end: 5, properties }] };
  const baseline = highlighter.codeToHtml("alpha", { ...options, transformers: [{}] });
  const expectedReads = reads;
  reads = 0;
  calls = [];
  assert.equal(highlighter.codeToHtml("alpha", options), baseline);
  assert.equal(reads, expectedReads);
  assert(!calls.some((call) => call.name === "codeToHtmlWithDecorations"));
  for (const decorations of [
    [{ start: 4, end: 1 }],
    [{ start: 0, end: 6 }],
    [
      { start: 0, end: 4 },
      { start: 2, end: 5 },
    ],
  ])
    assert.throws(
      () => highlighter.codeToHtml("alpha", { lang: "text", theme: "nord", decorations }),
      (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
    );
  assert.throws(
    () =>
      highlighter.codeToHtml("", {
        lang: "text",
        theme: "nord",
        decorations: [{ start: 0, end: 0 }],
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  calls = [];
  assert.throws(
    () =>
      highlighter.codeToHtml("alpha", {
        lang: "text",
        theme: "nord",
        decorations: [{ start: 1, end: 4, transform: false }],
      }),
    TypeError,
  );
  assert(!calls.some((call) => call.name === "codeToHtmlWithDecorations"));
  assert.throws(
    () =>
      highlighter.codeToHtml("const value = 1", {
        lang: "javascript",
        theme: "nord",
        tokenizeMaxLineLength: 1,
        decorations: [{ start: 6, end: 11, properties: { class: "mark" } }],
      }),
    (error) => error.code === "ERR_RESOURCE_LIMIT",
  );
  const defaults = createHighlighterCoreSync({
    transformers: [
      {
        line(node) {
          node.properties.title = "default";
        },
      },
    ],
  });
  try {
    calls = [];
    assert.match(
      defaults.codeToHtml("alpha", {
        lang: "text",
        theme: "nord",
        decorations: [{ start: 0, end: 5 }],
      }),
      /title="default"/u,
    );
    assert(!calls.some((call) => call.name === "codeToHtmlWithDecorations"));
    calls = [];
    defaults.codeToHtml("alpha", {
      lang: "text",
      theme: "nord",
      transformers: [],
      decorations: [{ start: 0, end: 5 }],
    });
    assert.deepEqual(calls, [{ name: "codeToHtmlWithDecorations", completed: true }]);
  } finally {
    defaults.dispose();
  }
  console.log(
    `Native declarative rendering matches ${compared} callback-path outputs; line markers, one render call, fallback, and error contracts verified`,
  );
} finally {
  for (const [name, original] of originals) prototype[name] = original;
  highlighter.dispose();
}
