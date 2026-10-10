import assert from "node:assert/strict";
import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import { createHighlighter, createHighlighterCoreSync, ShikiError } from "../ferriki/index.mjs";
import "./test-asset-env.mjs";

const highlighter = await createHighlighter({
  langs: ["javascript"],
  themes: ["nord"],
});

try {
  const calls = [];
  const html = highlighter.codeToHtml("const answer = 42", {
    lang: "javascript",
    theme: "nord",
    meta: { title: "demo" },
    transformers: [
      {
        preprocess(code) {
          calls.push("preprocess");
          return code;
        },
        tokens(tokens) {
          calls.push("tokens");
          return tokens;
        },
        span(node) {
          calls.push("span");
          node.properties.class = "token";
          return node;
        },
        line(node) {
          calls.push("line");
          return node;
        },
        code(node) {
          calls.push("code");
          return node;
        },
        pre(node) {
          calls.push("pre");
          return node;
        },
        root(node) {
          calls.push("root");
          return node;
        },
        postprocess(value) {
          calls.push("postprocess");
          return `${value}<!-- transformed -->`;
        },
      },
    ],
  });
  assert.match(html, /title="demo"/);
  assert.match(html, /class="token"/);
  assert.match(html, /<!-- transformed -->/);
  assert.deepEqual(calls.slice(0, 3), ["preprocess", "tokens", "span"]);
  assert.equal(calls.at(-1), "postprocess");
  assert(calls.includes("line"));
  assert(calls.includes("code"));
  assert(calls.includes("pre"));
  assert(calls.includes("root"));

  const decorated = highlighter.codeToHtml("alpha\nbeta", {
    lang: "text",
    theme: "nord",
    decorations: [
      {
        start: { line: 0, character: 1 },
        end: { line: 1, character: 2 },
        properties: { class: "marked" },
      },
    ],
  });
  assert.match(decorated, /class="marked"/);

  assert.throws(
    () =>
      highlighter.codeToHtml("alpha", {
        lang: "text",
        theme: "nord",
        decorations: [{ start: 3, end: 1 }],
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
} finally {
  highlighter.dispose();
}

for (const create of [createHighlighter, createHighlighterCoreSync]) {
  const calls = [];
  const marker = (name, enforce) => ({
    name,
    enforce,
    preprocess(code, options) {
      assert.equal(this.options, options);
      assert.equal(this.codeToHast, undefined);
      assert.equal(this.codeToTokens, undefined);
      assert(options.transformers.some((transformer) => transformer.name === name));
      calls.push(`preprocess:${name}`);
      return code;
    },
    tokens(tokens) {
      calls.push(`tokens:${name}`);
      return tokens;
    },
    pre(node) {
      node.properties["data-transformer"] = name;
    },
    postprocess(html) {
      calls.push(`postprocess:${name}`);
      return `${html}<!-- ${name} -->`;
    },
  });
  const defaults = [marker("normal"), marker("post", "post"), marker("pre", "pre")];
  const configured = await create({
    langs: ["javascript"],
    themes: ["nord", "github-light-default"],
    transformers: defaults,
  });
  // The constructor snapshots the list without sorting or retaining the caller's array.
  assert.deepEqual(
    defaults.map((transformer) => transformer.name),
    ["normal", "post", "pre"],
  );
  defaults.push(marker("late"));

  try {
    for (const removedMethod of [
      "codeToHast",
      "codeToTokens",
      "codeToTokensBase",
      "codeToTokensWithThemes",
    ]) {
      assert.equal(typeof configured[removedMethod], "undefined");
    }
    for (const method of ["codeToHtml", "codeToHtmlWithCss"]) {
      for (const selection of [undefined, [], [marker("override")]]) {
        calls.length = 0;
        const options = {
          lang: "javascript",
          ...(method === "codeToHtmlWithCss"
            ? { themes: { light: "github-light-default", dark: "nord" } }
            : { theme: "nord" }),
          ...(selection === undefined ? {} : { transformers: selection }),
        };
        const result = configured[method]("const answer = 42", options);
        const names =
          selection === undefined ? ["pre", "normal", "post"] : selection.map((t) => t.name);
        const expected = [
          ...names.map((name) => `preprocess:${name}`),
          ...names.map((name) => `tokens:${name}`),
        ];
        expected.push(...names.map((name) => `postprocess:${name}`));
        const html = typeof result === "string" ? result : result.html;
        if (names.length) assert.match(html, new RegExp(`data-transformer="${names.at(-1)}"`));
        else assert.doesNotMatch(html, /data-transformer/);
        assert.deepEqual(calls, expected, `${create.name}.${method}`);
        assert.equal(Object.hasOwn(options, "transformers"), selection !== undefined);
      }
    }
    assert.throws(
      () => configured.codeToHtml("code", "invalid"),
      (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
    );
  } finally {
    configured.dispose();
  }
}

assert.throws(
  () => createHighlighterCoreSync({ transformers: {} }),
  (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
);
await assert.rejects(
  createHighlighter({ transformers: {} }),
  (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
);

const renderLanguage = {
  name: "ferriki-rendering",
  scopeName: "source.ferriki-rendering",
  patterns: [{ match: "\\bstyled\\b", name: "keyword.styled" }],
};
const renderTheme = {
  name: "ferriki-rendering-theme",
  type: "light",
  fg: "#111111",
  bg: "#ffffff",
  settings: [
    {
      scope: "keyword.styled",
      settings: {
        foreground: "#ff00aa",
        fontStyle: "italic bold underline strikethrough",
      },
    },
  ],
};
const renderDarkTheme = {
  ...renderTheme,
  name: "ferriki-rendering-dark",
  type: "dark",
  fg: "#eeeeee",
  bg: "#111111",
  settings: [
    {
      scope: "keyword.styled",
      settings: {
        foreground: "#55aaff",
        fontStyle: "italic bold underline strikethrough",
      },
    },
  ],
};
const renderHighlighter = await createHighlighter({
  langs: [renderLanguage],
  themes: [renderTheme, renderDarkTheme],
});
try {
  const baseOptions = { lang: renderLanguage.name, theme: renderTheme.name };
  const assertSingleThemeStyles = (html) => {
    assert.match(html, /class="shiki ferriki-rendering-theme"/);
    assert.match(html, /color:#ff00aa/i);
    assert.match(html, /font-style:italic/);
    assert.match(html, /font-weight:bold/);
    assert.match(html, /text-decoration:underline line-through/);
  };

  assertSingleThemeStyles(renderHighlighter.codeToHtml("styled", baseOptions));
  for (const meta of [{}, { __raw: "" }, { __raw: "{1}" }])
    assertSingleThemeStyles(renderHighlighter.codeToHtml("styled", { ...baseOptions, meta }));
  for (const transformers of [[{}], [{ tokens: (tokens) => tokens }]])
    assertSingleThemeStyles(
      renderHighlighter.codeToHtml("styled", { ...baseOptions, transformers }),
    );
  const metadataHtml = renderHighlighter.codeToHtml("styled", {
    ...baseOptions,
    meta: {},
  });
  assertSingleThemeStyles(metadataHtml);

  const callbackOnlyData = {
    marker: "callback-only",
    private: { value: "must-not-be-serialized" },
  };
  let receivedCallbackData;
  const callbackDataHtml = renderHighlighter.codeToHtml("styled", {
    ...baseOptions,
    data: callbackOnlyData,
    transformers: [
      {
        pre(node) {
          receivedCallbackData = node.data;
          node.properties["data-callback-marker"] = node.data?.marker;
          return node;
        },
      },
    ],
  });
  assert.equal(receivedCallbackData, callbackOnlyData);
  assert.match(callbackDataHtml, /data-callback-marker="callback-only"/);
  assert.doesNotMatch(callbackDataHtml, /must-not-be-serialized/);

  let callbackToken;
  const callbackHtml = renderHighlighter.codeToHtml("styled", {
    ...baseOptions,
    transformers: [
      {
        tokens(lines) {
          callbackToken = lines[0][0];
          return lines;
        },
      },
    ],
  });
  assertSingleThemeStyles(callbackHtml);
  assert.equal(callbackToken.color, "#FF00AA");
  assert.equal(callbackToken.fontStyle, 15);

  const suppressedStyle = renderHighlighter.codeToHtml("styled", {
    ...baseOptions,
    transformers: [
      {
        tokens(lines) {
          return lines.map((line) => line.map((token) => ({ ...token, htmlStyle: "" })));
        },
      },
    ],
  });
  assert.match(suppressedStyle, /class="shiki ferriki-rendering-theme"/);
  assert.doesNotMatch(suppressedStyle, /color:#ff00aa|font-style:italic|font-weight:bold/i);

  const changedTokenStyle = renderHighlighter.codeToHtml("styled", {
    ...baseOptions,
    transformers: [
      {
        tokens(lines) {
          return lines.map((line) =>
            line.map((token) => ({ ...token, color: "#123456", fontStyle: 2 })),
          );
        },
      },
    ],
  });
  assert.match(changedTokenStyle, /color:#123456/i);
  assert.match(changedTokenStyle, /font-weight:bold/);
  assert.doesNotMatch(changedTokenStyle, /color:#ff00aa|font-style:italic|text-decoration:/i);

  const grammarState = renderHighlighter.getLastGrammarState("styled", baseOptions);
  assertSingleThemeStyles(renderHighlighter.codeToHtml("styled", { ...baseOptions, grammarState }));
  const grammarStateHtml = renderHighlighter.codeToHtml("styled", {
    ...baseOptions,
    grammarState,
  });
  assertSingleThemeStyles(grammarStateHtml);

  const decorated = renderHighlighter.codeToHtml("styled", {
    ...baseOptions,
    decorations: [
      {
        start: { line: 0, character: 1 },
        end: { line: 0, character: 5 },
        properties: { class: "marked" },
      },
    ],
  });
  assertSingleThemeStyles(decorated);
  assert.match(decorated, /class="marked"/);

  const classMode = renderHighlighter.codeToHtml("styled", {
    ...baseOptions,
    meta: {},
    styleMode: "classes",
  });
  assert.match(classMode, /class="ferriki ferriki-rendering-theme(?: |")/);
  assert.doesNotMatch(classMode, /class="shiki ferriki-rendering-theme"/);

  const noneTheme = renderHighlighter.codeToHtml("styled", {
    lang: renderLanguage.name,
    theme: "none",
    meta: {},
  });
  assert.match(noneTheme, /class="none"/);
  assert.doesNotMatch(noneTheme, /class="shiki none"|color:#ff00aa/i);

  const multiTheme = renderHighlighter.codeToHtml("styled", {
    lang: renderLanguage.name,
    themes: { light: renderTheme.name, dark: renderDarkTheme.name },
    meta: {},
  });
  assert.match(
    multiTheme,
    /class="shiki shiki-themes ferriki-rendering-theme ferriki-rendering-dark"/,
  );
  assert.match(multiTheme, /color:#ff00aa/i);
  assert.match(multiTheme, /--shiki-dark:#55aaff/i);
} finally {
  renderHighlighter.dispose();
}

// Context fields reflect construction stages; declaration guarantees must not
// promise wrappers before they exist or a <pre> for inline output.
const contextHighlighter = createHighlighterCoreSync({ themes: [renderTheme, renderDarkTheme] });
try {
  for (const structure of ["classic", "inline"])
    for (const styleMode of ["inline", "classes"]) {
      const calls = [];
      let renderMeta;
      let postprocessMeta;
      let originalRoot;
      const transformer = {
        preprocess(source, options) {
          calls.push("preprocess");
          assert.equal(this.options, options);
          this.meta.marker = "shared render metadata";
          renderMeta = this.meta;
          return `${source}!`;
        },
        tokens(tokens) {
          calls.push("tokens");
          assert.equal(this.source, "A😀<&!");
          assert.equal(this.meta, renderMeta);
          assert.equal(this.root, undefined);
          return tokens;
        },
        span(node, line, column, lineElement, token) {
          calls.push("span");
          assert.equal(this.meta, renderMeta);
          assert.equal(this.source, "A😀<&!");
          assert.equal(this.pre, undefined);
          assert.equal(this.code, undefined);
          assert.equal(this.lines.length, 0);
          assert.equal(line, 1);
          assert.equal(this.tokens[0][column], token);
          assert.equal(lineElement.tagName, "span");
          originalRoot = this.root;
          node.properties["data-mutated"] = "yes";
          // An omitted return retains this in-place mutation.
        },
        line(node) {
          calls.push("line");
          assert.equal(this.pre, undefined);
          assert.equal(this.code, undefined);
          return { ...node, properties: { ...node.properties, "data-line": "replacement" } };
        },
        code(node) {
          calls.push("code");
          assert.equal(this.code, node);
          assert.equal(this.lines.length, 1);
          assert.equal(this.lines[0].properties["data-line"], "replacement");
          assert.equal(this.pre?.tagName, structure === "classic" ? "pre" : undefined);
        },
        pre(node) {
          calls.push("pre");
          assert.equal(structure, "classic");
          assert.equal(this.pre, node);
          return { ...node, properties: { ...node.properties, "data-pre": "replacement" } };
        },
        root(node) {
          calls.push("root");
          assert.equal(this.root, originalRoot);
          assert.equal(this.meta, renderMeta);
          assert.equal(this.code.tagName, "code");
          assert.equal(
            this.pre?.properties["data-pre"],
            structure === "classic" ? "replacement" : undefined,
          );
          assert.equal(JSON.stringify(node).includes('"marked"'), true);
          return { ...node, children: [...node.children] };
        },
        postprocess(html, options) {
          calls.push("postprocess");
          assert.equal(this.options, options);
          assert.notEqual(this.meta, renderMeta);
          assert.deepEqual(this.meta, {});
          assert.equal(this.root, undefined);
          postprocessMeta = this.meta;
          this.meta.marker = "shared postprocess metadata";
          return `${html}<!-- first -->`;
        },
      };
      const html = contextHighlighter.codeToHtml("A😀<&", {
        lang: "text",
        structure,
        styleMode,
        themes: { light: renderTheme.name, dark: renderDarkTheme.name },
        decorations: [{ start: 1, end: 3, properties: { class: "marked" } }],
        transformers: [
          transformer,
          {
            postprocess(html) {
              assert.equal(this.meta, postprocessMeta);
              assert.equal(this.meta.marker, "shared postprocess metadata");
              return `${html}<!-- second -->`;
            },
          },
        ],
      });
      assert.match(html, /data-mutated="yes"/);
      assert.equal(toString(fromHtml(html, { fragment: true })), "A😀<&!");
      assert.match(html, /<!-- first --><!-- second -->$/);
      assert.deepEqual(
        calls.filter((call) => call !== "span"),
        [
          "preprocess",
          "tokens",
          "line",
          "code",
          ...(structure === "classic" ? ["pre"] : []),
          "root",
          "postprocess",
        ],
      );
    }

  const failure = new Error("callback contract failure");
  let reachedRoot = false;
  assert.throws(
    () =>
      contextHighlighter.codeToHtml("text", {
        lang: "text",
        theme: renderTheme.name,
        transformers: [
          {
            tokens() {
              throw failure;
            },
            root() {
              reachedRoot = true;
            },
          },
        ],
      }),
    (error) => error === failure,
  );
  assert.equal(reachedRoot, false);
  assert.match(
    contextHighlighter.codeToHtml("text", { lang: "text", theme: renderTheme.name }),
    /text/,
  );
} finally {
  contextHighlighter.dispose();
}

console.log("Ferriki transformer and decoration contract verified");
