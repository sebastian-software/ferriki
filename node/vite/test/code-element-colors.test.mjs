import { describe, expect, it } from "vitest";
import { createHighlighter } from "../../ferriki/index.mjs";

import {
  CODE_ELEMENT_COLOR_CATEGORIES,
  CODE_ELEMENT_COLOR_CLASS,
  createCodeElementColorTransformer,
} from "../code-element-colors.mjs";

import "../../scripts/test-asset-env.mjs";

function transformToken({ token, style, options = {} }) {
  const transformer = createCodeElementColorTransformer();
  const span = {
    type: "element",
    tagName: "span",
    properties: { style },
    children: [{ type: "text", value: token.content || "token" }],
  };
  const pre = {
    type: "element",
    tagName: "pre",
    properties: { style: "background-color:#101010;color:#f0f0f0" },
    children: [span],
  };
  const root = { type: "root", children: [pre] };

  transformer.span.call({ options }, span, 1, 0, { type: "element", children: [span] }, token);
  transformer.root.call({}, root);
  return { transformer, root, pre, span };
}

describe("vite prepared code element colors", () => {
  it("exports a fixed category catalog and marks the native scope-preservation requirement", () => {
    expect(Object.isFrozen(CODE_ELEMENT_COLOR_CATEGORIES)).toBe(true);
    expect(CODE_ELEMENT_COLOR_CATEGORIES).toEqual(
      expect.arrayContaining([
        "keyword",
        "string",
        "comment",
        "number",
        "boolean",
        "constant",
        "function",
        "type",
        "variable",
        "parameter",
        "property",
        "operator",
        "punctuation",
        "tag",
        "attribute",
        "regexp",
        "escape",
      ]),
    );
    expect(
      createCodeElementColorTransformer()[Symbol.for("ferriki.preserve-scope-boundaries.v1")],
    ).toBe(true);
  });

  it("uses the innermost scope and nests semantic subtype fallbacks", () => {
    const { span } = transformToken({
      token: {
        content: "\\n",
        color: "#aabbcc",
        scopeNames: ["source.js", "string.quoted.double.js", "constant.character.escape.js"],
      },
      style: "color:#aabbcc",
    });

    expect(span.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-escape-color, var(--ferriki-string-color, #aabbcc))",
    );
    expect(span.properties.style).toContain("color:var(--_ferriki-token-color)");
    expect(span.properties.class).toContain(CODE_ELEMENT_COLOR_CLASS);
    expect(span.properties.style).not.toContain("--ferriki-escape-color:");
  });

  it("treats declaration words as keywords while retaining primitive and named types", () => {
    const keyword = transformToken({
      token: { content: "const", color: "#123456", scopeNames: ["source.js", "storage.type.js"] },
      style: "color:#123456",
    }).span;
    const primitive = transformToken({
      token: {
        content: "int",
        color: "#123456",
        scopeNames: ["source.c", "storage.type.primitive.c"],
      },
      style: "color:#123456",
    }).span;
    expect(keyword.properties.style).toContain("--ferriki-keyword-color");
    expect(primitive.properties.style).toContain("--ferriki-type-color");
  });

  it("maps property, parameter, and explanation scopes without falling back to variable", () => {
    const property = transformToken({
      token: {
        content: "title",
        color: "#abc123",
        scopeNames: ["source.js", "variable.other.property.js"],
      },
      style: "color:#abc123",
    }).span;
    const parameter = transformToken({
      token: {
        content: "value",
        color: "#abc123",
        explanation: [
          { scopes: [{ scopeName: "source.js" }, { scopeName: "variable.parameter.js" }] },
        ],
      },
      style: "color:#abc123",
    }).span;

    expect(property.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-property-color, var(--ferriki-variable-color, #abc123))",
    );
    expect(parameter.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-parameter-color, var(--ferriki-variable-color, #abc123))",
    );
  });

  it("uses active class-theme colors and inline alias fallbacks", () => {
    const variants = {
      light: { color: "#111111" },
      dark: { color: "#eeeeee" },
    };
    const classSpan = transformToken({
      options: { styleMode: "classes", themes: { light: "light", dark: "dark" } },
      token: {
        content: "value",
        variants,
        htmlStyle: "--shiki-light:#111111;--shiki-dark:#eeeeee;color:var(--ferriki-color)",
        scopeNames: ["source.js", "variable.other.readwrite.js"],
      },
      style: "--shiki-light:#111111;--shiki-dark:#eeeeee;color:var(--ferriki-color)",
    }).span;
    const inlineSpan = transformToken({
      options: {
        styleMode: "inline",
        themes: { light: "light", dark: "dark" },
        defaultColor: "light",
      },
      token: {
        content: "value",
        variants,
        htmlStyle: "--shiki-light:#111111;--shiki-dark:#eeeeee;color:#111111",
        scopeNames: ["source.js", "variable.other.readwrite.js"],
      },
      style: "--shiki-light:#111111;--shiki-dark:#eeeeee;color:#111111",
    }).span;

    expect(classSpan.properties.style).toContain(
      "var(--ferriki-variable-color, var(--ferriki-color, #111111))",
    );
    expect(inlineSpan.properties.style).toContain(
      "var(--ferriki-variable-color, var(--_ferriki-token-theme-color, #111111))",
    );
    expect(inlineSpan.properties.class).toContain(CODE_ELEMENT_COLOR_CLASS);
  });

  it("wraps the root theme colors in inheritable foreground and background variables", () => {
    const { pre } = transformToken({
      token: { content: "const", color: "#abcdef", scopeNames: ["source.js", "keyword"] },
      style: "color:#abcdef",
    });

    expect(pre.properties.style).toBe(
      "background-color:var(--ferriki-background-color, #101010);color:var(--ferriki-foreground, #f0f0f0)",
    );
  });

  it("does not replace an earlier transformer-authored token color", () => {
    const { span } = transformToken({
      token: {
        content: "value",
        color: "#abcdef",
        htmlStyle: "color:#abcdef",
        scopeNames: ["source.js", "variable.other.readwrite.js"],
      },
      style: "color:#abcdef;color:#123456;font-weight:bold",
    });

    expect(span.properties.style).toBe("color:#abcdef;color:#123456;font-weight:bold");
    expect(span.properties.class).toContain("ferriki-color-authored");
  });

  it("drops hostile theme color text from the generated fallback expression", () => {
    const { span } = transformToken({
      options: { styleMode: "inline" },
      token: {
        content: "danger",
        color: "red);position:fixed",
        htmlStyle: "color:red);position:fixed",
        scopeNames: ["source.js", "keyword.control.js"],
      },
      style: "color:red);position:fixed",
    });

    expect(span.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-keyword-color, inherit)",
    );
    expect(span.properties.style).not.toContain("position:fixed");
    expect(span.properties.style).not.toContain("red)");
  });

  it("preserves same-color TextMate scope boundaries in inline output", async () => {
    const highlighter = await createHighlighter({
      langs: ["javascript"],
      themes: ["github-dark-default"],
    });
    try {
      const capture = {
        tokens(tokens) {
          capture.tokensResult = tokens;
          return tokens;
        },
      };
      highlighter.codeToHtml("obj.foo", {
        lang: "javascript",
        theme: "github-dark-default",
        includeExplanation: "scopeName",
        mergeWhitespaces: false,
        styleMode: "inline",
        transformers: [capture],
      });
      expect(capture.tokensResult[0]).toHaveLength(1);
      expect(capture.tokensResult[0][0].scopeNames).toBeUndefined();

      highlighter.codeToHtml("obj.foo", {
        lang: "javascript",
        theme: "github-dark-default",
        includeExplanation: "scopeName",
        mergeWhitespaces: false,
        styleMode: "inline",
        transformers: [capture, createCodeElementColorTransformer()],
      });
      expect(capture.tokensResult[0].map((token) => token.content)).toEqual(["obj", ".", "foo"]);
      expect(capture.tokensResult[0].map((token) => token.scopeNames.at(-1))).toEqual([
        "variable.other.object.js",
        "punctuation.accessor.js",
        "variable.other.property.js",
      ]);
    } finally {
      highlighter.dispose();
    }
  });
});
