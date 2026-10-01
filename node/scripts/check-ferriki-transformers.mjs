import assert from "node:assert/strict";
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
    for (const method of [
      "codeToHtml",
      "codeToHtmlWithCss",
      "codeToHast",
      "codeToTokens",
      "codeToTokensBase",
      "codeToTokensWithThemes",
    ]) {
      for (const selection of [undefined, [], [marker("override")]]) {
        calls.length = 0;
        const options = {
          lang: "javascript",
          ...(method === "codeToTokensWithThemes"
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
        if (method === "codeToHtml" || method === "codeToHtmlWithCss") {
          expected.push(...names.map((name) => `postprocess:${name}`));
          const html = typeof result === "string" ? result : result.html;
          if (names.length) assert.match(html, new RegExp(`data-transformer="${names.at(-1)}"`));
          else assert.doesNotMatch(html, /data-transformer/);
        }
        if (method === "codeToHast") {
          assert.equal(result.children[0].properties["data-transformer"], names.at(-1));
        }
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

console.log("Ferriki transformer and decoration contract verified");
