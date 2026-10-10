import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { loadFerrikiNativeBinding } from "../ferriki/native.mjs";
import "./test-asset-env.mjs";

// --capture /absolute/path/to/baseline/index.mjs records the original runtime.
// Normal CI compares the current native binding with that frozen public output.
const captureIndex = process.argv.indexOf("--capture");
const capture = captureIndex >= 0;
const moduleUrl = capture
  ? pathToFileURL(process.argv[captureIndex + 1])
  : new URL("../ferriki/index.mjs", import.meta.url);
const { createHighlighter, createHighlighterCoreSync, ShikiError } = await import(moduleUrl.href);
const highlighter = await createHighlighter({
  langs: ["javascript"],
  themes: ["nord", "github-light-default"],
});
const cases = [];
const source = "alpha β😀\r\nbeta <&>\n";
const add = (name, code, decorations, mode = "plain") =>
  cases.push({ name, code, decorations, mode });
add("single", "alpha beta", [
  { start: 1, end: 4, properties: { class: ["mark", "mark", "extra"], title: '<&"' } },
]);
add("whole-line", "alpha", [{ start: 0, end: 5, properties: { class: "mark" } }]);
add("forced-wrapper", "alpha", [
  { start: 0, end: 5, alwaysWrap: true, tagName: "strong", properties: { class: "mark" } },
]);
add("nested", "alpha beta", [
  { start: 0, end: 10, alwaysWrap: true, properties: { class: "outer" } },
  { start: 1, end: 4, properties: { class: "inner" } },
]);
add("equal-start", "alpha beta", [
  { start: 1, end: 4, alwaysWrap: true, properties: { class: "first" } },
  { start: 1, end: 7, alwaysWrap: true, properties: { class: "second" } },
]);
add("touching", "alpha beta", [
  { start: 0, end: 5, properties: { class: "left" } },
  { start: 5, end: 10, properties: { class: "right" } },
]);
add("empty-range", "alpha", [{ start: 2, end: 2, properties: { class: "empty" } }]);
add("empty-source", "", [{ start: 0, end: 0, properties: { class: "empty" } }]);
add("multiline", source, [
  {
    start: { line: 0, character: 1 },
    end: { line: 2, character: 0 },
    properties: { class: "multi" },
  },
]);
add("negative-column", source, [
  {
    start: { line: 0, character: -2 },
    end: { line: 1, character: -1 },
    properties: { class: "negative" },
  },
]);
add("surrogate-boundary", "a😀z", [{ start: 2, end: 3, properties: { class: "half" } }]);
add("lone-surrogate", "a\uD800z", [{ start: 1, end: 2, properties: { class: "lone" } }]);
add("javascript", "const value = '<&>';\nvalue++;", [
  {
    start: 6,
    end: 11,
    properties: { class: "name", style: { color: "red" }, "data-value": ["x", "y"] },
  },
]);
add("stage-order", "alpha beta", [{ start: 1, end: 4, properties: { class: "mark" } }], "hooks");
add(
  "preprocessed-source",
  "alpha",
  [{ start: 1, end: 4, properties: { class: "mark" } }],
  "preprocess",
);
add(
  "changed-token-content",
  "alpha beta",
  [{ start: 1, end: 4, properties: { class: "mark" } }],
  "tokens",
);
add(
  "changed-span-tree",
  "alpha beta",
  [{ start: 1, end: 4, properties: { class: "mark" } }],
  "span",
);
add(
  "reordered-lines",
  "alpha\nbeta",
  [{ start: 1, end: 4, properties: { class: "mark" } }],
  "code",
);
add(
  "decoration-callback",
  "alpha beta",
  [{ start: 1, end: 4, properties: { class: "mark" } }],
  "decoration",
);
add(
  "callback-changes-next-section",
  "alpha\nbeta\ngamma",
  [{ start: 1, end: 14, properties: { class: "multi" } }],
  "mutating-decoration",
);
add(
  "callback-replaces-line",
  "alpha\nbeta",
  [
    { start: 0, end: 5, properties: { class: "first" } },
    { start: 0, end: 5, properties: { class: "second" } },
  ],
  "replacement",
);
add("callback-throws", "alpha", [{ start: 1, end: 4 }], "throwing");
add(
  "crossing-error",
  "alpha beta",
  [
    { start: 0, end: 6 },
    { start: 3, end: 10 },
  ],
  "hooks",
);
add("reverse-error", "alpha", [{ start: 4, end: 1 }]);
add("line-error", "alpha", [{ start: { line: 1, character: 0 }, end: 3 }]);
add("column-error", "alpha\r\n", [{ start: { line: 0, character: 6 }, end: 6 }]);
add("offset-error", "alpha", [{ start: 0, end: 6 }]);
add(
  "boundary-after-hook-error",
  "alpha beta",
  [
    { start: 0, end: 2, properties: { class: "later" } },
    { start: 6, end: 8, properties: { class: "earlier" } },
  ],
  "shrinking",
);

add(
  "shared-output-nodes",
  "alpha\nalpha",
  [
    { start: 1, end: 4, alwaysWrap: true, properties: { class: "first" } },
    { start: 7, end: 10, alwaysWrap: true, properties: { class: "second" } },
  ],
  "shared",
);

add("callback-changes-wrapping", "alpha\nbeta\ngamma", [{ start: 1, end: 14 }], "wrapping");
add("callback-changes-own-bounds", "alpha\nbeta\ngamma", [{ start: 1, end: 14 }], "bounds");

const results = [];
try {
  for (const scenario of cases)
    for (const structure of ["classic", "inline"])
      for (const styleMode of ["inline", "classes"])
        for (const multi of [false, true]) {
          const events = [];
          const refs = [];
          const opaque = { marker: Symbol("opaque") };
          let callbackCode;
          const transformer = {
            preprocess(code) {
              events.push("preprocess");
              return scenario.mode === "preprocess" ? `_${code}` : code;
            },
            tokens(lines) {
              events.push(["tokens", lines.flat().map((t) => [t.content, t.offset])]);
              for (const t of lines.flat()) t.opaque = opaque;
              if (scenario.mode === "tokens")
                lines[0][0].content = lines[0][0].content.toUpperCase();
              return lines;
            },
            span(node, line, column, lineNode, token) {
              events.push([
                "span",
                line,
                column,
                token.content,
                token.offset,
                token.opaque === opaque,
              ]);
              refs.push(node);
              if (scenario.mode === "span")
                node.children = [
                  { type: "element", tagName: "em", properties: {}, children: node.children },
                ];
              if (scenario.mode === "shrinking" && token.offset === 0)
                node.children = [{ type: "text", value: "" }];
              return node;
            },
            line(node, line) {
              events.push(["line", line]);
              return node;
            },
            code(node) {
              events.push("code");
              callbackCode = node;
              if (scenario.mode === "code") node.children.reverse();
              if (scenario.mode === "shared") {
                const lines = node.children.filter(
                  (n) => n.type === "element" && n.tagName === "span",
                );
                lines[1].children = lines[0].children;
              }
              return node;
            },
            pre(node) {
              events.push("pre");
              return node;
            },
            root(node) {
              events.push([
                "root",
                refs.map((ref) => ref.properties?.class || null),
                this.tokens.flat().every((t) => t.opaque === opaque),
              ]);
              return node;
            },
          };
          const decorations = scenario.decorations.map((decoration) => ({ ...decoration }));
          if (
            [
              "decoration",
              "mutating-decoration",
              "replacement",
              "throwing",
              "wrapping",
              "bounds",
            ].includes(scenario.mode)
          )
            for (const decoration of decorations) {
              decoration.transform = function (node, type) {
                events.push(["decoration", type, this.start, this.end, refs.includes(node)]);
                if (scenario.mode === "throwing") throw new Error("decoration callback failure");
                if (scenario.mode === "wrapping") this.alwaysWrap = true;
                if (scenario.mode === "bounds") {
                  this.end.line = 1;
                  this.end.character = 4;
                }
                if (scenario.mode === "mutating-decoration") {
                  const lines = callbackCode.children.filter(
                    (n) => n.type === "element" && n.tagName === "span",
                  );
                  if (lines[1])
                    lines[1].children = [
                      {
                        type: "element",
                        tagName: "span",
                        properties: {},
                        children: [{ type: "text", value: "X" }],
                      },
                    ];
                }
                if (scenario.mode === "replacement")
                  return { ...node, properties: { ...node.properties, "data-replacement": "yes" } };
                node.properties["data-callback"] = type;
                return node;
              };
            }
          const options = {
            lang: scenario.name === "javascript" ? "javascript" : "text",
            structure,
            styleMode,
            decorations,
            ...(multi
              ? { themes: { light: "github-light-default", dark: "nord" } }
              : { theme: "nord" }),
            ...(scenario.mode === "plain" ? {} : { transformers: [transformer] }),
          };
          const name = `${scenario.name}/${structure}/${styleMode}/${multi ? "multi" : "single"}`;
          try {
            const result =
              styleMode === "classes"
                ? highlighter.codeToHtmlWithCss(scenario.code, options)
                : highlighter.codeToHtml(scenario.code, options);
            results.push({ name, result, events });
          } catch (error) {
            const category = error instanceof ShikiError ? error.code : error.message;
            results.push({
              name,
              error: category,
              events,
              retainedNodeClasses: refs.map((ref) => ref.properties?.class || null),
            });
          }
        }
} finally {
  highlighter.dispose();
}
const fixture = new URL("./fixtures/native-decorations-baseline.json", import.meta.url);
if (capture) {
  const entry = await readFile(moduleUrl);
  const policy = await readFile(new URL("./transformers.mjs", moduleUrl));
  const addon = await readFile(new URL("./dist/ferriki.node", moduleUrl));
  await writeFile(
    fixture,
    `${JSON.stringify(
      {
        baselineCommit: "f9cfb0745c99805e40af51c872d2178e99ad221c",
        entrySha256: createHash("sha256").update(entry).digest("hex"),
        policySha256: createHash("sha256").update(policy).digest("hex"),
        addonSha256: createHash("sha256").update(addon).digest("hex"),
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Captured ${results.length} original decoration cases`);
} else {
  const baseline = JSON.parse(await readFile(fixture, "utf8"));
  for (let i = 0; i < results.length; i++)
    assert.deepEqual(results[i], baseline.results[i], results[i].name);
  assert.equal(results.length, baseline.results.length);
  console.log(
    `Native decorations match ${results.length} original public outputs and callback traces`,
  );
}

if (!capture) {
  const native = loadFerrikiNativeBinding();
  const range = { startOffset: 0, endOffset: 1, alwaysWrap: false };
  for (const metadata of [
    Float64Array.of(0),
    Float64Array.of(Number.NaN, 1),
    Float64Array.of(0.5, 1),
  ])
    assert.throws(
      () => native.splitDecorationTokens("a", [range], [metadata]),
      (error) => error.code === "InvalidArg",
    );
  assert.throws(
    () => native.planDecorationMutations(Float64Array.of(1, 0, 2, 1), [0], []),
    (error) => error.code === "InvalidArg",
  );
  const cyclic = native.planDecorationMutations(Float64Array.of(1, 0, 1, 0), [0], []);
  assert.match(cyclic.error, /Cyclic/);
  assert.deepEqual(cyclic.mutations, []);
  const invalidHighlighter = createHighlighterCoreSync({});
  try {
    for (const start of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0.5,
      { line: 0, character: "x" },
      { line: "x", character: 0 },
    ])
      assert.throws(
        () =>
          invalidHighlighter.codeToHtml("a", {
            lang: "text",
            theme: "none",
            decorations: [{ start, end: 1 }],
          }),
        (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
      );
  } finally {
    invalidHighlighter.dispose();
  }
}
