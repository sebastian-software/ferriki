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

  it("sanitizes unsafe values in theme custom properties on spans, uncategorized spans, and pre", () => {
    const transformer = createCodeElementColorTransformer();
    const categorizedSpan = {
      type: "element",
      tagName: "span",
      properties: {
        style:
          "--shiki-light:#111111;--shiki-dark:red}body{background:url(https://evil.test);color:#111111",
      },
      children: [{ type: "text", value: "const" }],
    };
    const uncategorizedSpan = {
      type: "element",
      tagName: "span",
      properties: {
        style:
          "color:red);position:fixed;--shiki-dark:url(https://evil.test)</style><script>alert(1)</script>",
      },
      children: [{ type: "text", value: "plain" }],
    };
    const pre = {
      type: "element",
      tagName: "pre",
      properties: {
        style:
          "background-color:#101010;color:#f0f0f0;--shiki-light:#f0f0f0;--shiki-dark:red/*unclosed;--shiki-dark-bg:url(https://evil.test)",
      },
      children: [categorizedSpan, uncategorizedSpan],
    };
    const root = { type: "root", children: [pre] };

    transformer.span.call({ options: { styleMode: "inline" } }, categorizedSpan, 1, 0, pre, {
      content: "const",
      variants: {
        light: { color: "#111111" },
        dark: { color: "red}body{background:url(https://evil.test)" },
      },
      htmlStyle: categorizedSpan.properties.style,
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.span.call({ options: { styleMode: "inline" } }, uncategorizedSpan, 1, 1, pre, {
      content: "plain",
      color: "red);position:fixed",
      htmlStyle: uncategorizedSpan.properties.style,
      scopeNames: ["source.plain"],
    });
    transformer.root.call({}, root);

    expect(categorizedSpan.properties.style).toContain("--shiki-light:#111111");
    expect(categorizedSpan.properties.style).not.toContain("url(");
    expect(categorizedSpan.properties.style).not.toContain("body{");

    expect(uncategorizedSpan.properties.style ?? "").not.toContain("position:fixed");
    expect(uncategorizedSpan.properties.style ?? "").not.toContain("url(");
    expect(uncategorizedSpan.properties.style ?? "").not.toContain("</style>");

    expect(pre.properties.style).toContain("--shiki-light:#f0f0f0");
    expect(pre.properties.style).not.toContain("/*");
    expect(pre.properties.style).not.toContain("url(");
  });

  it("preserves code-element sizing variables and allows CSS math inside theme colors", () => {
    const transformer = createCodeElementColorTransformer();
    const span = {
      type: "element",
      tagName: "span",
      properties: {
        style: "color:hsl(calc(180 + 20) 50% 40%);--shiki-dark:oklch(clamp(0.2, 0.5, 0.8) 0.1 180)",
      },
      children: [{ type: "text", value: "const" }],
    };
    const pre = {
      type: "element",
      tagName: "pre",
      properties: {
        style:
          "background-color:#101010;color:#f0f0f0;--ferriki-code-line-height:1.5rem;--ferriki-code-padding-block:8px;--shiki-animation-duration:200ms;--ferriki-keyword-color:url(https://evil.test)",
      },
      children: [span],
    };
    const root = { type: "root", children: [pre] };

    transformer.span.call({ options: { styleMode: "inline" } }, span, 1, 0, pre, {
      content: "const",
      color: "hsl(calc(180 + 20) 50% 40%)",
      htmlStyle: span.properties.style,
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.root.call({}, root);

    expect(span.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-keyword-color, hsl(calc(180 + 20) 50% 40%))",
    );
    expect(span.properties.style).toContain("--shiki-dark:oklch(clamp(0.2, 0.5, 0.8) 0.1 180)");
    expect(pre.properties.style).toContain("--ferriki-code-line-height:1.5rem");
    expect(pre.properties.style).toContain("--ferriki-code-padding-block:8px");
    expect(pre.properties.style).toContain("--shiki-animation-duration:200ms");
    expect(pre.properties.style).not.toContain("url(");
  });

  it("identifies palette roles from configured theme aliases and handles binary subtraction in calc()", () => {
    const transformer = createCodeElementColorTransformer();
    const options = {
      styleMode: "inline",
      themes: { light: "github-light", "contrast-font-weight": "github-dark" },
    };
    const span = {
      type: "element",
      tagName: "span",
      properties: {
        style:
          "color:hsl(calc(180 - (10 + 5)) 50% 40%);--shiki-contrast-font-weight:#abcdef;--shiki-contrast-font-weight-font-weight:bold",
      },
      children: [{ type: "text", value: "const" }],
    };
    const pre = {
      type: "element",
      tagName: "pre",
      properties: {
        style:
          "background-color:#101010;color:#f0f0f0;--shiki-contrast-font-weight:#abcdef;--shiki-contrast-font-weight-bg:#000000",
      },
      children: [span],
    };
    const root = { type: "root", children: [pre] };

    transformer.span.call({ options }, span, 1, 0, pre, {
      content: "const",
      variants: {
        light: { color: "hsl(calc(180 - (10 + 5)) 50% 40%)" },
        "contrast-font-weight": { color: "#abcdef" },
      },
      htmlStyle: span.properties.style,
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.root.call({ options }, root);

    expect(span.properties.style).toContain("--shiki-contrast-font-weight:#abcdef");
    expect(span.properties.style).toContain("--shiki-contrast-font-weight-font-weight:bold");
    expect(span.properties.style).toContain("hsl(calc(180 - (10 + 5)) 50% 40%)");
    expect(pre.properties.style).toContain("--shiki-contrast-font-weight:#abcdef");
    expect(pre.properties.style).toContain("--shiki-contrast-font-weight-bg:#000000");

    const contrastSpan = {
      type: "element",
      tagName: "span",
      properties: {
        style:
          "color:contrast-color(white);--shiki-dark:contrast-color(oklch(0.6 0.15 250));--shiki-light:contrast-color(url(https://evil.test))",
      },
      children: [{ type: "text", value: "const" }],
    };
    const contrastPre = {
      type: "element",
      tagName: "pre",
      properties: { style: "background-color:#101010;color:contrast-color(#101010)" },
      children: [contrastSpan],
    };
    const contrastOptions = {
      styleMode: "inline",
      themes: { light: "github-light", dark: "github-dark" },
    };
    transformer.span.call({ options: contrastOptions }, contrastSpan, 1, 0, contrastPre, {
      content: "const",
      color: "contrast-color(white)",
      htmlStyle: contrastSpan.properties.style,
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.root.call({ options: contrastOptions }, { type: "root", children: [contrastPre] });
    expect(contrastSpan.properties.style).toContain("contrast-color(white)");
    expect(contrastSpan.properties.style).toContain(
      "--shiki-dark:contrast-color(oklch(0.6 0.15 250))",
    );
    expect(contrastSpan.properties.style).not.toContain("url(");
    expect(contrastPre.properties.style).toContain("contrast-color(#101010)");

    // Overlapping aliases (`contrast-font-weight` and `contrast`) give `--shiki-contrast-font-weight`
    // both `color` and `font-weight` roles so neither valid value is dropped while unsafe values are.
    const overlapOptions = {
      styleMode: "inline",
      themes: {
        light: "github-light",
        "contrast-font-weight": "github-dark",
        contrast: "github-dark",
      },
    };
    const overlapSpan = {
      type: "element",
      tagName: "span",
      properties: {
        style: "color:#111111;--shiki-contrast-font-weight:bold",
      },
      children: [{ type: "text", value: "const" }],
    };
    const overlapPre = {
      type: "element",
      tagName: "pre",
      properties: {
        style:
          "background-color:#101010;color:#f0f0f0;--shiki-contrast-font-weight:#abcdef;--shiki-light:url(https://evil.test)",
      },
      children: [overlapSpan],
    };
    transformer.span.call({ options: overlapOptions }, overlapSpan, 1, 0, overlapPre, {
      content: "const",
      variants: {
        light: { color: "#111111" },
        "contrast-font-weight": { color: "#abcdef" },
        contrast: { color: "#222222", "font-weight": "bold" },
      },
      htmlStyle: overlapSpan.properties.style,
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.root.call({ options: overlapOptions }, { type: "root", children: [overlapPre] });
    expect(overlapSpan.properties.style).toContain("--shiki-contrast-font-weight:bold");
    expect(overlapPre.properties.style).toContain("--shiki-contrast-font-weight:#abcdef");
    expect(overlapPre.properties.style).not.toContain("url(");

    // Composed `light-dark(...)` from two 260-char valid `var(--...)` colors wrapped in
    // `var(--ferriki-..., light-dark(...))` survives Vite's transformer in class mode.
    const longLight = `var(--${"a".repeat(253)})`;
    const longDark = `var(--${"b".repeat(253)})`;
    const longComposed = `light-dark(${longLight}, ${longDark})`;
    const longOptions = {
      styleMode: "classes",
      defaultColor: "light-dark()",
      themes: { light: "long-light", dark: "long-dark" },
    };
    const longSpan = {
      type: "element",
      tagName: "span",
      properties: {
        style: `color:${longComposed};--shiki-light:${longLight};--shiki-dark:${longDark}`,
      },
      children: [{ type: "text", value: "const" }],
    };
    const longPre = {
      type: "element",
      tagName: "pre",
      properties: { style: `background-color:#ffffff;color:${longComposed}` },
      children: [longSpan],
    };
    transformer.span.call({ options: longOptions }, longSpan, 1, 0, longPre, {
      content: "const",
      variants: { light: { color: longLight }, dark: { color: longDark } },
      htmlStyle: longSpan.properties.style,
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.root.call({ options: longOptions }, { type: "root", children: [longPre] });
    expect(longSpan.properties.style).toContain(
      `--_ferriki-token-color:var(--ferriki-keyword-color, ${longComposed})`,
    );
    expect(longPre.properties.style).toContain(`color:var(--ferriki-foreground, ${longComposed})`);

    // A 500-char single-theme color wrapped in `var(--ferriki-foreground, ...)` also survives.
    const single500 = `color-mix(in oklch, var(--${"a".repeat(225)}) 50%, var(--${"b".repeat(234)}))`;
    const singlePre = {
      type: "element",
      tagName: "pre",
      properties: { style: `background-color:#101010;color:${single500}` },
      children: [],
    };
    transformer.root.call(
      { options: { styleMode: "classes" } },
      { type: "root", children: [singlePre] },
    );
    expect(singlePre.properties.style).toContain(`color:var(--ferriki-foreground, ${single500})`);

    // Trailing `!important` on safe theme/color declarations is preserved, while unsafe `!important`
    // or invalid `!bogus` declarations are stripped.
    const importantSpan = {
      type: "element",
      tagName: "span",
      properties: {
        style:
          "color:#111111;background-color:yellow !important;--shiki-dark:url(https://evil.test) !important;--shiki-light:yellow !bogus",
      },
      children: [{ type: "text", value: "const" }],
    };
    const importantPre = {
      type: "element",
      tagName: "pre",
      properties: { style: "background-color:yellow !important;color:#111111" },
      children: [importantSpan],
    };
    const importantOptions = {
      styleMode: "inline",
      themes: { light: "github-light", dark: "github-dark" },
    };
    transformer.span.call({ options: importantOptions }, importantSpan, 1, 0, importantPre, {
      content: "const",
      color: "#111111",
      htmlStyle: importantSpan.properties.style,
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.root.call(
      { options: importantOptions },
      { type: "root", children: [importantPre] },
    );
    expect(importantSpan.properties.style).toContain("background-color:yellow !important");
    expect(importantSpan.properties.style).not.toContain("url(");
    expect(importantSpan.properties.style).not.toContain("!bogus");
    expect(importantPre.properties.style).toContain("var(--ferriki-background-color, yellow)");

    // Callback-authored `--shiki-*` properties outside the configured palette (such as CJK font
    // names) stay untouched while unsafe values on configured palette variables are rejected.
    const cjkCustomPre = {
      type: "element",
      tagName: "pre",
      properties: {
        style:
          'background-color:#101010;color:#f0f0f0;--shiki-font-family:"源ノ角ゴシック";--shiki-bad:"bad\u0007font"',
      },
      children: [],
    };
    transformer.root.call(
      { options: { styleMode: "inline", themes: { bad: "github-dark" } } },
      { type: "root", children: [cjkCustomPre] },
    );
    expect(cjkCustomPre.properties.style).toContain('--shiki-font-family:"源ノ角ゴシック"');
    expect(cjkCustomPre.properties.style).not.toContain("--shiki-bad");

    // Non-ASCII color custom properties (e.g. `color:var(--café)`) survive on uncategorized
    // spans while unsafe custom property names are still stripped.
    const unicodeVarSpan = {
      type: "element",
      tagName: "span",
      properties: { style: "color:var(--café)" },
      children: [{ type: "text", value: "plain" }],
    };
    const unsafeVarSpan = {
      type: "element",
      tagName: "span",
      properties: { style: "color:var(--a}b);background-color:var(--caf\u00A0é)" },
      children: [{ type: "text", value: "bad" }],
    };
    const unicodeVarPre = {
      type: "element",
      tagName: "pre",
      properties: { style: "background-color:#101010;color:#f0f0f0" },
      children: [unicodeVarSpan, unsafeVarSpan],
    };
    const unicodeVarOptions = { styleMode: "inline" };
    transformer.span.call({ options: unicodeVarOptions }, unicodeVarSpan, 1, 0, unicodeVarPre, {
      content: "plain",
      htmlStyle: unicodeVarSpan.properties.style,
      scopeNames: ["source.txt"],
    });
    transformer.span.call({ options: unicodeVarOptions }, unsafeVarSpan, 1, 1, unicodeVarPre, {
      content: "bad",
      htmlStyle: unsafeVarSpan.properties.style,
      scopeNames: ["source.txt"],
    });
    transformer.root.call(
      { options: unicodeVarOptions },
      { type: "root", children: [unicodeVarPre] },
    );
    expect(unicodeVarSpan.properties.style).toContain("color:var(--café)");
    expect(unsafeVarSpan.properties.style).toBeUndefined();

    // Exclamation marks inside quoted strings are ignored by `splitOptionalImportant`.
    const quotedBangPre = {
      type: "element",
      tagName: "pre",
      properties: {
        style:
          'background-color:#101010;color:#f0f0f0;--shiki-font-family:"What a Font!";--shiki-alt-font:"Hello!" !important',
      },
      children: [],
    };
    transformer.root.call(
      { options: { styleMode: "inline" } },
      { type: "root", children: [quotedBangPre] },
    );
    expect(quotedBangPre.properties.style).toContain('--shiki-font-family:"What a Font!"');
    expect(quotedBangPre.properties.style).toContain('--shiki-alt-font:"Hello!" !important');

    // Valid authored CSS font overrides (`oblique 12deg`, decimal weights like `450.5`,
    // text-decoration shorthands) survive palette validation while out-of-range / unsafe values drop.
    const fontOverridesSpan = {
      type: "element",
      tagName: "span",
      properties: {
        style:
          "--shiki-dark-font-style:oblique 12deg;--shiki-dark-font-weight:450.5;--shiki-dark-text-decoration:underline wavy #ff0000 2px;--shiki-light-font-style:oblique 120deg;--shiki-light-font-weight:0;--shiki-light-text-decoration:underline url(https://evil.test)",
      },
      children: [{ type: "text", value: "const" }],
    };
    const fontOverridesPre = {
      type: "element",
      tagName: "pre",
      properties: { style: "background-color:#101010;color:#f0f0f0" },
      children: [fontOverridesSpan],
    };
    const fontOverridesOptions = {
      styleMode: "inline",
      themes: { light: "github-light", dark: "github-dark" },
    };
    transformer.span.call(
      { options: fontOverridesOptions },
      fontOverridesSpan,
      1,
      0,
      fontOverridesPre,
      {
        content: "const",
        variants: { light: { color: "#111111" }, dark: { color: "#eeeeee" } },
        htmlStyle: fontOverridesSpan.properties.style,
        scopeNames: ["source.js", "keyword.control.js"],
      },
    );
    transformer.root.call(
      { options: fontOverridesOptions },
      { type: "root", children: [fontOverridesPre] },
    );
    expect(fontOverridesSpan.properties.style).toContain("--shiki-dark-font-style:oblique 12deg");
    expect(fontOverridesSpan.properties.style).toContain("--shiki-dark-font-weight:450.5");
    expect(fontOverridesSpan.properties.style).toContain(
      "--shiki-dark-text-decoration:underline wavy #ff0000 2px",
    );
    expect(fontOverridesSpan.properties.style).not.toContain("--shiki-light-font-style");
    expect(fontOverridesSpan.properties.style).not.toContain("--shiki-light-font-weight");
    expect(fontOverridesSpan.properties.style).not.toContain("--shiki-light-text-decoration");

    const emptyFallbackSpan = {
      type: "element",
      tagName: "span",
      properties: { style: "--shiki-dark:var(--accent,);--shiki-light:var(--,)" },
      children: [{ type: "text", value: "fallback" }],
    };
    const emptyFallbackPre = {
      type: "element",
      tagName: "pre",
      properties: { style: "color:var(--accent,)" },
      children: [emptyFallbackSpan],
    };
    transformer.span.call(
      { options: fontOverridesOptions },
      emptyFallbackSpan,
      1,
      0,
      emptyFallbackPre,
      {
        content: "fallback",
        htmlStyle: emptyFallbackSpan.properties.style,
        scopeNames: ["source.js"],
      },
    );
    transformer.root.call(
      { options: fontOverridesOptions },
      { type: "root", children: [emptyFallbackPre] },
    );
    expect(emptyFallbackSpan.properties.style).toContain("--shiki-dark:var(--accent,)");
    expect(emptyFallbackSpan.properties.style).not.toContain("--shiki-light");
    expect(emptyFallbackPre.properties.style).toContain(
      "color:var(--ferriki-foreground, var(--accent,))",
    );

    // Colors authored after the Vite `span` hook (e.g. in a trusted `line` hook) on an
    // uncategorized inline span must be preserved rather than reclassified as theme colors.
    const postSpanAuthoredSpan = {
      type: "element",
      tagName: "span",
      properties: { style: "color:#d8dee9" },
      children: [{ type: "text", value: "plain" }],
    };
    const postSpanEmptySpan = {
      type: "element",
      tagName: "span",
      properties: {},
      children: [{ type: "text", value: "bare" }],
    };
    const postSpanPre = {
      type: "element",
      tagName: "pre",
      properties: { style: "color:#f0f0f0;background-color:#101010" },
      children: [postSpanAuthoredSpan, postSpanEmptySpan],
    };
    transformer.span.call(
      { options: { styleMode: "inline" } },
      postSpanAuthoredSpan,
      1,
      0,
      postSpanPre,
      {
        content: "plain",
        color: "#d8dee9",
        htmlStyle: "color:#d8dee9",
        scopeNames: ["source.js"],
      },
    );
    transformer.span.call(
      { options: { styleMode: "inline" } },
      postSpanEmptySpan,
      1,
      5,
      postSpanPre,
      {
        content: "bare",
        scopeNames: ["source.js"],
      },
    );
    // Simulate a trusted `line` hook running after `span` and before `root`.
    postSpanAuthoredSpan.properties.style = "color:red /* accent */";
    postSpanEmptySpan.properties.style = "color:blue /* highlight */";
    transformer.root.call(
      { options: { styleMode: "inline" } },
      { type: "root", children: [postSpanPre] },
    );
    expect(postSpanAuthoredSpan.properties.style).toBe("color:red /* accent */");
    expect(postSpanEmptySpan.properties.style).toBe("color:blue /* highlight */");

    // Callback-authored custom properties outside the generated palette (even under `--shiki-*`)
    // and valid multiline theme colors stay untouched.
    const markerSpan = {
      type: "element",
      tagName: "span",
      properties: { style: 'color:#d8dee9;--shiki-marker:"Step: "' },
      children: [{ type: "text", value: "step" }],
    };
    const markerPre = {
      type: "element",
      tagName: "pre",
      properties: {
        style: 'color:rgb(\n  10,\n  20,\n  30\n);background-color:#101010;--shiki-marker:"Step: "',
      },
      children: [markerSpan],
    };
    transformer.span.call({ options: { styleMode: "inline" } }, markerSpan, 1, 0, markerPre, {
      content: "step",
      color: "#d8dee9",
      htmlStyle: "color:#d8dee9",
      scopeNames: ["source.js"],
    });
    transformer.root.call(
      { options: { styleMode: "inline" } },
      { type: "root", children: [markerPre] },
    );
    expect(markerPre.properties.style).toContain('--shiki-marker:"Step: "');
    expect(markerPre.properties.style).toContain(
      "color:var(--ferriki-foreground, rgb( 10, 20, 30 ))",
    );
    expect(markerSpan.properties.style).toContain('--shiki-marker:"Step: "');

    // Single-theme class mode with a valid multiline `rgb()` token color normalizes both sides
    // before checking for authored overrides, avoiding a false `ferriki-color-authored` class.
    const multilineClassSpan = {
      type: "element",
      tagName: "span",
      properties: {
        style: "color:rgb( 10, 20, 30 );font-style:normal;font-weight:normal;text-decoration:none",
      },
      children: [{ type: "text", value: "const" }],
    };
    const multilineClassPre = {
      type: "element",
      tagName: "pre",
      properties: { style: "color:#f0f0f0;background-color:#101010" },
      children: [multilineClassSpan],
    };
    transformer.span.call(
      { options: { styleMode: "classes" } },
      multilineClassSpan,
      1,
      0,
      multilineClassPre,
      {
        content: "const",
        color: "rgb(\n  10,\n  20,\n  30\n)",
        scopeNames: ["source.js", "keyword.control.js"],
      },
    );
    transformer.root.call(
      { options: { styleMode: "classes" } },
      { type: "root", children: [multilineClassPre] },
    );
    expect(multilineClassSpan.properties.class).toContain("ferriki-color-token");
    expect(multilineClassSpan.properties.class).not.toContain("ferriki-color-authored");
    expect(multilineClassSpan.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-keyword-color, rgb( 10, 20, 30 ))",
    );

    // Valid theme colors containing CSS comments (e.g. `rgb(255 /* red */ 0 0)`) are normalized
    // cleanly while unclosed comments or `</style>` payloads fall back to `inherit`.
    const commentedSpan = {
      type: "element",
      tagName: "span",
      properties: { style: "color:rgb(255 /* red */ 0 0)" },
      children: [{ type: "text", value: "const" }],
    };
    const hostileCommentSpan = {
      type: "element",
      tagName: "span",
      properties: { style: "color:rgb(255 /* </style> */ 0 0)" },
      children: [{ type: "text", value: "let" }],
    };
    const commentedPre = {
      type: "element",
      tagName: "pre",
      properties: {
        style: "color:rgb(255 /* fg */ 0 0);background-color:/* bg */ #101010",
      },
      children: [commentedSpan, hostileCommentSpan],
    };
    transformer.span.call({ options: { styleMode: "inline" } }, commentedSpan, 1, 0, commentedPre, {
      content: "const",
      color: "rgb(255 /* red */ 0 0)",
      htmlStyle: "color:rgb(255 /* red */ 0 0)",
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.span.call(
      { options: { styleMode: "inline" } },
      hostileCommentSpan,
      1,
      1,
      commentedPre,
      {
        content: "let",
        color: "rgb(255 /* </style> */ 0 0)",
        htmlStyle: "color:rgb(255 /* </style> */ 0 0)",
        scopeNames: ["source.js", "keyword.control.js"],
      },
    );
    transformer.root.call(
      { options: { styleMode: "inline" } },
      { type: "root", children: [commentedPre] },
    );
    expect(commentedPre.properties.style).toContain(
      "color:var(--ferriki-foreground, rgb(255 0 0))",
    );
    expect(commentedPre.properties.style).toContain(
      "background-color:var(--ferriki-background-color, #101010)",
    );
    expect(commentedSpan.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-keyword-color, rgb(255 0 0))",
    );
    expect(hostileCommentSpan.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-keyword-color, inherit)",
    );
    expect(hostileCommentSpan.properties.style).not.toContain("</style>");

    // `env(<ident>, <safe-color>)` is accepted as a valid theme color while hostile fallbacks
    // or invalid identifiers degrade safely to `inherit`.
    const envSpan = {
      type: "element",
      tagName: "span",
      properties: { style: "color:env(viewport-segment-color 0 0, #c00)" },
      children: [{ type: "text", value: "const" }],
    };
    const badEnvSpan = {
      type: "element",
      tagName: "span",
      properties: { style: "color:env(site-foreground, url(https://evil.test))" },
      children: [{ type: "text", value: "let" }],
    };
    const envPre = {
      type: "element",
      tagName: "pre",
      properties: { style: "color:env(📐, blue);background-color:#101010" },
      children: [envSpan, badEnvSpan],
    };
    transformer.span.call({ options: { styleMode: "inline" } }, envSpan, 1, 0, envPre, {
      content: "const",
      color: "env(viewport-segment-color 0 0, #c00)",
      htmlStyle: "color:env(viewport-segment-color 0 0, #c00)",
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.span.call({ options: { styleMode: "inline" } }, badEnvSpan, 1, 1, envPre, {
      content: "let",
      color: "env(site-foreground, url(https://evil.test))",
      htmlStyle: "color:env(site-foreground, url(https://evil.test))",
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.root.call(
      { options: { styleMode: "inline" } },
      { type: "root", children: [envPre] },
    );
    expect(envPre.properties.style).toContain("color:var(--ferriki-foreground, env(📐, blue))");
    expect(envSpan.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-keyword-color, env(viewport-segment-color 0 0, #c00))",
    );
    expect(badEnvSpan.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-keyword-color, inherit)",
    );
    expect(badEnvSpan.properties.style).not.toContain("evil.test");

    // Valid composed colors combined in a `light-dark(...)` semantic fallback stay intact
    // instead of degrading to `inherit`.
    const composedLight = `var(--light-a, var(--light-b, color-mix(in oklch, var(--${"a".repeat(220)}) 50%, var(--${"b".repeat(220)}))))`;
    const composedDark = `var(--dark-a, var(--dark-b, color-mix(in oklch, var(--${"c".repeat(220)}) 50%, var(--${"d".repeat(220)}))))`;
    const composedSpan = {
      type: "element",
      tagName: "span",
      properties: { style: `color:light-dark(${composedLight}, ${composedDark})` },
      children: [{ type: "text", value: "const" }],
    };
    const composedPre = {
      type: "element",
      tagName: "pre",
      properties: { style: "color:#f0f0f0;background-color:#101010" },
      children: [composedSpan],
    };
    const composedOptions = {
      styleMode: "inline",
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light-dark()",
    };
    transformer.span.call({ options: composedOptions }, composedSpan, 1, 0, composedPre, {
      content: "const",
      variants: { light: { color: composedLight }, dark: { color: composedDark } },
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.root.call({ options: composedOptions }, { type: "root", children: [composedPre] });
    expect(composedSpan.properties.style).toContain(
      `--_ferriki-token-color:var(--ferriki-keyword-color, light-dark(${composedLight}, ${composedDark}))`,
    );
  });

  it("preserves semantic colors when sanitizing frozen decorated spans", async () => {
    const highlighter = await createHighlighter({
      langs: ["javascript"],
      themes: ["github-dark-default"],
    });
    try {
      const html = highlighter.codeToHtml("const x = 1", {
        lang: "javascript",
        theme: "github-dark-default",
        includeExplanation: "scopeName",
        styleMode: "inline",
        transformers: [createCodeElementColorTransformer()],
        decorations: [
          {
            start: 0,
            end: 5,
            properties: { style: "font-weight:bold;background:url(https://evil.test)" },
            transform(node) {
              Object.freeze(node.properties);
              return Object.freeze(node);
            },
          },
        ],
      });
      expect(html).not.toContain("evil.test");
      expect(html).toContain("font-weight:bold");
      expect(html).toContain("ferriki-color-token");
      expect(html).toContain("--_ferriki-token-color:var(--ferriki-keyword-color,");
    } finally {
      highlighter.dispose();
    }
  });

  it("handles frozen spans without mutating them during the color pass", () => {
    const transformer = createCodeElementColorTransformer();
    const frozenProps = Object.freeze({ style: "color:#111; /* trailing comment */" });
    const frozenSpan = Object.freeze({
      type: "element",
      tagName: "span",
      properties: frozenProps,
      children: Object.freeze([{ type: "text", value: "plain" }]),
    });
    const pre = Object.freeze({
      type: "element",
      tagName: "pre",
      properties: Object.freeze({ style: "color:#f0f0f0;background-color:#101010" }),
      children: Object.freeze([frozenSpan]),
    });
    const root = Object.freeze({ type: "root", children: Object.freeze([pre]) });
    const options = { styleMode: "inline" };
    transformer.span.call({ options }, frozenSpan, 1, 0, pre, {
      content: "plain",
      color: "#111",
      htmlStyle: "color:#111; /* trailing comment */",
    });
    const updatedRoot = transformer.root.call({ options }, root);
    expect(updatedRoot).not.toBe(root);
    expect(frozenSpan.properties).toBe(frozenProps);
    expect(frozenSpan.properties.style).toBe("color:#111; /* trailing comment */");
    expect(updatedRoot.children[0].children[0].properties.style).toBe("color:#111");
    expect(updatedRoot.children[0].properties.style).toContain(
      "var(--ferriki-foreground, #f0f0f0)",
    );
  });

  it("preserves valid CSS identifier escapes in var() and env() and rejects invalid escapes", () => {
    const transformer = createCodeElementColorTransformer();
    const plusSpan = {
      type: "element",
      tagName: "span",
      properties: { style: "color:var(--brand\\+accent)" },
      children: [{ type: "text", value: "const" }],
    };
    const hexSpan = {
      type: "element",
      tagName: "span",
      properties: { style: "color:var(--brand\\3a accent)" },
      children: [{ type: "text", value: "let" }],
    };
    const badNullSpan = {
      type: "element",
      tagName: "span",
      properties: { style: "color:var(--a\\0b)" },
      children: [{ type: "text", value: "var" }],
    };
    const badParenSpan = {
      type: "element",
      tagName: "span",
      properties: { style: "color:var(--a\\)" },
      children: [{ type: "text", value: "for" }],
    };
    const pre = {
      type: "element",
      tagName: "pre",
      properties: {
        style: "color:var(--brand\\+accent);background-color:var(--brand\\3a accent)",
      },
      children: [plusSpan, hexSpan, badNullSpan, badParenSpan],
    };
    const options = { styleMode: "inline" };
    transformer.span.call({ options }, plusSpan, 1, 0, pre, {
      content: "const",
      color: "var(--brand\\+accent)",
      htmlStyle: "color:var(--brand\\+accent)",
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.span.call({ options }, hexSpan, 1, 1, pre, {
      content: "let",
      color: "var(--brand\\3a accent)",
      htmlStyle: "color:var(--brand\\3a accent)",
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.span.call({ options }, badNullSpan, 1, 2, pre, {
      content: "var",
      color: "var(--a\\0b)",
      htmlStyle: "color:var(--a\\0b)",
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.span.call({ options }, badParenSpan, 1, 3, pre, {
      content: "for",
      color: "var(--a\\)",
      htmlStyle: "color:var(--a\\)",
      scopeNames: ["source.js", "keyword.control.js"],
    });
    transformer.root.call({ options }, { type: "root", children: [pre] });
    expect(plusSpan.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-keyword-color, var(--brand\\+accent))",
    );
    expect(hexSpan.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-keyword-color, var(--brand\\3a accent))",
    );
    expect(badNullSpan.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-keyword-color, inherit)",
    );
    expect(badParenSpan.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-keyword-color, inherit)",
    );
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

  it("memoizes scope categorization and safe color normalization without conflating constant.language booleans and non-booleans", () => {
    const transformer = createCodeElementColorTransformer();
    const options = { styleMode: "inline" };
    const makeSpan = (content, color) => ({
      type: "element",
      tagName: "span",
      properties: { style: `color:${color}` },
      children: [{ type: "text", value: content }],
    });
    const trueSpan = makeSpan("true", "#79c0ff");
    const nullSpan = makeSpan("null", "#79c0ff");
    const falseSpan = makeSpan("FALSE", "#79c0ff");
    const badColorSpan = makeSpan("true", "url(https://evil.test/x)");
    const pre = {
      type: "element",
      tagName: "pre",
      properties: { style: "color:#e6edf3;background-color:#0d1117" },
      children: [trueSpan, nullSpan, falseSpan, badColorSpan],
    };

    // Call twice with the same `constant.language.js` scope and different token contents
    // so both cache-miss and cache-hit paths are exercised.
    for (const [span, content, color] of [
      [trueSpan, "true", "#79c0ff"],
      [nullSpan, "null", "#79c0ff"],
      [falseSpan, "FALSE", "#79c0ff"],
      [badColorSpan, "true", "url(https://evil.test/x)"],
    ]) {
      transformer.span.call({ options }, span, 1, 0, pre, {
        content,
        color,
        scopeNames: ["source.js", "constant.language.js"],
      });
    }
    transformer.root.call({ options }, { type: "root", children: [pre] });

    expect(trueSpan.properties.style).toContain("--ferriki-boolean-color");
    expect(trueSpan.properties.style).toContain("#79c0ff");
    expect(nullSpan.properties.style).not.toContain("--ferriki-boolean-color");
    expect(nullSpan.properties.style).toContain("--ferriki-constant-color");
    expect(falseSpan.properties.style).toContain("--ferriki-boolean-color");
    expect(badColorSpan.properties.style).toContain(
      "--_ferriki-token-color:var(--ferriki-boolean-color, var(--ferriki-constant-color, inherit))",
    );
    expect(badColorSpan.properties.style).not.toContain("url(");
  });
});
