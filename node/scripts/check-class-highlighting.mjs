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
