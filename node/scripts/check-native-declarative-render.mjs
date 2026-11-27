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
    [{ start: 0, end: 5, tagName: "script" }],
    [{ start: 0, end: 5, tagName: "iframe" }],
    [{ start: 0, end: 5, properties: { onclick: "alert(1)" } }],
    [{ start: 0, end: 5, tagName: "plaintext" }],
    [{ start: 0, end: 5, tagName: "ferriki-code" }],
    [{ start: 0, end: 5, tagName: "x-custom-el" }],
    [{ start: 0, end: 5, properties: { srcdoc: "<script>" } }],
    [{ start: 0, end: 5, properties: { is: "x-evil" } }],
    [{ start: 0, end: 5, properties: { background: "https://evil.test/bg.png" } }],
    [{ start: 0, end: 5, properties: { attributionsrc: "https://evil.test/ping" } }],
    [{ start: 0, end: 5, tagName: "a", properties: { href: "javascript:alert(1)" } }],
    [{ start: 0, end: 5, tagName: "a", properties: { href: "data:text/html,<script>" } }],
    [{ start: 0, end: 5, tagName: "a", properties: { href: { javascript: "alert(1)" } } }],
    [{ start: 0, end: 5, tagName: "a", properties: { href: ["javascript:alert(1)"] } }],
    // Empty no-op ranges must still fail upfront identically on native and JS paths.
    [{ start: 2, end: 2, tagName: "script" }],
    [{ start: 2, end: 2, tagName: "a", properties: { href: "javascript:alert(1)" } }],
  ]) {
    assert.throws(
      () => highlighter.codeToHtml("alpha", { lang: "text", theme: "nord", decorations }),
      (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
    );
    assert.throws(
      () =>
        highlighter.codeToHtml("alpha", {
          lang: "text",
          theme: "nord",
          decorations,
          transformers: [{}],
        }),
      (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
    );
  }
  // Inline decoration `style` and `STYLE` properties are sanitized and canonicalized
  // consistently across both the native declarative path and the JS transformer path.
  for (const transformers of [undefined, [{}]]) {
    const sanitizedStyleHtml = highlighter.codeToHtml("alpha", {
      lang: "text",
      theme: "nord",
      ...(transformers ? { transformers } : {}),
      decorations: [
        {
          start: 0,
          end: 3,
          properties: { STYLE: "background:url(https://evil.test);font-weight:bold" },
        },
      ],
    });
    assert(!sanitizedStyleHtml.includes("url("));
    assert(!sanitizedStyleHtml.includes("STYLE="));
    assert(sanitizedStyleHtml.includes('style="font-weight:bold"'));

    const droppedStyleHtml = highlighter.codeToHtml("alpha", {
      lang: "text",
      theme: "nord",
      ...(transformers ? { transformers } : {}),
      decorations: [
        {
          start: 0,
          end: 3,
          properties: { style: "background:url(https://evil.test)" },
        },
      ],
    });
    assert(!droppedStyleHtml.includes("url("));
    assert(!droppedStyleHtml.includes('style=""'));
  }

  // `decoration.transform` receives object-valued `style` by reference (preserving shared
  // object identity per ADR 0008 across decorations), while unsafe declarations are stripped
  // after all decoration callbacks finish without mutating the caller's object keys.
  const inputStyle = { color: "red", "background-image": "url(https://evil.test)" };
  let firstSeenRef;
  let secondSeenRef;
  let secondSeenColor;
  const transformedStyleHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 3,
        end: 5,
        properties: { style: inputStyle },
        transform(node) {
          firstSeenRef = node.properties.style;
          node.properties.style.color = "green";
          return node;
        },
      },
      {
        start: 0,
        end: 2,
        properties: { style: inputStyle },
        transform(node) {
          secondSeenRef = node.properties.style;
          secondSeenColor = node.properties.style.color;
          return node;
        },
      },
    ],
  });
  assert.equal(firstSeenRef, inputStyle);
  assert.equal(secondSeenRef, inputStyle);
  assert.equal(secondSeenColor, "green");
  assert.equal(inputStyle["background-image"], "url(https://evil.test)");
  assert(transformedStyleHtml.includes('style="color:green"'));
  assert(!transformedStyleHtml.includes("url("));

  // Declarative string styles remain verbatim during `decoration.transform` (per ADR 0008),
  // while unchanged or deep-cloned declarative strings are sanitized after callbacks run and
  // callback-authored wrapper styles survive untouched.
  let seenVerbatimStyle;
  const verbatimStyleHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color: red" },
        transform(node) {
          seenVerbatimStyle = node.properties.style;
          return node;
        },
      },
    ],
  });
  assert.equal(seenVerbatimStyle, "color: red");
  assert(verbatimStyleHtml.includes('style="color:red"'));

  let seenHostileStringStyle;
  const wrappedStringCloneHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color: red; background-image: url(https://evil.test/x)" },
        transform(node) {
          seenHostileStringStyle = node.properties.style;
          return {
            type: "element",
            tagName: "em",
            properties: { style: "background-image: url(/local.png)" },
            children: [structuredClone(node)],
          };
        },
      },
    ],
  });
  assert.equal(seenHostileStringStyle, "color: red; background-image: url(https://evil.test/x)");
  assert(!wrappedStringCloneHtml.includes("evil.test"));
  assert(wrappedStringCloneHtml.includes('style="background-image: url(/local.png)"'));
  assert(wrappedStringCloneHtml.includes('style="color:red"'));

  // If a callback adds an uppercase `STYLE` property alongside a declarative `style`,
  // every surviving declarative style attribute is still sanitized (never bypassed by
  // inspecting only the last case-insensitive style key).
  const mixedCaseCallbackHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "background:url(https://evil.test)" },
        transform(node) {
          node.properties.STYLE = "font-weight:bold";
          return node;
        },
      },
    ],
  });
  assert(!mixedCaseCallbackHtml.includes("evil.test"));
  assert(mixedCaseCallbackHtml.includes('STYLE="font-weight:bold"'));

  const mixedCaseRetainedHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "background:url(https://evil.test);color:green" },
        transform(node) {
          node.properties.STYLE = "font-weight:bold";
          return node;
        },
      },
    ],
  });
  assert(!mixedCaseRetainedHtml.includes("evil.test"));
  assert(mixedCaseRetainedHtml.includes('style="color:green"'));
  assert(mixedCaseRetainedHtml.includes('STYLE="font-weight:bold"'));

  // Declarative style sanitization is scoped strictly to the decoration that supplied it:
  // decoration A's unsafe declarative style does not strip an identical callback-authored
  // wrapper style produced independently by decoration B.
  const sharedUnsafeCss = "background:url(https://shared.example/bg.png)";
  const scopedDecorationsHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 2,
        properties: { style: sharedUnsafeCss },
      },
      {
        start: 3,
        end: 5,
        transform(node) {
          return {
            type: "element",
            tagName: "em",
            properties: { style: sharedUnsafeCss },
            children: [node],
          };
        },
      },
    ],
  });
  assert.equal(scopedDecorationsHtml.match(/shared\.example/gu)?.length, 1);
  assert(scopedDecorationsHtml.includes(`<em style="${sharedUnsafeCss}">`));

  // Both partial-line and whole-line enclosing decorations returning `structuredClone(node)`
  // never emit unsanitized declarative CSS from an inner decoration (or from the whole line).
  for (const outerEnd of [4, 5]) {
    for (const innerDecoration of [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background:url(https://evil.example/inner-str)" },
      },
      {
        start: 0,
        end: 3,
        properties: {
          style: { color: "blue", background: "url(https://evil.example/inner-obj)" },
        },
        transform(node) {
          return node;
        },
      },
    ]) {
      const outerCloneHtml = highlighter.codeToHtml("alpha", {
        lang: "text",
        theme: "nord",
        decorations: [
          innerDecoration,
          {
            start: 0,
            end: outerEnd,
            transform(node) {
              return structuredClone(node);
            },
          },
        ],
      });
      assert(!outerCloneHtml.includes("evil.example"));
      assert(outerCloneHtml.includes('style="color:blue"'));
    }
  }
  const wholeLineSelfCloneHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 5,
        properties: { style: "color:blue;background:url(https://evil.example/whole-line)" },
        transform(node) {
          return structuredClone(node);
        },
      },
    ],
  });
  assert(!wholeLineSelfCloneHtml.includes("evil.example"));
  assert(wholeLineSelfCloneHtml.includes('style="color:blue"'));

  // Sanitization touches only exact tracked decorated elements, never arbitrary descendants:
  // a trusted `span`-hook style survives even when a whole-line decoration supplies the exact
  // same declarative style string.
  const lineVsSpanStyle = "background:url(/local.png)";
  const descendantPreservedHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        span(node) {
          node.properties.style = lineVsSpanStyle;
          return node;
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 5,
        properties: { style: lineVsSpanStyle },
      },
    ],
  });
  assert.equal(descendantPreservedHtml.match(/background:url\(\/local\.png\)/gu)?.length, 1);
  assert(
    descendantPreservedHtml.includes(
      '<span class="line"><span style="background:url(/local.png)">',
    ),
  );

  // Deeply nested spans (60 levels) use fixed-size subtree hashes during clone tracking
  // without exponential escaping blowup.
  const deepCloneHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        span(node) {
          let current = node;
          for (let depth = 0; depth < 60; depth++) {
            current = { type: "element", tagName: "span", properties: {}, children: [current] };
          }
          return current;
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:green;background:url(https://evil.example/deep)" },
        transform(node) {
          return structuredClone(node);
        },
      },
    ],
  });
  assert(!deepCloneHtml.includes("evil.example"));
  assert(deepCloneHtml.includes('style="color:green"'));

  // Single-read stateful getters on decoration style objects are evaluated at most once
  // without `transform`, with `transform` returning `node` (preserving reference identity),
  // and with `transform` returning `structuredClone(node)`.
  for (const mode of ["plain", "identity", "clone"]) {
    let colorReads = 0;
    const statefulStyle = {
      get color() {
        colorReads++;
        return colorReads === 1 ? "red" : "green";
      },
      get background() {
        return "url(https://evil.example/getter)";
      },
    };
    let sawSameRef = false;
    const decoration = {
      start: 0,
      end: 3,
      properties: { style: statefulStyle },
    };
    if (mode === "identity") {
      decoration.transform = (node) => {
        sawSameRef = node.properties.style === statefulStyle;
        return node;
      };
    } else if (mode === "clone") {
      decoration.transform = (node) => structuredClone(node);
    }
    const statefulStyleHtml = highlighter.codeToHtml("alpha", {
      lang: "text",
      theme: "nord",
      transformers: [{}],
      decorations: [decoration],
    });
    assert.equal(colorReads, 1, `expected single getter read for mode=${mode}`);
    if (mode === "identity") assert.equal(sawSameRef, true);
    assert(!statefulStyleHtml.includes("evil.example"));
    assert(statefulStyleHtml.includes('style="color:red"'));
  }

  // Array-valued declarative styles are sanitized even when `decoration.transform` clones `node`.
  const clonedArrayStyleHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: ["color:red;", "background:url(https://evil.example/arr)"] },
        transform(node) {
          return structuredClone(node);
        },
      },
    ],
  });
  assert(!clonedArrayStyleHtml.includes("evil.example"));
  assert(clonedArrayStyleHtml.includes('style="color:red"'));

  // Shared style object references remain live across all decoration callbacks before final
  // sanitization, so mutating `shared.color` in a later callback updates both decorated nodes.
  const sharedStyle = { color: "red" };
  const sharedMutationHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      { start: 0, end: 2, properties: { style: sharedStyle } },
      {
        start: 3,
        end: 5,
        properties: { style: sharedStyle },
        transform(node) {
          sharedStyle.color = "blue";
          return node;
        },
      },
    ],
  });
  assert.equal(sharedMutationHtml.match(/style="color:blue"/gu)?.length, 2);
  assert(!sharedMutationHtml.includes('style="color:red"'));

  // Accessor-backed style clone matching targets only the cloned inner node, never stripping
  // a callback-authored wrapper style that happens to use the same property key (`background`).
  let wrappedAccessorReads = 0;
  const wrappedAccessorHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: {
          style: {
            get background() {
              wrappedAccessorReads++;
              return "url(https://evil.example/accessor)";
            },
          },
        },
        transform(node) {
          return {
            type: "element",
            tagName: "div",
            properties: { style: { background: "url(/local.png)" } },
            children: [structuredClone(node)],
          };
        },
      },
    ],
  });
  assert.equal(wrappedAccessorReads, 1);
  assert(!wrappedAccessorHtml.includes("evil.example"));
  assert(wrappedAccessorHtml.includes('<div style="background:url(/local.png)">'));

  // Fresh decoration wrappers preserve attribute insertion order byte-for-byte between native
  // and JS render paths when `style` appears before other attributes.
  const orderedProps = { style: "color:red", title: "note" };
  const nativeOrdered = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [{ start: 0, end: 3, properties: orderedProps }],
  });
  const jsOrdered = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [{}],
    decorations: [{ start: 0, end: 3, properties: orderedProps }],
  });
  assert.equal(nativeOrdered, jsOrdered);
  assert(nativeOrdered.includes('<span style="color:red" title="note">'));

  // An empty earlier case-variant (`STYLE: ""`) reserves the canonical `style` slot before
  // later attributes in both native and JS decoration renders.
  const emptyFirstProps = { STYLE: "", title: "note", style: "color:red" };
  const nativeEmptyFirst = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [{ start: 0, end: 3, properties: emptyFirstProps }],
  });
  const jsEmptyFirst = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [{}],
    decorations: [{ start: 0, end: 3, properties: emptyFirstProps }],
  });
  assert.equal(nativeEmptyFirst, jsEmptyFirst);
  assert(nativeEmptyFirst.includes('<span style="color:red" title="note">'));

  // Reserving an empty `style` slot persists across separate decorations until serialization
  // identically in both native and JS render paths.
  const chainedDecorations = [
    { start: 0, end: 3, properties: { style: "", title: "note" } },
    { start: 0, end: 3, properties: { style: "color:red" } },
  ];
  const nativeChained = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: chainedDecorations,
  });
  const jsChained = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [{}],
    decorations: chainedDecorations,
  });
  assert.equal(nativeChained, jsChained);
  assert(nativeChained.includes('<span style="color:red" title="note">'));

  // Duplicating a decorated node alongside the original (`<div>[node, structuredClone(node)]</div>`)
  // sanitizes BOTH the original and the duplicate clone.
  const duplicatedCloneHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background:url(https://evil.example/dup)" },
        transform(node) {
          return {
            type: "element",
            tagName: "div",
            properties: {},
            children: [node, structuredClone(node)],
          };
        },
      },
    ],
  });
  assert(!duplicatedCloneHtml.includes("evil.example"));
  assert.equal(duplicatedCloneHtml.match(/style="color:blue"/gu)?.length, 2);

  // Extending a declarative style in `decoration.transform` still sanitizes the retained
  // unsafe declarative declarations while preserving callback-added declarations, and
  // completely replacing `node.properties.style` keeps the callback's replacement verbatim.
  const appendedSafeHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background-image:url(https://evil.example/ext)" },
        transform(node) {
          node.properties.style += "; font-weight:bold";
          return node;
        },
      },
    ],
  });
  assert(!appendedSafeHtml.includes("evil.example"));
  assert(appendedSafeHtml.includes('style="color:blue;font-weight:bold"'));

  const appendedCustomHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background-image:url(https://evil.example/ext2)" },
        transform(node) {
          node.properties.style += "; background-image: url(/local.png)";
          return node;
        },
      },
    ],
  });
  assert(!appendedCustomHtml.includes("evil.example"));
  assert(appendedCustomHtml.includes('style="color:blue;background-image: url(/local.png)"'));

  const replacedStyleHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background-image:url(https://evil.example/rep)" },
        transform(node) {
          node.properties.style = "background-image: url(https://trusted.example/ok.png)";
          return node;
        },
      },
    ],
  });
  assert(!replacedStyleHtml.includes("evil.example"));
  assert(
    replacedStyleHtml.includes('style="background-image: url(https://trusted.example/ok.png)"'),
  );

  // Replacing an undecorated sibling with a `structuredClone` of a decorated token having the
  // same structure sanitizes BOTH the original and the cloned replacement (never skipped by
  // sibling-count subtraction).
  const replacedUndecoratedSiblingHtml = highlighter.codeToHtml("xx!", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        tokens() {
          return [
            [
              { content: "x", offset: 0 },
              { content: "x", offset: 1 },
              { content: "!", offset: 2 },
            ],
          ];
        },
      },
    ],
    decorations: [
      {
        start: 1,
        end: 2,
        properties: { style: "color:blue;background:url(https://evil.example/sib)" },
      },
      {
        start: 0,
        end: 2,
        alwaysWrap: true,
        transform(node) {
          node.children = [structuredClone(node.children[1]), node.children[1]];
          return node;
        },
      },
    ],
  });
  assert(!replacedUndecoratedSiblingHtml.includes("evil.example"));
  assert.equal(replacedUndecoratedSiblingHtml.match(/style="color:blue"/gu)?.length, 2);

  // Returning frozen nodes or frozen `properties` records from `decoration.transform` renders
  // valid sanitized HTML without mutating callback-owned objects or throwing `TypeError`.
  const frozenSafeProps = Object.freeze({ style: "color:green" });
  const frozenSafeHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:green" },
        transform(node) {
          return Object.freeze({ ...node, properties: frozenSafeProps });
        },
      },
    ],
  });
  assert(frozenSafeHtml.includes('style="color:green"'));
  assert.equal(frozenSafeProps.style, "color:green");

  const frozenUnsafeProps = Object.freeze({
    style: "color:green;background:url(https://evil.example/frozen)",
  });
  const frozenUnsafeHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:green;background:url(https://evil.example/frozen)" },
        transform(node) {
          return Object.freeze({ ...node, properties: frozenUnsafeProps });
        },
      },
    ],
  });
  assert(!frozenUnsafeHtml.includes("evil.example"));
  assert(frozenUnsafeHtml.includes('style="color:green"'));
  assert.equal(frozenUnsafeProps.style, "color:green;background:url(https://evil.example/frozen)");

  // Copying a declarative style onto an existing surviving child element without replacing
  // either node still sanitizes BOTH the parent and the child.
  const copiedToChildHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 5,
        properties: { style: "color:blue;background:url(https://evil.example/child-copy)" },
        transform(node) {
          node.children[0].properties.style = node.properties.style;
          return node;
        },
      },
    ],
  });
  assert(!copiedToChildHtml.includes("evil.example"));
  assert.equal(copiedToChildHtml.match(/style="color:blue"/gu)?.length, 2);

  // An empty declarative `style: ""` is omitted identically in both native and JS render paths.
  const nativeEmptyOnly = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [{ start: 0, end: 3, properties: { style: "" } }],
  });
  const jsEmptyOnly = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [{}],
    decorations: [{ start: 0, end: 3, properties: { style: "" } }],
  });
  assert.equal(nativeEmptyOnly, jsEmptyOnly);
  assert(!nativeEmptyOnly.includes('style=""'));

  // Cloning a line with 500 individually decorated tokens stays linear-time via
  // path-first reconciliation and indexed record lookups.
  const tokenCount = 500;
  const manySource = `${"a".repeat(tokenCount)}!`;
  const manyDecorations = [];
  for (let index = 0; index < tokenCount; index++) {
    manyDecorations.push({
      start: index,
      end: index + 1,
      properties: { style: "color:blue;background:url(https://evil.example/many)" },
    });
  }
  manyDecorations.push({
    start: 0,
    end: tokenCount,
    alwaysWrap: true,
    transform(node) {
      return structuredClone(node);
    },
  });
  const manyClonedHtml = highlighter.codeToHtml(manySource, {
    lang: "text",
    theme: "nord",
    decorations: manyDecorations,
  });
  assert(!manyClonedHtml.includes("evil.example"));
  assert.equal(manyClonedHtml.match(/style="color:blue"/gu)?.length, tokenCount);

  // Replacing 500 individually decorated tokens with 500 unstyled tokens skips fallback scans
  // cleanly and emits no unsafe CSS.
  const replacedUnstyledDecorations = [];
  for (let index = 0; index < tokenCount; index++) {
    replacedUnstyledDecorations.push({
      start: index,
      end: index + 1,
      properties: { style: "color:blue;background:url(https://evil.example/unstyled)" },
    });
  }
  replacedUnstyledDecorations.push({
    start: 0,
    end: tokenCount,
    alwaysWrap: true,
    transform(node) {
      return {
        type: "element",
        tagName: "span",
        properties: {},
        children: node.children.map((child) => ({
          type: "element",
          tagName: "span",
          properties: {},
          children: child.children,
        })),
      };
    },
  });
  const replacedUnstyledHtml = highlighter.codeToHtml(manySource, {
    lang: "text",
    theme: "nord",
    decorations: replacedUnstyledDecorations,
  });
  assert(!replacedUnstyledHtml.includes("evil.example"));
  assert(!replacedUnstyledHtml.includes('style="color:blue"'));

  // Mutating a declarative style object in place inside `decoration.transform` sanitizes the
  // declarative entries while preserving callback-added properties verbatim without mutating
  // the original object's remaining keys.
  for (const [propKey, expectedDecl] of [
    ["background-image", "background-image:url(/local.png)"],
    ["backgroundImage", "backgroundImage:url(/local.png)"],
  ]) {
    const mutableObj = { color: "red", background: "url(javascript:alert(1))" };
    const mutatedObjHtml = highlighter.codeToHtml("alpha", {
      lang: "text",
      theme: "nord",
      decorations: [
        {
          start: 0,
          end: 3,
          properties: { style: mutableObj },
          transform(node) {
            node.properties.style[propKey] = "url(/local.png)";
            return node;
          },
        },
      ],
    });
    assert(!mutatedObjHtml.includes("javascript:"));
    assert(mutatedObjHtml.includes(`style="color:red;${expectedDecl}"`));
    assert.equal(mutableObj.background, "url(javascript:alert(1))");
  }

  // Wrapping a surviving decorated node in a new callback-authored `<div>` that carries the
  // same CSS string strips the inner node's declarative style while preserving the wrapper's style.
  const sameWrapperCss = "background-image: url(/local.png)";
  const wrappedSameCssHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: sameWrapperCss },
        transform(node) {
          return {
            type: "element",
            tagName: "div",
            properties: { style: sameWrapperCss },
            children: [node],
          };
        },
      },
    ],
  });
  assert.equal(wrappedSameCssHtml.match(/background-image: url\(\/local\.png\)/gu)?.length, 1);
  assert(wrappedSameCssHtml.includes(`<div style="${sameWrapperCss}"><span>alp</span></div>`));

  // Multiple differently-named decorated tokens sharing a style retain EVERY record's
  // structure hash in the style index, so cloning the SECOND token still reconciles and sanitizes.
  const sharedStyleSecondCloneHtml = highlighter.codeToHtml("foobar!", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background:url(https://evil.example/shared-two)" },
      },
      {
        start: 3,
        end: 6,
        properties: { style: "color:blue;background:url(https://evil.example/shared-two)" },
      },
      {
        start: 0,
        end: 6,
        alwaysWrap: true,
        transform(node) {
          return {
            ...node,
            children: [...node.children, structuredClone(node.children[1])],
          };
        },
      },
    ],
  });
  assert(!sharedStyleSecondCloneHtml.includes("evil.example"));
  assert.equal(sharedStyleSecondCloneHtml.match(/style="color:blue"/gu)?.length, 3);

  // Reformatting whitespace, casing, or comments inside a declarative CSS declaration still
  // preserves provenance so unsafe declarative CSS is stripped while callback additions survive.
  const reformattedCssHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background-image:url(javascript:alert(1))" },
        transform(node) {
          node.properties.style =
            "color:blue; BACKGROUND-IMAGE /* keep */ : url( javascript:alert(1) ); font-weight: bold";
          return node;
        },
      },
    ],
  });
  assert(!reformattedCssHtml.includes("javascript:"));
  assert(reformattedCssHtml.includes('style="color:blue;font-weight: bold"'));

  // Canonicalization preserves case sensitivity in CSS values (such as URL paths) and custom
  // property names, so replacing `url(/icons/A.svg)` with `url(/icons/a.svg)` keeps the
  // callback's replacement intact.
  const caseSensitiveReplacementHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "background-image: url(/icons/A.svg)" },
        transform(node) {
          node.properties.style = "background-image: url(/icons/a.svg)";
          return node;
        },
      },
    ],
  });
  assert(caseSensitiveReplacementHtml.includes('style="background-image: url(/icons/a.svg)"'));

  // Splitting a decorated token into multiple sibling fragments sanitizes EVERY fragment
  // inheriting the detached node's declarative style.
  const splitFragmentsHtml = highlighter.codeToHtml("foobar!", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 6,
        properties: { style: "color:blue;background:url(https://evil.example/split)" },
        transform(node) {
          const style = node.properties.style;
          return {
            type: "element",
            tagName: "span",
            properties: {},
            children: [
              {
                type: "element",
                tagName: "span",
                properties: { style },
                children: [{ type: "text", value: "foo" }],
              },
              {
                type: "element",
                tagName: "span",
                properties: { style },
                children: [{ type: "text", value: "bar" }],
              },
            ],
          };
        },
      },
    ],
  });
  assert(!splitFragmentsHtml.includes("evil.example"));
  assert.equal(splitFragmentsHtml.match(/style="color:blue"/gu)?.length, 2);

  // U+FEFF (BOM) in custom property names is rejected identically in native and JS render paths.
  const bomCustomPropStyle = "--a\uFEFFb: red";
  const nativeBomProp = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [{ start: 0, end: 3, properties: { style: bomCustomPropStyle } }],
  });
  const jsBomProp = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [{}],
    decorations: [{ start: 0, end: 3, properties: { style: bomCustomPropStyle } }],
  });
  assert.equal(nativeBomProp, jsBomProp);
  assert(!nativeBomProp.includes("--a"));

  // Stringifying an object-valued declarative style inside `decoration.transform` preserves
  // object entry boundaries: ALL fragments of a rejected object entry (`color: "red; font-weight: bold"`)
  // are dropped while valid entries survive.
  const stringifiedRejectedObjHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: { color: "red; font-weight: bold", padding: "1px" } },
        transform(node) {
          node.properties.style = Object.entries(node.properties.style)
            .map(([k, v]) => `${k}:${v}`)
            .join(";");
          return node;
        },
      },
    ],
  });
  assert(!stringifiedRejectedObjHtml.includes("color:red"));
  assert(!stringifiedRejectedObjHtml.includes("font-weight"));
  assert(stringifiedRejectedObjHtml.includes('style="padding:1px"'));

  // Accessor-backed URL decoration attributes (`get href()`) are read and validated fresh when
  // applying each edit (so later decorations observe state mutated by earlier callbacks), while
  // data-valued URL attributes reject upfront before earlier callbacks run and 0-target invalid
  // getters still reject after replay.
  assert.throws(
    () =>
      highlighter.codeToHtml("alpha", {
        lang: "text",
        theme: "nord",
        decorations: [
          {
            start: 0,
            end: 0,
            tagName: "a",
            properties: {
              get href() {
                return "javascript:alert(1)";
              },
            },
          },
        ],
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  let earlierCallbackRan = false;
  assert.throws(
    () =>
      highlighter.codeToHtml("alpha", {
        lang: "text",
        theme: "nord",
        decorations: [
          {
            start: 0,
            end: 2,
            transform(node) {
              earlierCallbackRan = true;
              return node;
            },
          },
          {
            start: 2,
            end: 4,
            tagName: "a",
            properties: {
              href: "javascript:alert(1)",
            },
          },
        ],
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  assert.equal(earlierCallbackRan, false);

  let dynamicHref = "https://before.example";
  let dynamicHrefReads = 0;
  const postCallbackHrefHtml = highlighter.codeToHtml("line1\nline2", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 2,
        transform(node) {
          dynamicHref = "https://after.example";
          return node;
        },
      },
      {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 5 },
        tagName: "a",
        properties: {
          get href() {
            dynamicHrefReads++;
            return dynamicHref;
          },
        },
      },
    ],
  });
  assert.equal(dynamicHrefReads, 2);
  assert(!postCallbackHrefHtml.includes("before.example"));
  assert.equal(postCallbackHrefHtml.match(/href="https:\/\/after\.example"/gu)?.length, 2);

  let hrefReads = 0;
  const toctouHrefHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        tagName: "a",
        properties: {
          get href() {
            hrefReads++;
            return hrefReads === 1 ? "https://example.com" : "javascript:alert(1)";
          },
        },
      },
    ],
  });
  assert.equal(hrefReads, 1);
  assert(toctouHrefHtml.includes('href="https://example.com"'));
  assert(!toctouHrefHtml.includes("javascript:"));

  // Mutating `node.children` in place with `structuredClone` while returning the same `node`
  // still reconciles and sanitizes cloned inner decorated children.
  const inPlaceChildCloneHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background:url(https://evil.example/inplace)" },
      },
      {
        start: 0,
        end: 5,
        transform(node) {
          node.children = node.children.map((child) => structuredClone(child));
          return node;
        },
      },
    ],
  });
  assert(!inPlaceChildCloneHtml.includes("evil.example"));
  assert(inPlaceChildCloneHtml.includes('style="color:blue"'));

  // Path-first reconciliation distinguishes identical sibling tokens: token 0's trusted
  // `span`-hook style survives while token 1's identical declarative style is stripped when an
  // enclosing wrapper returns `structuredClone(node)`.
  const siblingStyle = "background:url(/local.png)";
  const identicalSiblingsHtml = highlighter.codeToHtml("xx!", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        tokens() {
          return [
            [
              { content: "x", offset: 0 },
              { content: "x", offset: 1 },
              { content: "!", offset: 2 },
            ],
          ];
        },
        span(node, _line, col) {
          if (col === 0) node.properties.style = siblingStyle;
          return node;
        },
      },
    ],
    decorations: [
      {
        start: 1,
        end: 2,
        properties: { style: siblingStyle },
      },
      {
        start: 0,
        end: 2,
        alwaysWrap: true,
        transform(node) {
          return structuredClone(node);
        },
      },
    ],
  });
  assert.equal(identicalSiblingsHtml.match(/background:url\(\/local\.png\)/gu)?.length, 1);
  assert(
    identicalSiblingsHtml.includes(
      '<span style="background:url(/local.png)">x</span><span>x</span>',
    ),
  );

  // Native and JS decoration renders both reject control chars inside leading CSS comments.
  const commentCtrlStyle = "/* \u0007 */ color:red";
  const nativeCommentCtrl = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [{ start: 0, end: 3, properties: { style: commentCtrlStyle } }],
  });
  const jsCommentCtrl = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [{}],
    decorations: [{ start: 0, end: 3, properties: { style: commentCtrlStyle } }],
  });
  assert.equal(nativeCommentCtrl, jsCommentCtrl);
  assert(!nativeCommentCtrl.includes("color:red"));

  // Declarative object styles wrapped directly, in shallow clones, or via `structuredClone`
  // are sanitized across the returned subtree without mutating the caller's object keys,
  // while a wrapper's own callback-authored object style survives untouched per ADR 0008.
  const wrappedObjInput = { color: "blue", "background-image": "url(https://evil.test)" };
  for (const cloneNode of [
    (node) => node,
    (node) => ({ ...node, properties: { ...node.properties } }),
    (node) => structuredClone(node),
  ]) {
    const wrappedObjHtml = highlighter.codeToHtml("alpha", {
      lang: "text",
      theme: "nord",
      decorations: [
        {
          start: 0,
          end: 3,
          properties: { style: wrappedObjInput },
          transform(node) {
            return {
              type: "element",
              tagName: "em",
              properties: { style: { backgroundImage: "url(/local.png)" } },
              children: [cloneNode(node)],
            };
          },
        },
      ],
    });
    assert(!wrappedObjHtml.includes("evil.test"));
    assert(wrappedObjHtml.includes('style="color:blue"'));
    assert(wrappedObjHtml.includes('style="backgroundImage:url(/local.png)"'));
    assert.equal(wrappedObjInput["background-image"], "url(https://evil.test)");
  }

  // Stateful getters on `decoration.properties` are evaluated only once (not twice by upfront
  // validation + property application).
  let getterCalls = 0;
  const statefulProps = {
    get title() {
      return `call-${++getterCalls}`;
    },
  };
  const getterHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [{ start: 0, end: 3, properties: statefulProps }],
  });
  assert.equal(getterCalls, 1);
  assert(getterHtml.includes('title="call-1"'));

  // Stateful `get properties()` and `get tagName()` getters on a decoration item itself
  // are evaluated only once because `applyDecorations` captures items before validation.
  let propsGetterCalls = 0;
  let tagGetterCalls = 0;
  const statefulDecoration = {
    start: 0,
    end: 3,
    get tagName() {
      tagGetterCalls++;
      return "mark";
    },
    get properties() {
      return { "data-n": String(++propsGetterCalls) };
    },
  };
  const itemGetterHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [statefulDecoration],
  });
  assert.equal(tagGetterCalls, 1);
  assert.equal(propsGetterCalls, 1);
  assert(itemGetterHtml.includes('<mark data-n="1">'));

  // Prototype-inherited getters and extra enumerable properties/symbols survive on `this`
  // inside `decoration.transform` while evaluating each getter only once.
  const metaSym = Symbol("ferriki.test.decoration.meta");
  let protoTagCalls = 0;
  let protoPropsCalls = 0;
  let seenLabel;
  let seenSym;
  class CustomDecoration {
    constructor() {
      this.label = "custom-label";
      this[metaSym] = "symbol-meta";
    }
    get start() {
      return 0;
    }
    get end() {
      return 3;
    }
    get tagName() {
      protoTagCalls++;
      return "mark";
    }
    get properties() {
      return { "data-proto": String(++protoPropsCalls) };
    }
    transform(node) {
      seenLabel = this.label;
      seenSym = this[metaSym];
      return node;
    }
  }
  const protoHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [new CustomDecoration()],
  });
  assert.equal(protoTagCalls, 1);
  assert.equal(protoPropsCalls, 1);
  assert.equal(seenLabel, "custom-label");
  assert.equal(seenSym, "symbol-meta");
  assert(protoHtml.includes('<mark data-proto="1">'));

  // 200-CJK-char custom property produces identical output in native and JS decoration renders.
  const cjkStyle = `--cjk:"${"漢".repeat(200)}"`;
  const nativeCjk = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [{ start: 0, end: 3, properties: { style: cjkStyle } }],
  });
  const jsCjk = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [{}],
    decorations: [{ start: 0, end: 3, properties: { style: cjkStyle } }],
  });
  assert.equal(nativeCjk, jsCjk);
  assert(nativeCjk.includes("--cjk:"));
  // Enumerable symbol metadata survives token construction and decoration merging
  // on both line targets (whole-line decoration) and token targets (partial-line decoration).
  const lineSymbol = Symbol("ferriki.test.line");
  const tokenSymbol = Symbol("ferriki.test.token");
  const spanSymbol = Symbol("ferriki.test.span");
  let seenLineSymbol;
  let seenLineTarget;
  highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        line(node) {
          node.properties[lineSymbol] = "preserved-line";
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 5,
        properties: { class: "marked" },
        transform(node, target) {
          seenLineTarget = target;
          seenLineSymbol = node.properties[lineSymbol];
          return node;
        },
      },
    ],
  });
  assert.equal(seenLineTarget, "line");
  assert.equal(seenLineSymbol, "preserved-line");

  let seenTokenSymbol;
  let seenSpanSymbol;
  let seenTokenTarget;
  highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        tokens(lines) {
          return lines.map((line) =>
            line.map((token) => ({ ...token, htmlAttrs: { [tokenSymbol]: "preserved-token" } })),
          );
        },
        span(node) {
          node.properties[spanSymbol] = "preserved-span";
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { class: "marked" },
        transform(node, target) {
          seenTokenTarget = target;
          seenTokenSymbol = node.properties[tokenSymbol];
          seenSpanSymbol = node.properties[spanSymbol];
          return node;
        },
      },
    ],
  });
  assert.equal(seenTokenTarget, "token");
  assert.equal(seenTokenSymbol, "preserved-token");
  assert.equal(seenSpanSymbol, "preserved-span");

  // Fix #1: When a `code` hook freezes `codeNode` and `codeNode.children` (and even when a
  // `pre` hook freezes `pre`) while a decoration callback freezes the decorated line,
  // `sanitizePendingDecorations` returns the rebuilt `codeNode` and `renderTransformedHast`
  // wires it into the serialized output so unsafe declarative CSS never leaks.
  const frozenCodeHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        code(node) {
          Object.freeze(node.children);
          return Object.freeze(node);
        },
        pre(node) {
          Object.freeze(node.children);
          return Object.freeze(node);
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 5,
        properties: { style: "color:red;background:url(https://evil.test)" },
        transform(node) {
          Object.freeze(node.properties);
          return Object.freeze(node);
        },
      },
    ],
  });
  assert(frozenCodeHtml.includes('style="color:red"'));
  assert(!frozenCodeHtml.includes("evil.test"));

  // Fix #3: Captured URL getter values are reused only while the original getter remains in
  // place; if a multiline decoration callback replaces `this.properties` for subsequent
  // sections, later sections read and validate the updated URL instead of the stale snapshot.
  let hrefGetterCalls = 0;
  const updatedUrlHtml = highlighter.codeToHtml("line1\nline2", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 5 },
        tagName: "a",
        properties: {
          get href() {
            hrefGetterCalls++;
            return "https://initial.example";
          },
        },
        transform(node) {
          this.properties = { href: "https://updated.example" };
          return node;
        },
      },
    ],
  });
  assert.equal(hrefGetterCalls, 1);
  assert(updatedUrlHtml.includes('href="https://initial.example"'));
  assert(updatedUrlHtml.includes('href="https://updated.example"'));

  assert.throws(
    () =>
      highlighter.codeToHtml("line1\nline2", {
        lang: "text",
        theme: "nord",
        decorations: [
          {
            start: { line: 0, character: 0 },
            end: { line: 1, character: 5 },
            tagName: "a",
            properties: {
              get href() {
                return "https://initial.example";
              },
            },
            transform(node) {
              this.properties = { href: "javascript:alert(1)" };
              return node;
            },
          },
        ],
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );

  // Fix #4: Non-primitive opaque style values with `toString()` are NOT coerced before
  // `decoration.transform` runs; they are coerced at most once during final sanitization if
  // retained, and never coerced if the callback replaces them.
  let lazySafeCalls = 0;
  let lazySafeValue = "not-ready";
  let lazySafeSawZeroBeforeTransform = false;
  const lazySafeHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: {
          style: {
            color: {
              toString() {
                lazySafeCalls++;
                return lazySafeValue;
              },
            },
          },
        },
        transform(node) {
          lazySafeSawZeroBeforeTransform = lazySafeCalls === 0;
          lazySafeValue = "green";
          return node;
        },
      },
    ],
  });
  assert.equal(lazySafeSawZeroBeforeTransform, true);
  assert.equal(lazySafeCalls, 1);
  assert(lazySafeHtml.includes('style="color:green"'));

  let lazyUnsafeCalls = 0;
  let lazyUnsafeValue = "not-ready";
  let lazyUnsafeSawZeroBeforeTransform = false;
  const lazyUnsafeHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: {
          style: {
            color: {
              toString() {
                lazyUnsafeCalls++;
                return lazyUnsafeValue;
              },
            },
          },
        },
        transform(node) {
          lazyUnsafeSawZeroBeforeTransform = lazyUnsafeCalls === 0;
          lazyUnsafeValue = "red; background:url(javascript:alert(1))";
          return node;
        },
      },
    ],
  });
  assert.equal(lazyUnsafeSawZeroBeforeTransform, true);
  assert.equal(lazyUnsafeCalls, 1);
  assert(!lazyUnsafeHtml.includes("javascript:"));
  assert(!lazyUnsafeHtml.includes("color:red"));

  let lazyReplacedCalls = 0;
  const lazyReplacedHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: {
          style: {
            color: {
              toString() {
                lazyReplacedCalls++;
                return "red";
              },
            },
          },
        },
        transform(node) {
          node.properties.style.color = "blue";
          return node;
        },
      },
    ],
  });
  assert.equal(lazyReplacedCalls, 0);
  assert(lazyReplacedHtml.includes('style="color:blue"'));

  let lazyArrayCalls = 0;
  let lazyArrayValue = "not-ready";
  let lazyArraySawZeroBeforeTransform = false;
  const lazyArrayHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: {
          style: [
            {
              toString() {
                lazyArrayCalls++;
                return lazyArrayValue;
              },
            },
          ],
        },
        transform(node) {
          lazyArraySawZeroBeforeTransform = lazyArrayCalls === 0;
          lazyArrayValue = "color:teal;background:url(https://evil.test)";
          return node;
        },
      },
    ],
  });
  assert.equal(lazyArraySawZeroBeforeTransform, true);
  assert.equal(lazyArrayCalls, 1);
  assert(lazyArrayHtml.includes('style="color:teal"'));
  assert(!lazyArrayHtml.includes("evil.test"));

  // Retiring earlier decoration style records on a node when a later decoration explicitly
  // replaces `style` ensures a rejected fragment from Decoration 1 does not strip a valid
  // declaration applied by Decoration 2 on the same node.
  const secondDecorationStyleHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [{}],
    decorations: [
      {
        start: 0,
        end: 5,
        properties: { style: { color: "red; font-weight:bold" } },
      },
      {
        start: 0,
        end: 5,
        properties: { style: "font-weight:bold" },
      },
    ],
  });
  assert(secondDecorationStyleHtml.includes('style="font-weight:bold"'));
  assert(!secondDecorationStyleHtml.includes("color:red"));

  // Moving a decorated node out of `<code>` into `<pre>` during a decoration callback still
  // sanitizes its declarative CSS because sanitization traverses the full emitted tree.
  let capturedPreNode;
  const movedToPreHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        pre(node) {
          capturedPreNode = node;
          return node;
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:orange;background:url(https://evil.test)" },
        transform(node) {
          capturedPreNode.children.push(node);
          return { type: "element", tagName: "span", properties: {}, children: [] };
        },
      },
    ],
  });
  assert(movedToPreHtml.includes('style="color:orange"'));
  assert(!movedToPreHtml.includes("evil.test"));

  // Reordering and cloning a line of repeated identical tokens with distinct per-token
  // declarative styles stays O(N) via combined structure+style indexing and sanitizes every
  // cloned token accurately.
  const runReorderedRepeated = (count) => {
    const sourceText = "x".repeat(count);
    const decorations = [];
    for (let index = 0; index < count; index++) {
      decorations.push({
        start: index,
        end: index + 1,
        properties: {
          style: `color:rgb(1,${(index >> 8) & 255},${index & 255});background:url(https://evil.test/${index})`,
        },
      });
    }
    decorations.push({
      start: 0,
      end: count,
      transform(node) {
        node.children = node.children.map((child) => structuredClone(child)).reverse();
        return node;
      },
    });
    const startMs = performance.now();
    const html = highlighter.codeToHtml(sourceText, {
      lang: "text",
      theme: "nord",
      transformers: [
        {
          tokens() {
            return [Array.from({ length: count }, (_, index) => ({ content: "x", offset: index }))];
          },
        },
      ],
      decorations,
    });
    return { html, elapsedMs: performance.now() - startMs };
  };
  const reorderedSmall = runReorderedRepeated(100);
  const reorderedLarge = runReorderedRepeated(400);
  assert(!reorderedSmall.html.includes("evil.test"));
  assert(!reorderedLarge.html.includes("evil.test"));
  assert(reorderedLarge.html.includes('style="color:rgb(1,0,0)"'));
  assert(reorderedLarge.html.includes('style="color:rgb(1,1,143)"'));
  assert(
    reorderedLarge.html.indexOf('style="color:rgb(1,1,143)"') <
      reorderedLarge.html.indexOf('style="color:rgb(1,0,0)"'),
  );
  assert(
    reorderedLarge.elapsedMs < Math.max(reorderedSmall.elapsedMs * 10, 500),
    `Expected linear scaling for reordered repeated tokens (100: ${reorderedSmall.elapsedMs}ms, 400: ${reorderedLarge.elapsedMs}ms)`,
  );

  // Reordering, cloning, AND appending a distinct callback-authored declaration to each clone
  // also stays O(N) via anchored unsafe-segment indexing (no O(N^2) scan over unsafe segments).
  const runReorderedAppended = (count) => {
    const sourceText = "x".repeat(count);
    const decorations = [];
    for (let index = 0; index < count; index++) {
      decorations.push({
        start: index,
        end: index + 1,
        properties: {
          style: `color:rgb(2,${(index >> 8) & 255},${index & 255});background:url(https://evil.test/${index})`,
        },
      });
    }
    decorations.push({
      start: 0,
      end: count,
      transform(node) {
        node.children = node.children
          .map((child, idx) => {
            const clone = structuredClone(child);
            clone.properties.style = `${clone.properties.style}; outline:${(idx % 5) + 1}px solid blue`;
            return clone;
          })
          .reverse();
        return node;
      },
    });
    const startMs = performance.now();
    const html = highlighter.codeToHtml(sourceText, {
      lang: "text",
      theme: "nord",
      transformers: [
        {
          tokens() {
            return [Array.from({ length: count }, (_, index) => ({ content: "x", offset: index }))];
          },
        },
      ],
      decorations,
    });
    return { html, elapsedMs: performance.now() - startMs };
  };
  const appendedSmall = runReorderedAppended(100);
  const appendedLarge = runReorderedAppended(400);
  assert(!appendedSmall.html.includes("evil.test"));
  assert(!appendedLarge.html.includes("evil.test"));
  assert(appendedLarge.html.includes('style="color:rgb(2,0,0);outline:1px solid blue"'));
  assert(appendedLarge.html.includes('style="color:rgb(2,1,143);outline:5px solid blue"'));
  assert(
    appendedLarge.elapsedMs < Math.max(appendedSmall.elapsedMs * 10, 500),
    `Expected linear scaling for reordered+appended clones (100: ${appendedSmall.elapsedMs}ms, 400: ${appendedLarge.elapsedMs}ms)`,
  );

  // Trusted inline `tokens` hooks with quoted `content` containing `</style>` are preserved
  // because inline style attributes HTML-escape `<` and `"` (stylesheet-only `</style>`
  // filtering stays in class mode).
  const inlineClosingStyleContentHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        tokens(lines) {
          return lines.map((line) =>
            line.map((token) => ({
              ...token,
              htmlStyle: { content: '"</style>"' },
            })),
          );
        },
      },
    ],
  });
  assert(inlineClosingStyleContentHtml.includes('style="content:&#x22;&#x3C;/style>&#x22;"'));

  // A decoration callback returning a wrapper with a partially read-only `children` array
  // (non-frozen array with a read-only slot) and a frozen styled child must not throw `TypeError`
  // when replacing the frozen child.
  for (const readOnlyIndex of [0, 1]) {
    const partialReadOnlyHtml = highlighter.codeToHtml("alpha", {
      lang: "text",
      theme: "nord",
      decorations: [
        {
          start: 0,
          end: 3,
          properties: { style: "color:green;background:url(https://evil.test)" },
          transform(node) {
            Object.freeze(node.properties);
            const frozenChild = Object.freeze(node);
            const sibling = {
              type: "element",
              tagName: "span",
              properties: {},
              children: [{ type: "text", value: "!" }],
            };
            const children = readOnlyIndex === 0 ? [frozenChild, sibling] : [sibling, frozenChild];
            Object.defineProperty(children, 0, {
              value: children[0],
              writable: false,
              configurable: false,
              enumerable: true,
            });
            return {
              type: "element",
              tagName: "span",
              properties: { class: "partial-ro" },
              children,
            };
          },
        },
      ],
    });
    assert(partialReadOnlyHtml.includes('style="color:green"'));
    assert(!partialReadOnlyHtml.includes("evil.test"));
  }

  // When `sanitizePendingDecorations` rebuilds frozen `<pre>` and `<code>` wrappers,
  // `this.pre` and `this.code` in the `root` hook stay synchronized with the emitted tree.
  let syncedPreMatch = false;
  let syncedCodeMatch = false;
  const syncedFrozenWrappersHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        code(node) {
          Object.freeze(node.children);
          return Object.freeze(node);
        },
        pre(node) {
          Object.freeze(node.children);
          return Object.freeze(node);
        },
        root(tree) {
          const emittedPre = tree.children[0];
          const emittedCode = emittedPre.children[0];
          syncedPreMatch = this.pre === emittedPre;
          syncedCodeMatch = this.code === emittedCode;
          this.code.properties = { ...this.code.properties, "data-synced": "yes" };
          return tree;
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 5,
        properties: { style: "color:red;background:url(https://evil.test)" },
        transform(node) {
          Object.freeze(node.properties);
          return Object.freeze(node);
        },
      },
    ],
  });
  assert.equal(syncedPreMatch, true);
  assert.equal(syncedCodeMatch, true);
  assert(syncedFrozenWrappersHtml.includes('data-synced="yes"'));
  assert(syncedFrozenWrappersHtml.includes('style="color:red"'));
  assert(!syncedFrozenWrappersHtml.includes("evil.test"));

  // Renaming camelCase style properties to kebab-case in a decoration callback still keeps
  // declarative values subject to sanitization.
  for (const mutateStyle of [
    (node) => {
      const bad = node.properties.style.backgroundColor;
      delete node.properties.style.backgroundColor;
      node.properties.style["background-color"] = bad;
    },
    (node) => {
      node.properties.style = {
        "background-color": node.properties.style.backgroundColor,
        color: node.properties.style.color,
      };
    },
  ]) {
    const renamedKeyHtml = highlighter.codeToHtml("alpha", {
      lang: "text",
      theme: "nord",
      decorations: [
        {
          start: 0,
          end: 3,
          properties: {
            style: { backgroundColor: "url(javascript:alert(1))", color: "blue" },
          },
          transform(node) {
            mutateStyle(node);
            return node;
          },
        },
      ],
    });
    assert(!renamedKeyHtml.includes("javascript:"));
    assert(renamedKeyHtml.includes('style="color:blue"'));
  }

  // Multi-target decorations with URL getters read and validate the getter once per target
  // so distinct safe per-line URLs are emitted and a malicious later target is rejected.
  let perTargetHrefCalls = 0;
  const perTargetUrlHtml = highlighter.codeToHtml("line1\nline2", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 5 },
        tagName: "a",
        properties: {
          get href() {
            return `https://line-${++perTargetHrefCalls}.example`;
          },
        },
      },
    ],
  });
  assert.equal(perTargetHrefCalls, 2);
  assert(perTargetUrlHtml.includes('href="https://line-1.example"'));
  assert(perTargetUrlHtml.includes('href="https://line-2.example"'));

  let hostileSecondTargetCalls = 0;
  assert.throws(
    () =>
      highlighter.codeToHtml("line1\nline2", {
        lang: "text",
        theme: "nord",
        decorations: [
          {
            start: { line: 0, character: 0 },
            end: { line: 1, character: 5 },
            tagName: "a",
            properties: {
              get href() {
                return ++hostileSecondTargetCalls === 1
                  ? "https://line-1.example"
                  : "javascript:alert(1)";
              },
            },
          },
        ],
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  assert.equal(hostileSecondTargetCalls, 2);

  // With `structure: "inline"` and decorations, post-hook `codeNode` line elements remain the
  // decoration targets (so a `code` hook cloning its lines passes those clones into decoration
  // callbacks and emits the decorated clones), while unrelated helper elements prepended to
  // `codeNode.children` are never flattened into inline output or given an extra `<br>`.
  const inlineHelperHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    transformers: [
      {
        code(node) {
          const helper = {
            type: "element",
            tagName: "span",
            properties: { class: "helper" },
            children: [{ type: "text", value: "HELPER-NOISE" }],
          };
          node.children = [helper, ...node.children];
          return node;
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:teal;background:url(https://evil.test)" },
      },
    ],
  });
  assert(!inlineHelperHtml.includes("HELPER-NOISE"));
  assert(!inlineHelperHtml.includes("<br>"));
  assert(!inlineHelperHtml.includes("evil.test"));
  assert(inlineHelperHtml.includes('style="color:teal"'));

  let inlineObservedCloneMarker;
  const inlineClonedCodeHookHtml = highlighter.codeToHtml("alpha\nbeta", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    transformers: [
      {
        code(node) {
          const helper = {
            type: "element",
            tagName: "span",
            properties: { class: "helper" },
            children: [{ type: "text", value: "HELPER-NOISE" }],
          };
          const clonedLines = this.lines.map((line) => ({
            ...line,
            properties: { ...line.properties, "data-from-code": "cloned" },
            children: line.children.map((child) => ({
              ...child,
              properties: { ...child.properties, "data-clone-token": "yes" },
            })),
          }));
          this.lines.splice(0, this.lines.length, ...clonedLines);
          node.children = [helper, ...clonedLines];
          return node;
        },
      },
    ],
    decorations: [
      {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
        transform(node, type) {
          if (type === "line") inlineObservedCloneMarker = node.properties["data-from-code"];
          return node;
        },
      },
      {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
        alwaysWrap: true,
        properties: {
          "data-decorated": "ok",
          style: "color:teal;background:url(https://evil.test)",
        },
      },
    ],
  });
  assert.equal(inlineObservedCloneMarker, "cloned");
  assert(!inlineClonedCodeHookHtml.includes("HELPER-NOISE"));
  assert(!inlineClonedCodeHookHtml.includes("evil.test"));
  assert.equal(inlineClonedCodeHookHtml.match(/<br>/gu)?.length, 1);
  assert(inlineClonedCodeHookHtml.includes('data-clone-token="yes"'));
  assert(inlineClonedCodeHookHtml.includes('data-decorated="ok"'));
  assert(inlineClonedCodeHookHtml.includes('style="color:teal"'));

  // A deep chain of 500 nested styled wrappers returning unchanged avoids O(N^2) path copies
  // and sanitizes every nested wrapper cleanly.
  const nestedDepth = 500;
  const deepNestedDecorations = [];
  for (let index = 0; index < nestedDepth; index++) {
    deepNestedDecorations.push({
      start: 0,
      end: 5,
      alwaysWrap: true,
      properties: { style: "color:red;background:url(https://evil.example/deep)" },
      transform: index === nestedDepth - 1 ? (node) => node : undefined,
    });
  }
  const deepNestedHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: deepNestedDecorations,
  });
  assert(!deepNestedHtml.includes("evil.example"));
  assert.equal(deepNestedHtml.match(/style="color:red"/gu)?.length, nestedDepth);

  // Copying a decorated node outside the callback's return subtree (e.g. appending a clone to
  // `<pre>`) still sanitizes its declarative CSS without touching unrelated callback-authored
  // siblings.
  let capturedPreForCopy;
  const copiedToPreHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        pre(node) {
          capturedPreForCopy = node;
          return node;
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background:url(javascript:alert(1))" },
        transform(node) {
          capturedPreForCopy.children.push(structuredClone(node));
          capturedPreForCopy.children.push({
            type: "element",
            tagName: "span",
            properties: { style: "background-image:url(/callback-only.png)" },
            children: [{ type: "text", value: "badge" }],
          });
          return node;
        },
      },
    ],
  });
  assert(!copiedToPreHtml.includes("javascript:"));
  assert.equal(copiedToPreHtml.match(/style="color:blue"/gu)?.length, 2);
  assert(copiedToPreHtml.includes('style="background-image:url(/callback-only.png)"'));

  // Independently authored siblings placed outside the callback subtree are preserved even if
  // their CSS text matches a decoration's unsafe style, while cloned copies of the decorated node
  // appended to `<pre>` still get sanitized.
  let capturedPreForSibling;
  const independentSiblingCss = "background-image:url(/icon.svg)";
  const independentSiblingHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        pre(node) {
          capturedPreForSibling = node;
          return node;
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: `color:blue;${independentSiblingCss}` },
        transform(node) {
          capturedPreForSibling.children.push(structuredClone(node));
          capturedPreForSibling.children.push({
            type: "element",
            tagName: "i",
            properties: { style: independentSiblingCss },
            children: [],
          });
          return node;
        },
      },
    ],
  });
  assert.equal(independentSiblingHtml.match(/style="color:blue"/gu)?.length, 2);
  assert.equal(independentSiblingHtml.match(/background-image:url\(\/icon\.svg\)/gu)?.length, 1);
  assert(independentSiblingHtml.includes(`<i style="${independentSiblingCss}"></i>`));

  // Matching whole `;`-delimited declaration segments prevents a malformed declarative style like
  // `"url"` from matching a substring inside a callback-authored replacement declaration.
  const malformedReplacedByCallbackHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "url" },
        transform(node) {
          node.properties.style = "background-image:url(/local.png)";
          return node;
        },
      },
    ],
  });
  assert(malformedReplacedByCallbackHtml.includes('style="background-image:url(/local.png)"'));

  // With `structure: "inline"` and decorations, mutating `this.lines` in place (even changing a
  // line's class to `"custom-line"`) updates the rendered output, whereas reassigning the
  // detached `code` wrapper's `node.children = [this.lines[0]]` never drops lines from output.
  const inlineCustomLineClassHtml = highlighter.codeToHtml("alpha\nbeta", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    transformers: [
      {
        code() {
          this.lines[0] = {
            ...this.lines[0],
            properties: { class: "custom-line" },
            children: this.lines[0].children.map((child) => ({
              ...child,
              properties: { ...child.properties, "data-line1": "yes" },
            })),
          };
        },
      },
    ],
    decorations: [
      {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
        alwaysWrap: true,
        properties: { "data-hit": "line1" },
      },
      {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 4 },
        alwaysWrap: true,
        properties: { "data-hit": "line2" },
      },
    ],
  });
  assert.equal(inlineCustomLineClassHtml.match(/<br>/gu)?.length, 1);
  assert.match(
    inlineCustomLineClassHtml,
    /<span data-hit="line1"><span[^>]*data-line1="yes"[^>]*>alpha<\/span><\/span><br><\/br><span data-hit="line2"><span[^>]*>beta<\/span><\/span>/u,
  );

  // Reassigning `node.children = [this.lines[0]]` on an inline `code` hook keeps the wrapper
  // detached from `this.lines` so ALL shared inline lines still render and receive decorations.
  const inlineReassignedSubsetHtml = highlighter.codeToHtml("alpha\nbeta", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    transformers: [
      {
        code(node) {
          node.children = [this.lines[0]];
        },
      },
    ],
    decorations: [
      {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
        alwaysWrap: true,
        properties: { "data-hit": "line1" },
      },
      {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 4 },
        alwaysWrap: true,
        properties: { "data-hit": "line2" },
      },
    ],
  });
  assert.equal(inlineReassignedSubsetHtml.match(/<br>/gu)?.length, 1);
  assert.match(
    inlineReassignedSubsetHtml,
    /<span data-hit="line1"><span[^>]*>alpha<\/span><\/span><br><\/br><span data-hit="line2"><span[^>]*>beta<\/span><\/span>/u,
  );

  // With `structure: "inline"` and nonempty `decorations`, reordering the shared `this.lines`
  // array inside a `code` hook remains visible to both decoration targeting and rendered output.
  const inlineReorderedLinesHtml = highlighter.codeToHtml("aaaa\nbbbb", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    transformers: [
      {
        code() {
          this.lines.reverse();
        },
      },
    ],
    decorations: [
      {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 4 },
        alwaysWrap: true,
        properties: { "data-slot": "first" },
      },
      {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 4 },
        alwaysWrap: true,
        properties: { "data-slot": "second" },
      },
    ],
  });
  assert.equal(inlineReorderedLinesHtml.match(/<br>/gu)?.length, 1);
  assert.match(
    inlineReorderedLinesHtml,
    /<span data-slot="first"><span[^>]*>bbbb<\/span><\/span><br><\/br><span data-slot="second"><span[^>]*>aaaa<\/span><\/span>/u,
  );

  // With `structure: "inline"` and decorations, returning a detached empty wrapper from a `code`
  // hook keeps the highlighted source lines from the shared `lines` array intact (matching
  // decoration-free inline rendering).
  const inlineDetachedEmptyCodeHtml = highlighter.codeToHtml("alpha\nbeta", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    transformers: [
      {
        code() {
          return { type: "element", tagName: "code", properties: {}, children: [] };
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { "data-kept": "yes", style: "color:teal;background:url(javascript:alert(1))" },
      },
    ],
  });
  assert(!inlineDetachedEmptyCodeHtml.includes("javascript:"));
  assert(inlineDetachedEmptyCodeHtml.includes('data-kept="yes"'));
  assert(inlineDetachedEmptyCodeHtml.includes('style="color:teal"'));
  assert(inlineDetachedEmptyCodeHtml.includes(">alp</span>"));
  assert(inlineDetachedEmptyCodeHtml.includes(">ha</span>"));
  assert(inlineDetachedEmptyCodeHtml.includes("<br>"));
  assert(inlineDetachedEmptyCodeHtml.includes(">beta</span>"));

  // Returning a detached replacement wrapper containing `[this.lines[0], helperElement]` from an
  // inline `code` hook never leaks `helperElement` into inline output or drops `this.lines[1]`.
  const inlineDetachedWithHelperHtml = highlighter.codeToHtml("alpha\nbeta", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    transformers: [
      {
        code() {
          const helperElement = {
            type: "element",
            tagName: "span",
            properties: { class: "detached-helper" },
            children: [{ type: "text", value: "DETACHED-NOISE" }],
          };
          return {
            type: "element",
            tagName: "code",
            properties: {},
            children: [this.lines[0], helperElement],
          };
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { "data-kept": "yes", style: "color:teal;background:url(javascript:alert(1))" },
      },
    ],
  });
  assert(!inlineDetachedWithHelperHtml.includes("DETACHED-NOISE"));
  assert(!inlineDetachedWithHelperHtml.includes("javascript:"));
  assert(inlineDetachedWithHelperHtml.includes('data-kept="yes"'));
  assert(inlineDetachedWithHelperHtml.includes('style="color:teal"'));
  assert(inlineDetachedWithHelperHtml.includes(">alp</span>"));
  assert(inlineDetachedWithHelperHtml.includes(">ha</span>"));
  assert(inlineDetachedWithHelperHtml.includes("<br>"));
  assert(inlineDetachedWithHelperHtml.includes(">beta</span>"));

  // Independently authoring a style on a second pre-existing identical-text sibling span inside a
  // decoration callback preserves the callback-authored style on that sibling even when it matches
  // a declaration stripped from the decorated span.
  let capturedSecondXSpan;
  const identicalTextSiblingCss = "background-image:url(/local.png)";
  const identicalTextSiblingCallbackHtml = highlighter.codeToHtml("xx!", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        tokens() {
          return [
            [
              { content: "x", offset: 0 },
              { content: "x", offset: 1 },
              { content: "!", offset: 2 },
            ],
          ];
        },
        span(node, _line, col) {
          if (col === 1) capturedSecondXSpan = node;
          return node;
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 1,
        properties: { style: identicalTextSiblingCss },
        transform(node) {
          capturedSecondXSpan.properties.style = identicalTextSiblingCss;
          return node;
        },
      },
    ],
  });
  assert.equal(
    identicalTextSiblingCallbackHtml.match(/background-image:url\(\/local\.png\)/gu)?.length,
    1,
  );
  assert(
    identicalTextSiblingCallbackHtml.includes(
      `<span>x</span><span style="${identicalTextSiblingCss}">x</span>`,
    ),
  );

  // In inline mode, freezing a decorated span whose style needs sanitizing syncs the sanitized
  // replacement back into `this.lines` and `this.code` so a `root` hook rebuilding from
  // `this.lines` cannot re-emit pre-sanitized CSS.
  let rootSawSanitizedInlineLine = false;
  const inlineFrozenLineSyncHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background:url(javascript:alert(1))" },
        transform(node) {
          return Object.freeze(node);
        },
      },
    ],
    transformers: [
      {
        root(node) {
          const lineChildren = this.lines[0]?.children || [];
          rootSawSanitizedInlineLine =
            lineChildren.some((child) => child?.properties?.style === "color:blue") &&
            lineChildren.every(
              (child) => !String(child?.properties?.style || "").includes("javascript:"),
            );
          return { ...node, children: [...lineChildren] };
        },
      },
    ],
  });
  assert.equal(rootSawSanitizedInlineLine, true);
  assert(!inlineFrozenLineSyncHtml.includes("javascript:"));
  assert(inlineFrozenLineSyncHtml.includes('style="color:blue"'));

  // `clonePropertiesWithUpdates` skips re-reading replaced getter properties on `node.properties`,
  // so a one-shot `get style()` getter that throws on a second read is evaluated only once.
  let oneShotStyleReads = 0;
  const oneShotStyleGetterHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background:url(javascript:alert(1))" },
        transform(node) {
          const nextProps = { ...node.properties };
          delete nextProps.style;
          Object.defineProperty(nextProps, "style", {
            enumerable: true,
            configurable: true,
            get() {
              oneShotStyleReads++;
              if (oneShotStyleReads > 1) throw new Error("style getter read more than once");
              return "color:blue;background:url(javascript:alert(1))";
            },
          });
          node.properties = nextProps;
          return node;
        },
      },
    ],
  });
  assert.equal(oneShotStyleReads, 1);
  assert(!oneShotStyleGetterHtml.includes("javascript:"));
  assert(oneShotStyleGetterHtml.includes('style="color:blue"'));

  // Accessor-backed `style` getters returning an already-canonical safe value are still
  // snapshotted into plain data properties so neither one-shot getters nor TOCTOU stateful
  // getters are evaluated a second time during HTML serialization.
  let safeOneShotReads = 0;
  const safeOneShotHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue" },
        transform(node) {
          const nextProps = { ...node.properties };
          delete nextProps.style;
          Object.defineProperty(nextProps, "style", {
            enumerable: true,
            configurable: true,
            get() {
              safeOneShotReads++;
              if (safeOneShotReads > 1) throw new Error("safe style getter read twice");
              return "color:blue";
            },
          });
          node.properties = nextProps;
          return node;
        },
      },
    ],
  });
  assert.equal(safeOneShotReads, 1);
  assert(safeOneShotHtml.includes('style="color:blue"'));

  let toctouStyleReads = 0;
  const toctouStyleGetterHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue" },
        transform(node) {
          const nextProps = { ...node.properties };
          delete nextProps.style;
          Object.defineProperty(nextProps, "style", {
            enumerable: true,
            configurable: true,
            get() {
              toctouStyleReads++;
              return toctouStyleReads === 1 ? "color:blue" : "background:url(https://evil.test)";
            },
          });
          node.properties = nextProps;
          return node;
        },
      },
    ],
  });
  assert.equal(toctouStyleReads, 1);
  assert(!toctouStyleGetterHtml.includes("evil.test"));
  assert(toctouStyleGetterHtml.includes('style="color:blue"'));

  // In inline mode, whole-line decorations with unsafe declarative CSS are sanitized on
  // `this.lines[i]` (both mutable and frozen) before `root` hooks can reuse `this.lines`.
  for (const freezeLine of [false, true]) {
    const inlineWholeLineReuseHtml = highlighter.codeToHtml("alpha", {
      lang: "text",
      theme: "nord",
      structure: "inline",
      decorations: [
        {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
          properties: { style: "color:teal;background:url(javascript:alert(1))" },
          transform: freezeLine ? (node) => Object.freeze(node) : undefined,
        },
      ],
      transformers: [
        {
          root(node) {
            return { ...node, children: [...this.lines] };
          },
        },
      ],
    });
    assert(!inlineWholeLineReuseHtml.includes("javascript:"));
    assert(inlineWholeLineReuseHtml.includes('style="color:teal"'));
  }

  // Clearing `node.children = []` on an inline `code` hook without mutating `this.lines` keeps
  // the shared inline source lines intact when decorations are present.
  const inlineClearedCodeChildrenHtml = highlighter.codeToHtml("alpha\nbeta", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    transformers: [
      {
        code(node) {
          node.children = [];
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { "data-kept": "yes", style: "color:teal;background:url(javascript:alert(1))" },
      },
    ],
  });
  assert(!inlineClearedCodeChildrenHtml.includes("javascript:"));
  assert(inlineClearedCodeChildrenHtml.includes('data-kept="yes"'));
  assert(inlineClearedCodeChildrenHtml.includes('style="color:teal"'));
  assert(inlineClearedCodeChildrenHtml.includes(">alp</span>"));
  assert(inlineClearedCodeChildrenHtml.includes("<br>"));
  assert(inlineClearedCodeChildrenHtml.includes(">beta</span>"));

  // `clonePropertiesWithUpdates` preserves unrelated attribute getters without evaluating them
  // eagerly during style sanitization, so getters still observe state mutated in `root` hooks.
  let dataState = "before-root";
  let dataStateReads = 0;
  const deferredAttrGetterHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background:url(javascript:alert(1))" },
        transform(node) {
          Object.defineProperty(node.properties, "data-state", {
            enumerable: true,
            configurable: true,
            get() {
              dataStateReads++;
              return dataState;
            },
          });
          return node;
        },
      },
    ],
    transformers: [
      {
        root(node) {
          assert.equal(dataStateReads, 0);
          dataState = "after-root";
          return node;
        },
      },
    ],
  });
  assert(!deferredAttrGetterHtml.includes("javascript:"));
  assert(deferredAttrGetterHtml.includes('style="color:blue"'));
  assert(deferredAttrGetterHtml.includes('data-state="after-root"'));

  // Combining declarative styles from two decorations onto an external clone sanitizes against
  // ALL matching provenance records (without breaking after the first record in a shared bucket).
  let capturedPreForMulti;
  let capturedFirstDecorated;
  const multiRecordExternalCloneHtml = highlighter.codeToHtml("xx!", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        tokens() {
          return [
            [
              { content: "x", offset: 0 },
              { content: "x", offset: 1 },
              { content: "!", offset: 2 },
            ],
          ];
        },
        pre(node) {
          capturedPreForMulti = node;
          return node;
        },
      },
    ],
    decorations: [
      {
        start: 1,
        end: 2,
        properties: {
          style: "color:blue;background:url(https://shared-evil.test);outline:expression(alert(1))",
        },
        transform(node) {
          capturedFirstDecorated = node;
          return node;
        },
      },
      {
        start: 0,
        end: 1,
        properties: {
          style: "color:blue;background:url(https://shared-evil.test);border:expression(alert(2))",
        },
        transform(node) {
          const clone = structuredClone(node);
          clone.properties.style = `${capturedFirstDecorated.properties.style};${node.properties.style};font-weight:bold`;
          capturedPreForMulti.children.push(clone);
          return node;
        },
      },
    ],
  });
  assert(!multiRecordExternalCloneHtml.includes("shared-evil.test"));
  assert(!multiRecordExternalCloneHtml.includes("alert(1)"));
  assert(!multiRecordExternalCloneHtml.includes("alert(2)"));
  assert(multiRecordExternalCloneHtml.includes("font-weight:bold"));
  assert(multiRecordExternalCloneHtml.includes("color:blue"));

  // Appending an extra line in place via `this.lines.push(...)` inside an inline `code` hook
  // preserves the appended line alongside decorated source lines.
  const inlinePushedLineHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    transformers: [
      {
        code() {
          this.lines.push({
            type: "element",
            tagName: "span",
            properties: { class: "line" },
            children: [
              {
                type: "element",
                tagName: "span",
                properties: {},
                children: [{ type: "text", value: "EXTRA" }],
              },
            ],
          });
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { "data-kept": "yes", style: "color:teal;background:url(javascript:alert(1))" },
      },
    ],
  });
  assert(!inlinePushedLineHtml.includes("javascript:"));
  assert(inlinePushedLineHtml.includes('data-kept="yes"'));
  assert(inlinePushedLineHtml.includes('style="color:teal"'));
  assert(inlinePushedLineHtml.includes(">alp</span>"));
  assert(inlinePushedLineHtml.includes("<br></br><span>EXTRA</span>"));

  // Reserializing a declarative style in `decoration.transform` with different property casing,
  // whitespace, or quote/unquoted `url(...)` spelling still matches and strips the declarative
  // unsafe declaration while preserving safe declarations and callback-authored styles.
  const reserializedUrlStyleHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: 'background-image: url("https://evil.test/x.png"); color: red' },
        transform(node) {
          node.properties.style =
            "BACKGROUND-IMAGE:URL('https://evil.test/x.png');color:red;background-image:url(/local.png)";
          return node;
        },
      },
    ],
  });
  assert(!reserializedUrlStyleHtml.includes("evil.test"));
  assert(reserializedUrlStyleHtml.includes('style="color:red;background-image:url(/local.png)"'));

  // Capturing declarative style entries ONCE per DecorationItem before the first callback runs
  // ensures callback-authored additions to a shared `style` object survive on ALL lines while
  // the original unsafe declarative CSS is stripped on every line.
  const sharedMultiLineStyle = { color: "blue", background: "url(https://evil.test/shared-multi)" };
  const multiLineSharedStyleHtml = highlighter.codeToHtml("line1\nline2", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 5 },
        properties: { style: sharedMultiLineStyle },
        transform(node) {
          node.properties.style["background-image"] = "url(/marker.svg)";
          return node;
        },
      },
    ],
  });
  assert(!multiLineSharedStyleHtml.includes("evil.test"));
  assert.equal(
    multiLineSharedStyleHtml.match(/style="color:blue;background-image:url\(\/marker\.svg\)"/gu)
      ?.length,
    2,
  );

  // In `structure: "inline"`, replacing a whole line inside a decoration callback syncs the
  // replacement node back into `this.lines` so `root` hooks inspecting/reusing `this.lines`
  // observe the replaced line.
  let rootSawReplacedInlineLine = false;
  const inlineWholeLineReplacedHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    decorations: [
      {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
        transform(node, type) {
          if (type !== "line") return node;
          return {
            ...node,
            properties: { ...node.properties, "data-replaced-line": "yes" },
          };
        },
      },
    ],
    transformers: [
      {
        root(node) {
          rootSawReplacedInlineLine = this.lines[0]?.properties?.["data-replaced-line"] === "yes";
          return { ...node, children: [...this.lines] };
        },
      },
    ],
  });
  assert.equal(rootSawReplacedInlineLine, true);
  assert(inlineWholeLineReplacedHtml.includes('data-replaced-line="yes"'));

  // An unrelated callback-authored `style` getter (whose value does not match any declarative
  // style) stays lazy through style sanitization so it still observes state mutated in `root`.
  let callbackStyleState = "padding:1px";
  const lazyCallbackStyleGetterHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:red" },
        transform(node) {
          const nextProps = { ...node.properties };
          delete nextProps.style;
          Object.defineProperty(nextProps, "style", {
            enumerable: true,
            configurable: true,
            get() {
              return callbackStyleState;
            },
          });
          node.properties = nextProps;
          return node;
        },
      },
    ],
    transformers: [
      {
        root(node) {
          callbackStyleState = "padding:4px";
          return node;
        },
      },
    ],
  });
  assert(lazyCallbackStyleGetterHtml.includes('style="padding:4px"'));

  // When a decoration specifies both `class` and `style`, `addClassToHast` replaces
  // `node.properties` before `decoration.transform` runs; recording the post-`addClassToHast`
  // `node.properties` object ensures copying `otherExistingSpan.properties = node.properties`
  // still sanitizes the copied declarative CSS on `otherExistingSpan`.
  let capturedOtherSpan;
  const sharedPostClassPropsHtml = highlighter.codeToHtml("xy!", {
    lang: "text",
    theme: "nord",
    transformers: [
      {
        tokens() {
          return [
            [
              { content: "x", offset: 0 },
              { content: "y", offset: 1 },
              { content: "!", offset: 2 },
            ],
          ];
        },
        span(node, _line, col) {
          if (col === 1) capturedOtherSpan = node;
          return node;
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 1,
        properties: {
          class: "marked",
          style: "color:teal;background-image:url(https://evil.test/post-class-props)",
        },
        transform(node) {
          capturedOtherSpan.properties = node.properties;
          return node;
        },
      },
    ],
  });
  assert(!sharedPostClassPropsHtml.includes("evil.test"));
  assert.equal(sharedPostClassPropsHtml.match(/class="marked"/gu)?.length, 2);
  assert.equal(sharedPostClassPropsHtml.match(/style="color:teal"/gu)?.length, 2);

  // In `structure: "inline"`, mutating `this.lines` (captured in a `code` hook) inside a
  // decoration callback (e.g. `capturedLines.reverse()`) is preserved in the rendered output.
  let capturedInlineLines;
  const inlineCallbackReversedLinesHtml = highlighter.codeToHtml("aaaa\nbbbb", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    transformers: [
      {
        code() {
          capturedInlineLines = this.lines;
        },
      },
    ],
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { "data-decorated": "first" },
        transform(node) {
          capturedInlineLines.reverse();
          return node;
        },
      },
    ],
  });
  assert.equal(inlineCallbackReversedLinesHtml.match(/<br>/gu)?.length, 1);
  assert.match(
    inlineCallbackReversedLinesHtml,
    /<span[^>]*>bbbb<\/span><br><\/br><span[^>]*data-decorated="first"[^>]*>aaa<\/span><span[^>]*>a<\/span>/u,
  );

  // When a decoration callback returns a node whose `properties` is an accessor-backed
  // getter/setter that ignores writes, sanitization installs a replacement node with an own
  // data `properties` object instead of assuming in-place assignment succeeded.
  const ignoredPropertiesSetterHtml = highlighter.codeToHtml("alpha", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 3,
        properties: { style: "color:blue;background:url(https://evil.test/ignored-setter)" },
        transform(node) {
          const rawProperties = node.properties;
          const wrapped = { ...node };
          delete wrapped.properties;
          Object.defineProperty(wrapped, "properties", {
            enumerable: true,
            configurable: true,
            get() {
              return rawProperties;
            },
            set() {
              // Intentionally ignore writes so only node replacement can sanitize `properties`.
            },
          });
          return wrapped;
        },
      },
    ],
  });
  assert(!ignoredPropertiesSetterHtml.includes("evil.test"));
  assert(ignoredPropertiesSetterHtml.includes('style="color:blue"'));

  // In `structure: "inline"`, when a `line` hook returns the same shared HAST node for two lines
  // and a whole-line decoration replaces only line 2, replacement maps back to line 2's original
  // slot rather than overwriting line 1 via `lines.indexOf(...)`.
  let sharedInlineLineNode;
  const inlineDuplicateLineReplaceHtml = highlighter.codeToHtml("aaaa\naaaa", {
    lang: "text",
    theme: "nord",
    structure: "inline",
    transformers: [
      {
        line(node, line) {
          if (line === 1) {
            sharedInlineLineNode = node;
            return node;
          }
          return sharedInlineLineNode;
        },
      },
    ],
    decorations: [
      {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 4 },
        transform(node, type) {
          if (type !== "line") return node;
          return {
            type: "element",
            tagName: "span",
            properties: { class: "line" },
            children: [
              {
                type: "element",
                tagName: "span",
                properties: {},
                children: [{ type: "text", value: "REPLACED" }],
              },
            ],
          };
        },
      },
    ],
  });
  assert.equal(inlineDuplicateLineReplaceHtml.match(/<br>/gu)?.length, 1);
  assert.match(
    inlineDuplicateLineReplaceHtml,
    /<span[^>]*>aaaa<\/span><br><\/br><span>REPLACED<\/span>/u,
  );

  // Callback-free multi-line styled decorations pre-sanitize once per decoration without per-line
  // provenance tracking, producing identical sanitized HTML across all lines for both string and
  // object styles (and omitting empty sanitized styles).
  const multiLineSource = Array.from({ length: 40 }, (_, index) => `line${index}`).join("\n");
  const callbackFreeStringHtml = highlighter.codeToHtml(multiLineSource, {
    lang: "text",
    theme: "nord",
    transformers: [{}],
    decorations: [
      {
        start: { line: 0, character: 0 },
        end: { line: 39, character: 6 },
        properties: { style: "color:teal;background:url(https://evil.test/cb-free)" },
      },
    ],
  });
  assert(!callbackFreeStringHtml.includes("evil.test"));
  assert.equal(callbackFreeStringHtml.match(/style="color:teal"/gu)?.length, 40);

  const callbackFreeObjectHtml = highlighter.codeToHtml("line0\nline1\nline2", {
    lang: "text",
    theme: "nord",
    transformers: [{}],
    decorations: [
      {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 5 },
        properties: { style: { color: "teal", background: "url(https://evil.test/cb-free-obj)" } },
      },
      {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 5 },
        properties: { style: "background:url(https://evil.test/only-unsafe)" },
      },
    ],
  });
  assert(!callbackFreeObjectHtml.includes("evil.test"));
  assert.equal(callbackFreeObjectHtml.match(/style="color:teal"/gu)?.length, 2);
  assert(!callbackFreeObjectHtml.includes('style=""'));

  assert.throws(
    () =>
      highlighter.codeToHtml("", {
        lang: "text",
        theme: "nord",
        decorations: [{ start: 0, end: 0 }],
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  let proxyReads = 0;
  const proxyProperties = new Proxy(
    { class: "mark" },
    {
      get(target, key, receiver) {
        proxyReads++;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const proxyOptions = {
    lang: "text",
    theme: "nord",
    decorations: [{ start: 0, end: 5, properties: proxyProperties }],
  };
  const proxyBaseline = highlighter.codeToHtml("alpha", { ...proxyOptions, transformers: [{}] });
  const expectedProxyReads = proxyReads;
  proxyReads = 0;
  calls = [];
  assert.equal(highlighter.codeToHtml("alpha", proxyOptions), proxyBaseline);
  assert.equal(proxyReads, expectedProxyReads);
  assert(!calls.some((call) => call.name === "codeToHtmlWithDecorations"));
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
  const limited = {
    lang: "javascript",
    theme: "nord",
    tokenizeMaxLineLength: 1,
    decorations: [{ start: 6, end: 11, properties: { class: "mark" } }],
  };
  assert.equal(
    highlighter.codeToHtml("const value = 1", limited),
    highlighter.codeToHtml("const value = 1", { ...limited, transformers: [{}] }),
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
