import assert from "node:assert/strict";
import { fromHtml } from "hast-util-from-html";
import { scopeClass } from "../ferriki/classes.mjs";
import { codeToHtmlWithCss, createHighlighter, ShikiError } from "../ferriki/index.mjs";
import "./test-asset-env.mjs";

const parseHtml = (html) => fromHtml(html, { fragment: true });
const text = (node) =>
  node.type === "text" ? node.value : (node.children || []).map(text).join("");
const all = (node) => [node, ...(node.children || []).flatMap(all)];
const classes = (node) => {
  const value = node.properties?.className ?? node.properties?.class ?? [];
  return Array.isArray(value) ? value : String(value).split(/\s+/u).filter(Boolean);
};
const parents = (node, target, path = []) =>
  node === target
    ? path
    : (node.children || []).map((child) => parents(child, target, [...path, node])).find(Boolean);

const grammar = {
  name: "class-probe",
  scopeName: "source.probe",
  patterns: [
    { match: "AB", name: "meta.a meta.b entity.name.probe" },
    { match: "BA", name: "meta.b meta.a entity.name.probe" },
    { match: "AA", name: "meta.a meta.a entity.name.probe" },
  ],
};
const highlighter = await createHighlighter({
  langs: [grammar, "json", "javascript", "html"],
  themes: ["monokai", "nord", "vitesse-light"],
});
try {
  const options = { lang: "class-probe", theme: "nord", styleMode: "classes" };
  const code = "AB BA AA <&😀\n\n";
  const rendered = highlighter.codeToHtmlWithCss(code, options);
  const tree = parseHtml(rendered.html);
  assert.equal(text(tree), code);
  const tokens = all(tree).filter((node) => classes(node).includes("token"));
  for (const [word, expected] of [
    ["AB", ["meta-a", "meta-b"]],
    ["BA", ["meta-b", "meta-a"]],
    ["AA", ["meta-a", "meta-a"]],
  ]) {
    const token = tokens.find((node) => text(node) === word);
    const path = parents(tree, token).flatMap((node) =>
      classes(node)
        .filter((name) => name.startsWith("exact-meta"))
        .map((name) => name.slice(6)),
    );
    assert.deepEqual(path, expected);
  }
  assert.equal(rendered.html, highlighter.codeToHtml(code, options));
  assert(!rendered.html.includes(" style="));
  assert(rendered.css.includes(":where(.ferriki-style-"));
  assert.equal(scopeClass("meta.a-b"), "meta-a_2d_b");
  assert.notEqual(scopeClass("meta.a-b"), scopeClass("meta.a.b"));
  assert.equal(scopeClass('meta.😀_"'), "meta-_1f600__5f__22_");
  const inline = highlighter.codeToHtml("const a = 1", { lang: "javascript", theme: "nord" });
  assert.equal(
    inline,
    highlighter.codeToHtml("const a = 1", {
      lang: "javascript",
      theme: "nord",
      styleMode: "inline",
    }),
  );
  assert(inline.includes("style="));
  assert.throws(
    () => highlighter.codeToHtml(code, { ...options, styleMode: "unknown" }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );

  assert.equal(scopeClass("meta.K"), "meta-_212a_");
  const map = { light: "vitesse-light", dark: "monokai" };
  const light = highlighter.codeToHtmlWithCss('"hello"', { lang: "json", themes: map });
  const dark = highlighter.codeToHtmlWithCss('"hello"', {
    lang: "json",
    themes: map,
    defaultColor: "dark",
  });
  const namespace = (html) => html.match(/ferriki-themes-[a-f0-9]+/)[0];
  assert.notEqual(namespace(light.html), namespace(dark.html));
  const unset = highlighter.codeToHtmlWithCss('"hello"', {
    lang: "json",
    themes: map,
    defaultColor: false,
  });
  assert.notEqual(namespace(light.html), namespace(unset.html));
  assert(!unset.css.includes(`:where(.${namespace(unset.html)})`));
  const overridden = highlighter.codeToHtmlWithCss('"hello"', {
    lang: "json",
    themes: map,
    transformers: [
      {
        span(node, _line, _column, _lineNode, token) {
          if (token.content === "hello") node.properties.style = "color:#123456";
        },
      },
    ],
  });
  assert(overridden.css.includes("{color:#123456}"));
  assert(!overridden.css.includes("{color:var(--shiki-dark)"));
  const objectHtmlStyle = highlighter.codeToHtmlWithCss('"hello"', {
    lang: "json",
    theme: "nord",
    transformers: [
      {
        tokens(lines) {
          return lines.map((line) =>
            line.map((token) => ({
              ...token,
              htmlStyle: { color: "red;position:fixed", "font-weight": "bold" },
            })),
          );
        },
      },
    ],
  });
  assert(!objectHtmlStyle.css.includes("position:fixed"));
  assert(objectHtmlStyle.css.includes("font-weight:bold"));
  const inlineClasses = highlighter.codeToHtml("const x = 1\n// y", {
    lang: "javascript",
    theme: "nord",
    styleMode: "classes",
    structure: "inline",
  });
  assert(inlineClasses.startsWith("<code class="));
  assert(inlineClasses.includes("<br>"));
  assert(!inlineClasses.includes("style="));
  const classGrammarState = highlighter.getLastGrammarState("/* open", {
    lang: "javascript",
    theme: "nord",
    styleMode: "classes",
  });
  assert.equal(classGrammarState.lang, "javascript");
  assert.throws(
    () =>
      highlighter.codeToHtmlWithCss("x", {
        lang: "javascript",
        themes: { "bad key": "nord" },
        defaultColor: false,
      }),
    (error) => error.code === "ERR_USAGE",
  );
  for (const method of ["codeToHtmlWithCss", "codeToHtml"]) {
    assert.throws(
      () =>
        highlighter[method]("\u001B[31mred", { lang: "ansi", theme: "nord", styleMode: "classes" }),
      (error) => error.code === "ERR_UNSUPPORTED",
    );
  }
  const json = '"hello"\n{"message":"hello"}';
  let callbackTokens;
  highlighter.codeToHtml(json, {
    lang: "json",
    theme: "monokai",
    styleMode: "classes",
    transformers: [
      {
        tokens(lines) {
          callbackTokens = lines.flat();
          return lines;
        },
      },
    ],
  });
  assert.deepEqual(
    callbackTokens.filter((token) => token.content === "hello").map((token) => token.color),
    ["#E6DB74", "#CFCFC2"],
  );
  assert(callbackTokens.every((token) => token.scopeNames.length));
  const themed = highlighter.codeToHtmlWithCss(json, {
    lang: "json",
    themes: { light: "vitesse-light", dark: "monokai" },
    defaultColor: false,
  });
  assert(themed.css.includes("--shiki-dark:"));
  assert(!themed.html.includes(" style="));

  const decorated = highlighter.codeToHtml("const answer = 42", {
    lang: "javascript",
    theme: "nord",
    styleMode: "classes",
    decorations: [{ start: 6, end: 12, properties: { class: "selected" }, alwaysWrap: true }],
    transformers: [
      {
        span(node) {
          this.addClassToHast(node, "transformed");
        },
      },
    ],
  });
  const decoratedTree = parseHtml(decorated);
  assert.equal(text(decoratedTree), "const answer = 42");
  assert.equal(
    text(all(decoratedTree).find((node) => classes(node).includes("selected"))),
    "answer",
  );
  assert(
    all(decoratedTree).some(
      (node) => classes(node).includes("transformed") && classes(node).includes("token"),
    ),
  );
  const state = highlighter.getLastGrammarState("/* open", { lang: "javascript", theme: "nord" });
  let continuedTokens;
  const continued = highlighter.codeToHtml("comment */ const x = 1", {
    lang: "javascript",
    theme: "nord",
    styleMode: "classes",
    grammarState: state,
    transformers: [
      {
        tokens(lines) {
          continuedTokens = lines.flat();
          return lines;
        },
      },
    ],
  });
  assert(continuedTokens[0].scopeNames.some((scope) => scope.startsWith("comment")));
  assert(continued.includes("tok-comment"));
  for (const source of ["", "<&😀\r\n\r\n", "trailing\n"]) {
    const plain = highlighter.codeToHtml(source, {
      lang: "text",
      theme: "none",
      styleMode: "classes",
    });
    assert.equal(text(parseHtml(plain)), source.replaceAll("\r\n", "\n"));
  }
  assert.equal(
    (await codeToHtmlWithCss(highlighter, json, { lang: "json", theme: "monokai" })).html,
    highlighter.codeToHtmlWithCss(json, { lang: "json", theme: "monokai" }).html,
  );
  assert(
    (await codeToHtmlWithCss(json, { lang: "json", theme: "monokai" })).css.includes("#CFCFC2"),
  );

  // Uppercase `STYLE` keys on `meta` and declarative decorations are canonicalized,
  // sanitized, and extracted into CSS rules so no inline style attribute leaks in class mode.
  const uppercaseStyleExtracted = highlighter.codeToHtmlWithCss("const x = 1", {
    lang: "javascript",
    theme: "nord",
    meta: { STYLE: "padding:1rem;background:url(https://evil.test)" },
    decorations: [
      {
        start: 0,
        end: 5,
        properties: { STYLE: "color:red;background:url(https://evil.test)" },
      },
    ],
  });
  assert(!/\sstyle=/i.test(uppercaseStyleExtracted.html));
  assert(!uppercaseStyleExtracted.css.includes("url("));
  assert(uppercaseStyleExtracted.css.includes("padding:1rem"));
  assert(uppercaseStyleExtracted.css.includes("color:red"));

  // Composed `light-dark(...)` colors from two 260-char valid `var(--...)` theme colors
  // survive `codeToHtmlWithCss` class extraction without hitting the single-value 512-char cap.
  const longLightVar = `var(--${"a".repeat(253)})`;
  const longDarkVar = `var(--${"b".repeat(253)})`;
  await highlighter.loadTheme(
    {
      name: "long-var-light",
      type: "light",
      fg: longLightVar,
      bg: "#ffffff",
      settings: [{ scope: "entity.name.probe", settings: { foreground: longLightVar } }],
    },
    {
      name: "long-var-dark",
      type: "dark",
      fg: longDarkVar,
      bg: "#000000",
      settings: [{ scope: "entity.name.probe", settings: { foreground: longDarkVar } }],
    },
  );
  const longLightDark = highlighter.codeToHtmlWithCss("AB", {
    lang: "class-probe",
    themes: { light: "long-var-light", dark: "long-var-dark" },
    defaultColor: "light-dark()",
  });
  assert(!/\sstyle=/i.test(longLightDark.html));
  assert(longLightDark.css.includes(`--shiki-light:${longLightVar}`));
  assert(longLightDark.css.includes(`--shiki-dark:${longDarkVar}`));
  assert(longLightDark.css.includes("prefers-color-scheme"));

  // A literal composed `light-dark(<260-char>, <260-char>)` declaration authored by a
  // transformer also survives `codeToHtmlWithCss` class extraction.
  const literalComposed = `light-dark(${longLightVar}, ${longDarkVar})`;
  const literalLightDark = highlighter.codeToHtmlWithCss("AB", {
    lang: "class-probe",
    theme: "nord",
    transformers: [
      {
        span(node) {
          node.properties.style = `color:${literalComposed}`;
        },
      },
    ],
  });
  assert(!/\sstyle=/i.test(literalLightDark.html));
  assert(literalLightDark.css.includes(`color:${literalComposed}`));

  // Object-valued `token.htmlStyle` reaches `span` hooks intact (matching string-valued
  // `token.htmlStyle`) so a trusted transformer can inspect it and replace it with a class.
  let seenTokenObjStyle;
  const replacedBySpanHook = highlighter.codeToHtmlWithCss("AB", {
    lang: "class-probe",
    theme: "nord",
    transformers: [
      {
        tokens(lines) {
          return lines.map((line) =>
            line.map((token) => ({
              ...token,
              htmlStyle: { "background-image": "url(/local.png)" },
            })),
          );
        },
        span(node) {
          seenTokenObjStyle = node.properties.style;
          if (seenTokenObjStyle?.includes("url(/local.png)")) {
            delete node.properties.style;
            this.addClassToHast(node, "has-bg-image");
          }
          return node;
        },
      },
    ],
  });
  assert.equal(seenTokenObjStyle, "background-image:url(/local.png)");
  assert(replacedBySpanHook.html.includes("has-bg-image"));
  assert(!replacedBySpanHook.css.includes("url("));

  // Replacement spans returned by `span` hooks still preserve object `token.htmlStyle`
  // property boundaries during class extraction, and `token.htmlStyle` is snapshotted once
  // before `span` hooks so getters run once and post-snapshot mutations do not affect extraction.
  let tokenStyleGetterReads = 0;
  const replacementSpanCss = highlighter.codeToHtmlWithCss("AB", {
    lang: "class-probe",
    theme: "nord",
    transformers: [
      {
        tokens(lines) {
          return lines.map((line) =>
            line.map((token) => ({
              ...token,
              htmlStyle: {
                color: "red;position:fixed",
                get "font-weight"() {
                  tokenStyleGetterReads++;
                  return "bold";
                },
              },
            })),
          );
        },
        span(node, _line, _col, _lineNode, token) {
          token.htmlStyle.color = "blue";
          return { ...node, properties: { ...node.properties } };
        },
      },
    ],
  });
  assert.equal(tokenStyleGetterReads, 1);
  assert(!replacementSpanCss.css.includes("position:fixed"));
  assert(!replacementSpanCss.css.includes("color:blue"));
  assert(replacementSpanCss.css.includes("font-weight:bold"));

  // Token object snapshots are keyed per originating span (not by flattened string), so
  // `{ color: "red", padding: "1px" }` and `{ color: "red;padding:1px" }` never collide in either order.
  for (const order of [
    [{ color: "red", padding: "1px" }, { color: "red;padding:1px" }],
    [{ color: "red;padding:1px" }, { color: "red", padding: "1px" }],
  ]) {
    const pairResult = highlighter.codeToHtmlWithCss("AB BA", {
      lang: "class-probe",
      theme: "nord",
      transformers: [
        {
          tokens(lines) {
            let index = 0;
            return lines.map((line) =>
              line.map((token) =>
                token.content.trim() ? { ...token, htmlStyle: order[index++] } : token,
              ),
            );
          },
        },
      ],
    });
    assert(pairResult.css.includes("color:red;padding:1px"));
    const styleClasses = pairResult.html.match(/ferriki-style-[\da-f]+/gu) || [];
    // Exactly the legitimate token (not the smuggled one) receives the extracted style class.
    const validStyleClass = pairResult.css.match(
      /\.(ferriki-style-[\da-f]+)\)\{color:red;padding:1px\}/u,
    )?.[1];
    assert(validStyleClass);
    assert.equal(styleClasses.filter((cls) => cls === validStyleClass).length, 1);
  }

  // Object-valued `token.htmlStyle` validates declaration boundaries before flattening so
  // wrapping spans in `span` hooks or deep-cloning in `line` hooks cannot smuggle declarations.
  for (const hook of [
    {
      span(node) {
        return { type: "element", tagName: "em", properties: {}, children: [node] };
      },
    },
    {
      line(node) {
        return structuredClone(node);
      },
    },
  ]) {
    const wrappedOrCloned = highlighter.codeToHtmlWithCss("AB", {
      lang: "class-probe",
      theme: "nord",
      transformers: [
        {
          tokens(lines) {
            return lines.map((line) =>
              line.map((token) => ({
                ...token,
                htmlStyle: { color: "red;position:fixed", "font-weight": "bold" },
              })),
            );
          },
          ...hook,
        },
      ],
    });
    assert(!wrappedOrCloned.css.includes("position:fixed"));
    assert(!wrappedOrCloned.html.includes("position:fixed"));
    assert(wrappedOrCloned.css.includes("font-weight:bold"));
  }

  // Balanced CSS function values containing semicolons (such as data URIs in `url(...)`) survive
  // object-style flattening in inline mode while class mode still enforces its URL policy.
  const dataUriStyle = { "background-image": "url(data:image/png;base64,AAAA)" };
  const inlineDataUriHtml = highlighter.codeToHtml("AB", {
    lang: "class-probe",
    theme: "nord",
    transformers: [
      {
        tokens(lines) {
          return lines.map((line) => line.map((token) => ({ ...token, htmlStyle: dataUriStyle })));
        },
      },
    ],
  });
  assert(inlineDataUriHtml.includes("background-image:url(data:image/png;base64,AAAA)"));

  let seenDataUriInSpan;
  const classDataUri = highlighter.codeToHtmlWithCss("AB", {
    lang: "class-probe",
    theme: "nord",
    transformers: [
      {
        tokens(lines) {
          return lines.map((line) => line.map((token) => ({ ...token, htmlStyle: dataUriStyle })));
        },
        span(node) {
          seenDataUriInSpan = node.properties.style;
          return node;
        },
      },
    ],
  });
  assert.equal(seenDataUriInSpan, "background-image:url(data:image/png;base64,AAAA)");
  assert(!classDataUri.css.includes("url("));

  // Valid non-ASCII CSS custom properties (e.g. `--café`) from trusted `tokens` hooks survive
  // object-style flattening in both inline mode and class mode, while unsafe custom property
  // names remain rejected.
  const nonAsciiVarHtml = highlighter.codeToHtml("AB", {
    lang: "class-probe",
    theme: "nord",
    transformers: [
      {
        tokens(lines) {
          return lines.map((line) =>
            line.map((token) => ({
              ...token,
              htmlStyle: { "--café": "red", color: "var(--café)" },
            })),
          );
        },
      },
    ],
  });
  assert(nonAsciiVarHtml.includes("--café:red;color:var(--café)"));

  const nonAsciiClassMode = highlighter.codeToHtmlWithCss("AB", {
    lang: "class-probe",
    theme: "nord",
    transformers: [
      {
        tokens(lines) {
          return lines.map((line) =>
            line.map((token) => ({
              ...token,
              htmlStyle: { "--café": "red", color: "var(--café)" },
            })),
          );
        },
      },
    ],
  });
  assert(nonAsciiClassMode.css.includes("--café:red;color:var(--café)"));

  // When a callback leaves both `style` and `STYLE`, class extraction follows HTML's
  // first-attribute-wins rule (deleting both keys and extracting only the first).
  const duplicateStyleResult = highlighter.codeToHtmlWithCss("AB", {
    lang: "class-probe",
    theme: "nord",
    transformers: [
      {
        span(node) {
          node.properties = { style: "color:red", STYLE: "font-weight:bold" };
          return node;
        },
      },
    ],
  });
  assert(duplicateStyleResult.css.includes("color:red"));
  assert(!duplicateStyleResult.css.includes("font-weight:bold"));
  assert(!duplicateStyleResult.html.includes("STYLE="));
  assert(!duplicateStyleResult.html.includes("style="));

  // Returning frozen elements/properties/children from a `root` transformer in `codeToHtmlWithCss`
  // works cleanly through both `nestScopes` and `extractClassStyles` without mutating them.
  const frozenRootProps = Object.freeze({ style: "color:green;background:url(https://evil.test)" });
  const frozenRootSpan = Object.freeze({
    type: "element",
    tagName: "span",
    properties: frozenRootProps,
    children: Object.freeze([{ type: "text", value: "frozen" }]),
  });
  const frozenRootResult = highlighter.codeToHtmlWithCss("AB", {
    lang: "class-probe",
    theme: "nord",
    transformers: [
      {
        root(tree) {
          const line = tree.children[0].children[0].children[0];
          const frozenLine = Object.freeze({
            ...line,
            children: Object.freeze([...line.children, frozenRootSpan]),
          });
          tree.children[0].children[0].children[0] = frozenLine;
          return tree;
        },
      },
    ],
  });
  assert(frozenRootResult.css.includes("color:green"));
  assert(!frozenRootResult.css.includes("evil.test"));
  assert(frozenRootResult.html.includes("frozen"));
  assert.equal(frozenRootProps.style, "color:green;background:url(https://evil.test)");

  // Even when a `root` transformer returns a completely frozen root tree (frozen root,
  // `<pre>`, `<code>`, line, and child spans), `codeToHtmlWithCss` serializes the rebuilt
  // class-styled tree rather than the original frozen root with raw inline `style=`.
  const deepFreeze = (value) => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
  };
  const completelyFrozenRootResult = highlighter.codeToHtmlWithCss("AB", {
    lang: "class-probe",
    theme: "nord",
    transformers: [
      {
        root(tree) {
          const line = tree.children[0].children[0].children[0];
          line.children.push({
            type: "element",
            tagName: "span",
            properties: { style: "color:purple;background:url(https://evil.test)" },
            children: [{ type: "text", value: "deep-frozen" }],
          });
          return deepFreeze(tree);
        },
      },
    ],
  });
  assert(completelyFrozenRootResult.css.includes("color:purple"));
  assert(!completelyFrozenRootResult.css.includes("evil.test"));
  assert(completelyFrozenRootResult.html.includes("deep-frozen"));
  assert(completelyFrozenRootResult.html.includes("ferriki-style-"));
  assert(!completelyFrozenRootResult.html.includes("style="));
  assert(!completelyFrozenRootResult.html.includes("evil.test"));

  // Freezing a decorated token in class mode whose declarative style needs normalization still
  // preserves its `scopePaths` entry on the cloned token so `nestScopes` wraps it properly.
  const frozenDecoratedTokenResult = highlighter.codeToHtmlWithCss("AB", {
    lang: "class-probe",
    theme: "nord",
    decorations: [
      {
        start: 0,
        end: 1,
        properties: { style: "color:red;background:url(https://evil.test)" },
        transform(node) {
          Object.freeze(node.properties);
          return Object.freeze(node);
        },
      },
    ],
  });
  assert(frozenDecoratedTokenResult.css.includes("color:red"));
  assert(!frozenDecoratedTokenResult.css.includes("evil.test"));
  assert(!frozenDecoratedTokenResult.html.includes("evil.test"));
  assert(!frozenDecoratedTokenResult.html.includes("style="));
  assert(
    frozenDecoratedTokenResult.html.includes("exact-meta-a"),
    "frozen cloned decorated token must retain its scope ancestor wrappers",
  );

  // Class-mode transformers emitting quoted CSS labels containing `:` (e.g. `content: "Note: "`)
  // are preserved in extracted stylesheets while `</style>` breakout payloads are still dropped.
  const quotedContentResult = highlighter.codeToHtmlWithCss("AB", {
    lang: "class-probe",
    theme: "nord",
    transformers: [
      {
        span(node) {
          node.properties.style = `${node.properties.style || ""};content:"Note: "`;
          return node;
        },
      },
    ],
  });
  assert(quotedContentResult.css.includes('content:"Note: "'));

  // Class-mode declarations containing well-formed CSS comments (e.g. `color: red /* accent */`)
  // normalize cleanly and survive class extraction.
  const commentedDeclResult = highlighter.codeToHtmlWithCss("AB", {
    lang: "class-probe",
    theme: "nord",
    transformers: [
      {
        span(node) {
          node.properties.style =
            "color: red /* accent */; font-weight: bold /* emphasis */ !important";
          return node;
        },
      },
    ],
  });
  assert(commentedDeclResult.css.includes("color:red;font-weight:bold !important"));
} finally {
  highlighter.dispose();
}
assert.throws(
  () => highlighter.codeToHtmlWithCss("x", { lang: "text", theme: "nord" }),
  (error) => error.code === "ERR_USAGE",
);
console.log(
  "Class highlighting: scopes, themes, transforms, decorations, state, escaping, and API verified.",
);
