import assert from "node:assert/strict";
import test from "node:test";

import {
  createScopeClassCache,
  extractClassStyles,
  extractClassStylesFromTree,
  formatSafeTokenStyleEntry,
  isSafeCssColor,
  isSafeDecorationAttributeName,
  isSafeDecorationAttributeValue,
  isSafeDecorationTagName,
  isSafeDecorationUrl,
  isValidCssCustomPropertyName,
  isValidCssIdentifier,
  isValidCssVariablePrefix,
  isValidHtmlAttributeName,
  isValidHtmlTagName,
  isValidInlineCssVariablePrefix,
  isValidInlineThemeAlias,
  nestScopes,
  normalizeSafeCssColor,
  sanitizeCssDeclarations,
  themeSwitchStyles,
} from "../ferriki/classes.mjs";
import { alignThemeTokens, tokenStyle } from "../ferriki/src/theme-tokens.mjs";
import { createCodeElementColorTransformer } from "../vite/code-element-colors.mjs";

test("CSS color validation accepts legitimate CSS colors and rejects injection payloads", () => {
  for (const valid of [
    "#fff",
    "#ffff",
    "#2e3440",
    "#2e3440ff",
    "red",
    "transparent",
    "currentColor",
    "inherit",
    "revert-layer",
    "rgb(255, 0, 0)",
    "rgba(255, 0, 0, 0.5)",
    "rgb(255 0 0 / 50%)",
    "hsl(120deg 100% 50% / 0.5)",
    "hsla(120, 100%, 50%, 0.5)",
    "hwb(194 0% 0% / .5)",
    "lab(50% 40 59.5)",
    "lch(52.2% 72.2 50)",
    "oklab(0.59 0.1 -0.1)",
    "oklch(0.62 0.15 250 / 80%)",
    "color(display-p3 1 0.5 0 / 0.8)",
    "color-mix(in oklch, var(--shiki-a, #fff) 50%, transparent)",
    "contrast-color(white)",
    "contrast-color(oklch(0.6 0.15 250))",
    "light-dark(#111, #eee)",
    "var(--shiki-foreground)",
    "var(--accent,)",
    "var(--x, )",
    "var(--_ferriki-token-color, var(--ferriki-string-color, #aabbcc))",
    "hsl(calc(180 + 20) 50% 40%)",
    "hsl(calc((90 + 10) * 2) 50% 40%)",
    "hsl(calc(180 - (10 + 5)) 50% 40%)",
    "oklch(clamp(0.2, 0.5, 0.8) 0.1 180)",
    "rgb(min(255, round(127.6)) max(0, 10) abs(-5))",
    "rgb(1, 2, 3) /* comment */",
    "rgb(255 /* red */ 0 0)",
    "env(site-foreground, #c00)",
    "env(safe-area-inset-top)",
    "env(site-foreground, rgb(255 0 0))",
    "env(viewport-segment-color 0 0, #c00)",
    "env(📐, blue)",
  ]) {
    assert.equal(isSafeCssColor(valid), true, `expected valid color: ${valid}`);
  }
  assert.equal(normalizeSafeCssColor("rgb(255 /* red */ 0 0)"), "rgb(255 0 0)");
  assert.equal(normalizeSafeCssColor("rgb(1, 2, 3) /* comment */"), "rgb(1, 2, 3)");

  for (const invalid of [
    "",
    "   ",
    "#12",
    "#12345",
    "#1234567",
    "#123456789",
    "#gggggg",
    "calc(180 + 20)",
    "clamp(0.2, 0.5, 0.8)",
    "hsl(url(https://evil.test) 50% 40%)",
    "contrast-color(url(https://evil.test))",
    "hsl(url (https://evil.test) 50% 40%)",
    "hsl(expression(alert(1)) 50% 40%)",
    "red;position:fixed",
    "red);position:fixed",
    "red}body{color:red",
    "#fff</style><script>alert(1)</script>",
    "url(https://evil.test/x)",
    "expression(alert(1))",
    "@import url(https://evil.test)",
    "rgb(1, 2, 3) /* unclosed",
    "rgb(1, 2, 3) */",
    "rgb(1, 2, 3) /* </style> */",
    "rgb(1, 2, 3) /* \u0007 */",
    "r/*x*/gb(255 0 0)",
    "rgb/*x*/(255 0 0)",
    "rgb(1, 2, 3) !important",
    "rgb(1, 2, 3) extra",
    "var(not-custom)",
    "var(--x, url(https://evil.test))",
    "var(,)",
    "var(--,)",
    "var(--bad;name,)",
    "env(, #c00)",
    "env(123bad, #c00)",
    "env(-1bad, #c00)",
    "env(bad name, #c00)",
    "env(viewport-segment-color -1, #c00)",
    "env(viewport-segment-color 0 -1, #c00)",
    "env(viewport-segment-color 1.5, #c00)",
    "env(viewport-segment-color 0 0, url(https://evil.test))",
    "env(site-foreground, url(https://evil.test))",
    "red\u000B",
    "red\0",
    "red\\7d",
    '"red"',
    "'red'",
    "rgb (1, 2, 3)",
    "((#fff))",
  ]) {
    assert.equal(isSafeCssColor(invalid), false, `expected invalid color: ${invalid}`);
  }
});

test("extractClassStyles prevents CSS rule breakout, </style> breakout, and object-value smuggling", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: {
          class: "ferriki hostile",
          style:
            "color:#111;background:url(https://evil.test);padding:1rem}body{display:none}</style><script>x</script>;font-weight:bold",
        },
        children: [
          {
            type: "element",
            tagName: "span",
            properties: {
              style: {
                color: "red;position:fixed",
                "font-style": "italic",
                "--shiki-dark": "url(https://evil.test)</style>",
                "--shiki-light": "#abcdef",
              },
            },
            children: [{ type: "text", value: "a" }],
          },
          {
            type: "element",
            tagName: "span",
            properties: {
              class: "keep",
              style: "color:red/*unclosed;background:expression(alert(1))",
            },
            children: [{ type: "text", value: "b" }],
          },
        ],
      },
    ],
  };

  const css = extractClassStyles(tree);
  assert.doesNotMatch(
    css,
    /<\/style>|<script>|url\(|expression\(|display:none|position:fixed|\/\*/i,
  );
  assert.match(css, /\{color:#111;font-weight:bold\}/);
  assert.match(css, /\{font-style:italic;--shiki-light:#abcdef\}/);

  const pre = tree.children[0];
  assert.equal(pre.properties.style, undefined);
  const allHostileSpan = pre.children[1];
  assert.equal(allHostileSpan.properties.style, undefined);
  assert.equal(allHostileSpan.properties.class, "keep");
});

test("sanitizeCssDeclarations rejects legacy dangerous properties, quoted-semicolon leaks, and preserves max-length theme vars", () => {
  assert.equal(
    sanitizeCssDeclarations("behavior:url(x.htc);-moz-binding:url(x.xml);color:#123"),
    "color:#123",
  );
  assert.equal(
    sanitizeCssDeclarations("margin:calc((1rem + 2px) / 2)"),
    "margin:calc((1rem + 2px) / 2)",
  );
  assert.equal(sanitizeCssDeclarations("color:var(not-custom)"), "");
  assert.equal(
    sanitizeCssDeclarations('content:"Note: ";font-weight:bold'),
    'content:"Note: ";font-weight:bold',
  );
  assert.equal(
    sanitizeCssDeclarations('content:"Note: \\"quoted\\""'),
    'content:"Note: \\"quoted\\""',
  );
  assert.equal(
    sanitizeCssDeclarations('content:"Note: </style><script>";font-weight:bold'),
    "font-weight:bold",
  );
  assert.equal(
    sanitizeCssDeclarations('--caption:"a;color:red;b";font-weight:bold'),
    '--caption:"a;color:red;b";font-weight:bold',
  );
  assert.equal(
    sanitizeCssDeclarations("--caption:'a\\';color:red;b';font-weight:bold"),
    "--caption:'a\\';color:red;b';font-weight:bold",
  );
  assert.equal(sanitizeCssDeclarations('--caption:"unclosed;color:red'), "");
  assert.equal(
    sanitizeCssDeclarations("--x:red/*;color:blue*/;font-weight:bold"),
    "--x:red;font-weight:bold",
  );
  assert.equal(
    sanitizeCssDeclarations("color: red /* accent */; background-color: blue /* bg */ !important"),
    "color:red;background-color:blue !important",
  );
  assert.equal(sanitizeCssDeclarations('content: "/* literal */"'), 'content:"/* literal */"');
  assert.equal(
    sanitizeCssDeclarations(
      "background: url/*x*/(/evil.png); background: u/*x*/rl(https://evil.test)",
    ),
    "",
  );
  assert.equal(sanitizeCssDeclarations("color: red /* unclosed"), "");
  assert.equal(sanitizeCssDeclarations("color: green /* </style> */"), "");
  assert.equal(sanitizeCssDeclarations("/* </style> */ color: red"), "");
  assert.equal(
    sanitizeCssDeclarations("left: env(viewport-segment-left 0 0, 0px)"),
    "left:env(viewport-segment-left 0 0, 0px)",
  );
  assert.equal(sanitizeCssDeclarations("color:env(📐, blue)"), "color:env(📐, blue)");
  assert.equal(sanitizeCssDeclarations("left: env(viewport-segment-left -1, 0px)"), "");
  assert.equal(
    sanitizeCssDeclarations("left: env(viewport-segment-left 0 0, url(https://evil.test))"),
    "",
  );
  assert.equal(
    sanitizeCssDeclarations('font-family:"Fira Code",monospace;\n  padding:1rem'),
    'font-family:"Fira Code",monospace;padding:1rem',
  );
  assert.equal(
    sanitizeCssDeclarations(
      'grid-template-columns:repeat(2, 1fr);color:red !important;background:image-set("a.png" 1x);width:src("a.png")',
    ),
    "grid-template-columns:repeat(2, 1fr);color:red !important",
  );
  assert.equal(sanitizeCssDeclarations("color:red !bogus"), "");
  assert.equal(
    sanitizeCssDeclarations(
      'background:-webkit-image-set("a.png" 1x);mask:-moz-element(#x);content:-webkit-cross-fade("a.png", "b.png", 50%);--shiki-animation-duration:200ms',
    ),
    "--shiki-animation-duration:200ms",
  );
  assert.equal(
    sanitizeCssDeclarations(
      'list-style-image:-moz-image-rect("https://evil.example/x.png", 0, 10, 10, 0);background-image:image-rect("https://evil.example/x.png", 0, 10, 10, 0);background:paint(evil);background:filter("https://evil.example/x.png", blur(2px));filter:blur(2px)',
    ),
    "filter:blur(2px)",
  );
  assert.equal(
    sanitizeCssDeclarations('content:var(--opening-mark, "(");--close:var(--closing-mark, ")")'),
    'content:var(--opening-mark, "(");--close:var(--closing-mark, ")")',
  );
  assert.equal(sanitizeCssDeclarations('content:var(--bad, ")'), "");
  assert.equal(
    sanitizeCssDeclarations("background:-webkit-linear-gradient(red, blue)"),
    "background:-webkit-linear-gradient(red, blue)",
  );
  assert.equal(sanitizeCssDeclarations("grid-template-columns:[unclosed;padding:1rem"), "");
  assert.equal(
    sanitizeCssDeclarations("grid-template-columns:[main-start] 1fr [main-end]"),
    "grid-template-columns:[main-start] 1fr [main-end]",
  );
  assert.equal(sanitizeCssDeclarations("grid-template-columns:];padding:1rem"), "padding:1rem");
  assert.equal(
    sanitizeCssDeclarations({ color: "red;position:fixed", "font-weight": "bold" }),
    "font-weight:bold",
  );

  const longPrefix = `--${"p".repeat(126)}`;
  const longKey = "k".repeat(128);
  assert.equal(isValidCssVariablePrefix(longPrefix), true);
  assert.equal(isValidCssIdentifier(longKey), true);
  const longDecl = `${longPrefix}${longKey}-text-decoration:underline`;
  assert.equal(sanitizeCssDeclarations(longDecl), longDecl);
  const switched = themeSwitchStyles({
    themes: { [longKey]: "nord" },
    cssVariablePrefix: longPrefix,
  });
  assert.match(switched.css, new RegExp(`${longPrefix}${longKey}-text-decoration`));
});

test("themeSwitchStyles rejects invalid theme keys, prototype keys, and invalid prefixes", () => {
  assert.throws(
    () => themeSwitchStyles({ themes: { "light}body{": "nord" } }),
    /Theme keys must be CSS identifiers/,
  );
  assert.throws(
    () => themeSwitchStyles({ themes: { constructor: "nord" } }),
    /Theme keys must be CSS identifiers/,
  );
  assert.throws(
    () => themeSwitchStyles({ themes: { light: "nord" }, cssVariablePrefix: "--bad;x:" }),
    /cssVariablePrefix/,
  );
  const valid = themeSwitchStyles({
    themes: { light: "vitesse-light", dark: "nord", "unused palette": undefined },
    cssVariablePrefix: "--my-theme-",
  });
  assert.match(valid.css, /--my-theme-light/);
  assert.match(valid.css, /--my-theme-dark/);
  assert.doesNotMatch(valid.css, /unused palette/);
});

test("HTML tag name, attribute name, CSS identifier, and CSS prefix validators enforce strict syntax", () => {
  for (const tag of [
    "span",
    "div",
    "mark",
    "my-element",
    "syntax-token_v2",
    "my-el.v1",
    "x-café",
    "h1",
    "code",
  ])
    assert.equal(isValidHtmlTagName(tag), true);
  for (const tag of [
    "",
    "1div",
    "-div",
    "_div",
    ".div",
    "span><script>",
    "div onclick=1",
    "span/x",
    "span\0",
  ])
    assert.equal(isValidHtmlTagName(tag), false);

  for (const tag of ["span", "div", "mark", "a", "strong", "code", "em"])
    assert.equal(isSafeDecorationTagName(tag), true);
  for (const tag of [
    "script",
    "SCRIPT",
    "style",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "applet",
    "base",
    "meta",
    "link",
    "plaintext",
    "ferriki-code",
    "x-custom-el",
    "x-café",
    "mar\u212A",
    "syntax-token_v2",
    "form",
    "input",
    "svg",
    "math",
    "template",
  ])
    assert.equal(isSafeDecorationTagName(tag), false, `expected unsafe decoration tag: ${tag}`);

  for (const attr of ["class", "data-line", "aria-label", "title", "id"])
    assert.equal(isSafeDecorationAttributeName(attr), true);
  for (const attr of [
    "onclick",
    "ONLOAD",
    "onmouseover",
    "srcdoc",
    "SRCDOC",
    "action",
    "attributionsrc",
    "background",
    "formaction",
    "is",
    "IS",
    "ping",
    "srcset",
  ])
    assert.equal(
      isSafeDecorationAttributeName(attr),
      false,
      `expected unsafe decoration attr: ${attr}`,
    );

  for (const url of [
    "https://example.com/docs",
    "http://example.com",
    "mailto:dev@example.com",
    "/docs/guide",
    "./local",
    "#line-4",
    "?tab=code",
  ]) {
    assert.equal(isSafeDecorationUrl(url), true, `expected safe URL: ${url}`);
    assert.equal(isSafeDecorationAttributeValue("href", url), true);
  }
  for (const url of [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>",
    "vbscript:msgbox(1)",
    "//evil.example/x",
    "\\evil.example/x",
    "http:evil.example",
    "mailto:   ",
  ]) {
    assert.equal(isSafeDecorationUrl(url), false, `expected unsafe URL: ${url}`);
    assert.equal(isSafeDecorationAttributeValue("href", url), false);
    assert.equal(isSafeDecorationAttributeValue("xlink:href", url), false);
  }
  // Non-string URL attribute values (objects/arrays/nullish) must be rejected so
  // `propertyValue()` cannot serialize `{ javascript: "alert(1)" }` into `javascript:alert(1)`.
  for (const nonString of [
    { javascript: "alert(1)" },
    ["javascript:alert(1)"],
    ["https://example.com"],
    null,
    undefined,
    42,
  ]) {
    assert.equal(isSafeDecorationAttributeValue("href", nonString), false);
    assert.equal(isSafeDecorationAttributeValue("HREF", nonString), false);
    assert.equal(isSafeDecorationAttributeValue("xlink:href", nonString), false);
  }

  for (const attr of ["class", "data-line", "aria-label", "0", "tabindex", "xml:lang"])
    assert.equal(isValidHtmlAttributeName(attr), true);
  for (const attr of ["", "a b", "x=1", 'x"y', "x'y", "x<y", "x>y", "x/y", "x\0y", "x\ny"])
    assert.equal(isValidHtmlAttributeName(attr), false);

  assert.equal(isValidCssIdentifier("light"), true);
  assert.equal(isValidCssIdentifier("high-contrast_1"), true);
  assert.equal(isValidCssIdentifier("__proto__"), false);
  assert.equal(isValidCssIdentifier("constructor"), false);
  assert.equal(isValidCssIdentifier("prototype"), false);
  assert.equal(isValidCssIdentifier("1light"), false);
  assert.equal(isValidCssIdentifier("light;color:red"), false);

  assert.equal(isValidCssVariablePrefix("--shiki-"), true);
  assert.equal(isValidCssVariablePrefix("--s-"), true);
  assert.equal(isValidCssVariablePrefix("--my_theme-"), true);
  assert.equal(isValidCssVariablePrefix(""), false);
  assert.equal(isValidCssVariablePrefix("--"), false);
  assert.equal(isValidCssVariablePrefix("shiki-"), false);
  assert.equal(isValidCssVariablePrefix('--custom-<&"'), false);
});

test("code-element-colors sanitizes unsafe values on categorized spans, uncategorized spans, and pre", () => {
  const transformer = createCodeElementColorTransformer();
  const categorized = {
    type: "element",
    tagName: "span",
    properties: {
      style:
        "--shiki-light:#111111;--shiki-dark:red}body{background:url(https://evil.test);--shiki-dark-font-weight:bold;color:#111111",
    },
    children: [{ type: "text", value: "const" }],
  };
  const uncategorized = {
    type: "element",
    tagName: "span",
    properties: {
      style: "color:red);position:fixed;--shiki-dark:url(https://evil.test)</style>",
    },
    children: [{ type: "text", value: "plain" }],
  };
  const pre = {
    type: "element",
    tagName: "pre",
    properties: {
      style:
        "background-color:#101010;color:#f0f0f0;--shiki-light:#f0f0f0;--shiki-dark:red/*unclosed;--shiki-dark-bg:expression(alert(1))",
    },
    children: [categorized, uncategorized],
  };
  const root = { type: "root", children: [pre] };

  transformer.span.call({ options: { styleMode: "inline" } }, categorized, 1, 0, pre, {
    content: "const",
    variants: {
      light: { color: "#111111" },
      dark: { color: "red}body{background:url(https://evil.test)" },
    },
    htmlStyle: categorized.properties.style,
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.span.call({ options: { styleMode: "inline" } }, uncategorized, 1, 1, pre, {
    content: "plain",
    color: "red);position:fixed",
    htmlStyle: uncategorized.properties.style,
    scopeNames: ["source.plain"],
  });
  transformer.root.call({}, root);

  assert.match(categorized.properties.style, /--shiki-light:#111111/);
  assert.doesNotMatch(categorized.properties.style, /url\(|body\{/);

  assert.doesNotMatch(uncategorized.properties.style ?? "", /position:fixed|url\(|<\/style>/);

  assert.match(pre.properties.style, /--shiki-light:#f0f0f0/);
  assert.doesNotMatch(pre.properties.style, /\/\*|expression\(/);
});

test("code-element-colors preserves sizing variables and allows CSS math in theme colors", () => {
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

  assert.match(
    span.properties.style,
    /--_ferriki-token-color:var\(--ferriki-keyword-color, hsl\(calc\(180 \+ 20\) 50% 40%\)\)/,
  );
  assert.match(span.properties.style, /--shiki-dark:oklch\(clamp\(0\.2, 0\.5, 0\.8\) 0\.1 180\)/);
  assert.match(pre.properties.style, /--ferriki-code-line-height:1\.5rem/);
  assert.match(pre.properties.style, /--ferriki-code-padding-block:8px/);
  assert.match(pre.properties.style, /--shiki-animation-duration:200ms/);
  assert.doesNotMatch(pre.properties.style, /url\(/);
});

test("code-element-colors resolves palette roles from theme aliases and allows binary subtraction in calc()", () => {
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

  assert.match(span.properties.style, /--shiki-contrast-font-weight:#abcdef/);
  assert.match(span.properties.style, /--shiki-contrast-font-weight-font-weight:bold/);
  assert.match(span.properties.style, /hsl\(calc\(180 - \(10 \+ 5\)\) 50% 40%\)/);
  assert.match(pre.properties.style, /--shiki-contrast-font-weight:#abcdef/);
  assert.match(pre.properties.style, /--shiki-contrast-font-weight-bg:#000000/);
});

test("theme-tokens drops unsafe colors and resists __proto__ key mutation", () => {
  assert.deepEqual(tokenStyle({ color: "url(https://evil.test)", fontStyle: 2 }), {
    "font-weight": "bold",
  });
  assert.deepEqual(tokenStyle({ color: "oklch(0.6 0.15 200 / 80%)", fontStyle: 1 }), {
    color: "oklch(0.6 0.15 200 / 80%)",
    "font-style": "italic",
  });
  const aligned = alignThemeTokens([
    { color: "__proto__", result: { tokens: [[{ offset: 0, content: "x", color: "#fff" }]] } },
  ]);
  const variants = aligned[0][0].variants;
  assert.equal(Object.getPrototypeOf(variants), Object.prototype);
  assert.equal(Object.hasOwn(variants, "__proto__"), true);
});

test("extractClassStyles extracts and removes case-insensitive STYLE properties", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: {
          class: "ferriki",
          STYLE: "padding:1rem;background:url(https://evil.test)",
        },
        children: [
          {
            type: "element",
            tagName: "span",
            properties: {
              StYlE: "color:red;background:url(https://evil.test)",
            },
            children: [{ type: "text", value: "ok" }],
          },
          {
            type: "element",
            tagName: "span",
            properties: {
              STYLE: "background:url(https://evil.test)",
            },
            children: [{ type: "text", value: "dropped" }],
          },
        ],
      },
    ],
  };

  const css = extractClassStyles(tree);
  assert.doesNotMatch(css, /url\(/);
  assert.match(css, /padding:1rem/);
  assert.match(css, /color:red/);

  const pre = tree.children[0];
  assert.equal("STYLE" in pre.properties, false);
  assert.equal("style" in pre.properties, false);
  assert.match(pre.properties.class, /ferriki-style-/);

  const [firstSpan, secondSpan] = pre.children;
  assert.equal("StYlE" in firstSpan.properties, false);
  assert.match(firstSpan.properties.class, /ferriki-style-/);
  assert.equal("STYLE" in secondSpan.properties, false);
  assert.equal(secondSpan.properties.class, undefined);
});

test("sanitizeCssDeclarations normalizes multiline authored colors and enforces UTF-16 value length", () => {
  assert.equal(
    sanitizeCssDeclarations("color: rgb(255 0\n0);background-color: hsl(180\t50%\r\n40%)"),
    "color:rgb(255 0 0);background-color:hsl(180 50% 40%)",
  );
  // Valid multiline theme colors are whitespace-normalized and preserved across validators/tokens.
  assert.equal(normalizeSafeCssColor("rgb(\n  10,\n  20,\n  30\n)"), "rgb( 10, 20, 30 )");
  assert.equal(isSafeCssColor("rgb(255 0\n0)"), true);
  assert.deepEqual(tokenStyle({ color: "rgb(\n  10,\n  20,\n  30\n)" }), {
    color: "rgb( 10, 20, 30 )",
  });

  // Value length is measured in UTF-16 code units before stripping !important (matching Rust).
  const cjk200 = `--cjk:"${"漢".repeat(200)}"`;
  assert.equal(sanitizeCssDeclarations(cjk200), cjk200);
  assert.equal(sanitizeCssDeclarations(`--cjk:"${"漢".repeat(513)}"`), "");
  assert.equal(sanitizeCssDeclarations(`--x:${"a".repeat(505)} !important`), "");

  // Composed `light-dark(...)` from two 260-char valid `var(--...)` colors survives validation
  // and class extraction, while over-limit or unsafe arguments are rejected.
  const longLight = `var(--${"a".repeat(253)})`;
  const longDark = `var(--${"b".repeat(253)})`;
  assert.equal(longLight.length, 260);
  const composed = `light-dark(${longLight}, ${longDark})`;
  assert.equal(isSafeCssColor(composed), true);
  assert.equal(sanitizeCssDeclarations(`color:${composed}`), `color:${composed}`);
  assert.equal(isSafeCssColor(`light-dark(var(--${"a".repeat(510)}), #fff)`), false);
  assert.equal(
    isSafeCssColor(`light-dark(${longLight}, url(https://evil.test/${"x".repeat(260)}))`),
    false,
  );
  assert.equal(isSafeCssColor(`light-dark(${longLight}, ${longDark}, #fff)`), false);

  // Vite's class-mode output wraps composed `light-dark(...)` inside `var(--..., light-dark(...))`
  // on `--_ferriki-token-color` and `pre` `color`; both survive `extractClassStyles`.
  const transformer = createCodeElementColorTransformer();
  const options = {
    styleMode: "classes",
    defaultColor: "light-dark()",
    themes: { light: "long-light", dark: "long-dark" },
  };
  const span = {
    type: "element",
    tagName: "span",
    properties: {
      style: `color:${composed};--shiki-light:${longLight};--shiki-dark:${longDark}`,
    },
    children: [{ type: "text", value: "const" }],
  };
  const pre = {
    type: "element",
    tagName: "pre",
    properties: {
      style: `background-color:#ffffff;color:${composed}`,
    },
    children: [span],
  };
  const root = { type: "root", children: [pre] };
  transformer.span.call({ options }, span, 1, 0, pre, {
    content: "const",
    variants: {
      light: { color: longLight },
      dark: { color: longDark },
    },
    htmlStyle: span.properties.style,
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.root.call({ options }, root);
  const extractedCss = extractClassStyles(root);
  assert.match(
    extractedCss,
    new RegExp(
      `--_ferriki-token-color:var\\(--ferriki-keyword-color, light-dark\\(${longLight.replace(/[()]/gu, "\\$&")}, ${longDark.replace(/[()]/gu, "\\$&")}\\)\\)`,
    ),
  );
  assert.match(
    extractedCss,
    new RegExp(
      `color:var\\(--ferriki-foreground, light-dark\\(${longLight.replace(/[()]/gu, "\\$&")}, ${longDark.replace(/[()]/gu, "\\$&")}\\)\\)`,
    ),
  );

  // A 500-char single-theme color wrapped in `var(--ferriki-foreground, ...)` (total > 512)
  // survives validation, `sanitizeCssDeclarations`, and `extractClassStyles`, while >512 fails.
  const single500 = `color-mix(in oklch, var(--${"a".repeat(225)}) 50%, var(--${"b".repeat(234)}))`;
  assert.equal(single500.length, 500);
  const wrappedSingle = `var(--ferriki-foreground, ${single500})`;
  assert.equal(isSafeCssColor(wrappedSingle), true);
  assert.equal(sanitizeCssDeclarations(`color:${wrappedSingle}`), `color:${wrappedSingle}`);
  const single513 = `color-mix(in oklch, var(--${"a".repeat(235)}) 50%, var(--${"b".repeat(237)}))`;
  assert.equal(single513.length, 513);
  assert.equal(isSafeCssColor(`var(--ferriki-foreground, ${single513})`), false);

  // Palette/custom properties (`--shiki-*`, `--custom-*`) also preserve composed `light-dark(...)`
  // colors up to the composed limit, and comments around property names are stripped cleanly.
  assert.equal(sanitizeCssDeclarations(`--shiki-light:${composed}`), `--shiki-light:${composed}`);
  assert.equal(sanitizeCssDeclarations(`--custom-light:${composed}`), `--custom-light:${composed}`);
  assert.equal(
    sanitizeCssDeclarations("color:red; /* layout */ padding:1rem"),
    "color:red;padding:1rem",
  );
  assert.equal(
    sanitizeCssDeclarations("color:red; /* note: gap */ padding /* x */ : 1rem"),
    "color:red;padding:1rem",
  );
  assert.equal(sanitizeCssDeclarations("/* unclosed padding:1rem"), "");
  assert.equal(sanitizeCssDeclarations("/* \u0007 */ color:red"), "");

  // Repeated identical style strings across many spans share cached sanitization and one rule.
  const repeatedTree = {
    type: "root",
    children: Array.from({ length: 200 }, () => ({
      type: "element",
      tagName: "span",
      properties: { style: "color:red; /* layout */ font-weight:bold" },
      children: [{ type: "text", value: "x" }],
    })),
  };
  const repeatedCss = extractClassStyles(repeatedTree);
  assert.equal(repeatedCss.split("\n").length, 1);
  assert.match(repeatedCss, /color:red;font-weight:bold/);
  const firstClass = repeatedTree.children[0].properties.class;
  assert.equal(
    repeatedTree.children.every((node) => node.properties.class === firstClass),
    true,
  );

  // Existing uppercase `CLASS` and `className` keys are canonicalized to lowercase `class`.
  const uppercaseClassTree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "span",
        properties: { CLASS: "label", STYLE: "color:red" },
        children: [{ type: "text", value: "ok" }],
      },
      {
        type: "element",
        tagName: "span",
        properties: { className: "label", style: "color:blue" },
        children: [{ type: "text", value: "ok2" }],
      },
    ],
  };
  const uppercaseClassCss = extractClassStyles(uppercaseClassTree);
  assert.match(uppercaseClassCss, /color:red/);
  assert.match(uppercaseClassCss, /color:blue/);
  const [firstProps, secondProps] = uppercaseClassTree.children.map((child) => child.properties);
  assert.equal("CLASS" in firstProps, false);
  assert.equal("STYLE" in firstProps, false);
  assert.match(firstProps.class, /^label ferriki-style-/);
  assert.equal("className" in secondProps, false);
  assert.equal("style" in secondProps, false);
  assert.match(secondProps.class, /^label ferriki-style-/);

  // Vite's color transformer preserves safe `!important` declarations and drops unsafe ones.
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
  transformer.root.call({ options: importantOptions }, { type: "root", children: [importantPre] });
  assert.match(importantSpan.properties.style, /background-color:yellow !important/);
  assert.doesNotMatch(importantSpan.properties.style, /url\(|!bogus/);
  assert.match(importantPre.properties.style, /var\(--ferriki-background-color, yellow\)/);

  // Callback-authored `--shiki-*` properties outside the configured palette stay untouched while
  // unsafe values on generated palette variables (`--shiki-bad`) are dropped.
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
  assert.match(cjkCustomPre.properties.style, /--shiki-font-family:"源ノ角ゴシック"/);
  assert.doesNotMatch(cjkCustomPre.properties.style, /--shiki-bad/);
});

test("code-element-colors tracks all applicable roles for overlapping theme aliases", () => {
  const transformer = createCodeElementColorTransformer();
  const options = {
    styleMode: "inline",
    themes: {
      light: "github-light",
      "contrast-font-weight": "github-dark",
      contrast: "github-dark",
    },
  };
  const span = {
    type: "element",
    tagName: "span",
    properties: {
      style: "color:#111111;--shiki-contrast-font-weight:bold",
    },
    children: [{ type: "text", value: "const" }],
  };
  const pre = {
    type: "element",
    tagName: "pre",
    properties: {
      style:
        "background-color:#101010;color:#f0f0f0;--shiki-contrast-font-weight:#abcdef;--shiki-light:url(https://evil.test)",
    },
    children: [span],
  };
  const root = { type: "root", children: [pre] };

  transformer.span.call({ options }, span, 1, 0, pre, {
    content: "const",
    variants: {
      light: { color: "#111111" },
      "contrast-font-weight": { color: "#abcdef" },
      contrast: { color: "#222222", "font-weight": "bold" },
    },
    htmlStyle: span.properties.style,
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.root.call({ options }, root);

  assert.match(span.properties.style, /--shiki-contrast-font-weight:bold/);
  assert.match(pre.properties.style, /--shiki-contrast-font-weight:#abcdef/);
  assert.doesNotMatch(pre.properties.style, /url\(/);
});

test("formatSafeTokenStyleEntry preserves valid single declarations and blocks boundary smuggling", () => {
  assert.equal(formatSafeTokenStyleEntry("color", "red"), "color:red");
  assert.equal(
    formatSafeTokenStyleEntry("background-image", "url(/local.png)"),
    "background-image:url(/local.png)",
  );
  assert.equal(
    formatSafeTokenStyleEntry("backgroundImage", "url(/local.png)"),
    "backgroundImage:url(/local.png)",
  );
  assert.equal(
    formatSafeTokenStyleEntry("background-image", "url(data:image/png;base64,AAAA)"),
    "background-image:url(data:image/png;base64,AAAA)",
  );
  assert.equal(formatSafeTokenStyleEntry("--café", "red"), "--café:red");
  assert.equal(formatSafeTokenStyleEntry("color", "var(--café)"), "color:var(--café)");
  assert.equal(formatSafeTokenStyleEntry("content", '"a;b"'), 'content:"a;b"');
  assert.equal(formatSafeTokenStyleEntry("content", '"</style>"'), 'content:"</style>"');
  assert.equal(formatSafeTokenStyleEntry("--decoration", " "), "--decoration: ");
  assert.equal(formatSafeTokenStyleEntry("--decoration", ""), undefined);
  assert.equal(formatSafeTokenStyleEntry("color", " "), undefined);
  assert.equal(sanitizeCssDeclarations("--decoration: ; color: red"), "--decoration: ;color:red");
  assert.equal(sanitizeCssDeclarations({ "--decoration": " " }), "--decoration: ");
  assert.equal(sanitizeCssDeclarations("--decoration:"), "");
  assert.equal(sanitizeCssDeclarations("color: "), "");
  assert.equal(sanitizeCssDeclarations('content:"</style>"'), "");

  assert.equal(formatSafeTokenStyleEntry("--café:x", "red"), undefined);
  assert.equal(formatSafeTokenStyleEntry("--café;x", "red"), undefined);
  assert.equal(formatSafeTokenStyleEntry("--café x", "red"), undefined);
  assert.equal(formatSafeTokenStyleEntry("--café(x)", "red"), undefined);
  assert.equal(formatSafeTokenStyleEntry("--café/x", "red"), undefined);
  assert.equal(formatSafeTokenStyleEntry("--", "red"), undefined);

  assert.equal(formatSafeTokenStyleEntry("color", "red;position:fixed"), undefined);
  assert.equal(
    formatSafeTokenStyleEntry("background-image", "url(data:image/png;base64,AAAA);position:fixed"),
    undefined,
  );
  assert.equal(
    formatSafeTokenStyleEntry("background-image", "url(data:image/png;base64,AAAA"),
    undefined,
  );
  assert.equal(formatSafeTokenStyleEntry("color", "red}{body{color:blue}"), undefined);
  assert.equal(formatSafeTokenStyleEntry("color", 'red"unclosed'), undefined);
  assert.equal(formatSafeTokenStyleEntry("--brand\\:accent", "red"), "--brand\\:accent:red");
  assert.equal(formatSafeTokenStyleEntry("--brand\\3a accent", "red"), "--brand\\3a accent:red");
  assert.equal(formatSafeTokenStyleEntry("--brand\\", "red"), undefined);
  assert.equal(formatSafeTokenStyleEntry("--brand\\\naccent", "red"), undefined);
  assert.equal(formatSafeTokenStyleEntry("--brand\\0 ", "red"), undefined);
  assert.equal(formatSafeTokenStyleEntry("--brand:accent", "red"), undefined);
  assert.equal(formatSafeTokenStyleEntry("color", "red /* unclosed"), undefined);
  assert.equal(formatSafeTokenStyleEntry("color", "red */"), undefined);
  assert.equal(formatSafeTokenStyleEntry("color", "rgb(1, 2, 3"), undefined);
  assert.equal(formatSafeTokenStyleEntry("color", "red\\"), undefined);
  assert.equal(formatSafeTokenStyleEntry("color", "red\u0007"), undefined);
  assert.equal(formatSafeTokenStyleEntry("color:red;position", "fixed"), undefined);
  assert.equal(formatSafeTokenStyleEntry("behavior", "url(x.htc)"), undefined);
});

test("extractClassStyles follows HTML first-attribute-wins when multiple style case variants exist", () => {
  const span = {
    type: "element",
    tagName: "span",
    properties: { style: "color:red", STYLE: "font-weight:bold" },
    children: [{ type: "text", value: "x" }],
  };
  const css = extractClassStyles({ type: "root", children: [span] });
  assert.match(css, /color:red/);
  assert.doesNotMatch(css, /font-weight:bold/);
  assert.equal("style" in span.properties, false);
  assert.equal("STYLE" in span.properties, false);
});

test("extractClassStyles handles frozen elements and frozen properties without mutating them", () => {
  const frozenProps = Object.freeze({ style: "color:red;background:url(https://evil.test)" });
  const frozenSpan = Object.freeze({
    type: "element",
    tagName: "span",
    properties: frozenProps,
    children: Object.freeze([{ type: "text", value: "x" }]),
  });
  const root = { type: "root", children: [frozenSpan] };
  const css = extractClassStyles(root);
  assert.match(css, /color:red/);
  assert.doesNotMatch(css, /evil\.test/);
  assert.equal(frozenProps.style, "color:red;background:url(https://evil.test)");
  assert.notEqual(root.children[0], frozenSpan);
  assert.equal("style" in root.children[0].properties, false);
  assert.match(root.children[0].properties.class, /ferriki-style-/);

  const frozenRoot = Object.freeze({
    type: "root",
    children: Object.freeze([frozenSpan]),
  });
  const extracted = extractClassStylesFromTree(frozenRoot);
  assert.match(extracted.css, /color:red/);
  assert.doesNotMatch(extracted.css, /evil\.test/);
  assert.notEqual(extracted.tree, frozenRoot);
  assert.equal(frozenRoot.children[0], frozenSpan);
  assert.equal("style" in extracted.tree.children[0].properties, false);
  assert.match(extracted.tree.children[0].properties.class, /ferriki-style-/);
});

test("sanitizeCssDeclarations preserves valid empty var() fallbacks and rejects malformed var() names", () => {
  assert.equal(
    sanitizeCssDeclarations(
      "transform: translateX(1rem) var(--extra-transform,); color: var(--accent,)",
    ),
    "transform:translateX(1rem) var(--extra-transform,);color:var(--accent,)",
  );
  assert.equal(sanitizeCssDeclarations("color: var(,); background: var(--,)"), "");

  const transformer = createCodeElementColorTransformer();
  const span = {
    type: "element",
    tagName: "span",
    properties: { style: "--shiki-dark:var(--accent,);--shiki-light:var(--,)" },
    children: [{ type: "text", value: "x" }],
  };
  const pre = {
    type: "element",
    tagName: "pre",
    properties: { style: "color:var(--accent,)" },
    children: [span],
  };
  const ctx = {
    options: { styleMode: "inline", themes: { light: "github-light", dark: "github-dark" } },
  };
  transformer.span.call(ctx, span, 1, 0, pre, {
    content: "x",
    htmlStyle: span.properties.style,
    scopeNames: ["source.js"],
  });
  transformer.root.call(ctx, { type: "root", children: [pre] });
  assert.match(span.properties.style, /--shiki-dark:var\(--accent,\)/u);
  assert.doesNotMatch(span.properties.style, /--shiki-light/u);
  assert.match(pre.properties.style, /color:var\(--ferriki-foreground, var\(--accent,\)\)/u);
});

test("code-element-colors preserves colors authored after the span hook on uncategorized inline spans", () => {
  const transformer = createCodeElementColorTransformer();
  const themedSpan = {
    type: "element",
    tagName: "span",
    properties: { style: "color:#d8dee9" },
    children: [{ type: "text", value: "plain" }],
  };
  const bareSpan = {
    type: "element",
    tagName: "span",
    properties: {},
    children: [{ type: "text", value: "bare" }],
  };
  const pre = {
    type: "element",
    tagName: "pre",
    properties: { style: "color:#f0f0f0;background-color:#101010" },
    children: [themedSpan, bareSpan],
  };
  const ctx = { options: { styleMode: "inline" } };
  transformer.span.call(ctx, themedSpan, 1, 0, pre, {
    content: "plain",
    color: "#d8dee9",
    htmlStyle: "color:#d8dee9",
    scopeNames: ["source.js"],
  });
  transformer.span.call(ctx, bareSpan, 1, 5, pre, {
    content: "bare",
    scopeNames: ["source.js"],
  });
  themedSpan.properties.style = "color:red /* accent */";
  bareSpan.properties.style = "color:blue /* highlight */";
  transformer.root.call(ctx, { type: "root", children: [pre] });
  assert.equal(themedSpan.properties.style, "color:red /* accent */");
  assert.equal(bareSpan.properties.style, "color:blue /* highlight */");
});

test("sanitizeCssDeclarations and isSafeCssColor preserve valid non-ASCII custom properties and reject unsafe names", () => {
  assert.equal(
    sanitizeCssDeclarations("--café: red; color: var(--café)"),
    "--café:red;color:var(--café)",
  );
  assert.equal(isSafeCssColor("var(--café)"), true);
  assert.equal(isSafeCssColor("var(--café, #fff)"), true);
  assert.equal(sanitizeCssDeclarations({ "--a;b": "red", "--a}b": "red", "--a(b)": "red" }), "");
  assert.equal(sanitizeCssDeclarations("--a}b: red; --a(b): red; --caf\u00A0é: red"), "");
  assert.equal(isSafeCssColor("var(--a;b)"), false);
  assert.equal(isSafeCssColor("var(--a}b)"), false);
  assert.equal(isSafeCssColor("var(--a(b))"), false);
  assert.equal(isSafeCssColor("var(--caf\u00A0é)"), false);

  assert.equal(isValidInlineCssVariablePrefix("--"), true);
  assert.equal(isValidInlineCssVariablePrefix("--shiki-"), true);
  assert.equal(isValidInlineCssVariablePrefix(""), false);
  assert.equal(isValidInlineCssVariablePrefix("shiki-"), false);
  assert.equal(isValidInlineCssVariablePrefix("--x;color:red"), false);
  assert.equal(isValidInlineCssVariablePrefix("--\uD800"), false);
  assert.equal(isValidInlineThemeAlias("--", "dark"), true);
  assert.equal(isValidInlineThemeAlias("--", "light"), true);
  assert.equal(isValidInlineThemeAlias("--", ""), false);
  assert.equal(isValidInlineThemeAlias("--shiki-", "light;color:red"), false);
  assert.equal(isValidInlineThemeAlias("--shiki-", "bad key"), false);
  assert.equal(isValidInlineThemeAlias("--shiki-", "__proto__"), false);
  assert.equal(isValidCssCustomPropertyName("--dark"), true);
  assert.equal(isValidCssCustomPropertyName("--"), false);
  assert.equal(isValidCssCustomPropertyName("--\uD800"), false);
});

test("code-element-colors preserves non-ASCII color variables on uncategorized spans and strips unsafe names", () => {
  const transformer = createCodeElementColorTransformer();
  const safeSpan = {
    type: "element",
    tagName: "span",
    properties: { style: "color:var(--café)" },
    children: [{ type: "text", value: "plain" }],
  };
  const badSpan = {
    type: "element",
    tagName: "span",
    properties: { style: "color:var(--a}b);background-color:var(--caf\u00A0é)" },
    children: [{ type: "text", value: "bad" }],
  };
  const pre = {
    type: "element",
    tagName: "pre",
    properties: { style: "background-color:#101010;color:#f0f0f0" },
    children: [safeSpan, badSpan],
  };
  const options = { styleMode: "inline" };
  transformer.span.call({ options }, safeSpan, 1, 0, pre, {
    content: "plain",
    htmlStyle: safeSpan.properties.style,
    scopeNames: ["source.txt"],
  });
  transformer.span.call({ options }, badSpan, 1, 1, pre, {
    content: "bad",
    htmlStyle: badSpan.properties.style,
    scopeNames: ["source.txt"],
  });
  transformer.root.call({ options }, { type: "root", children: [pre] });
  assert.equal(safeSpan.properties.style, "color:var(--café)");
  assert.equal(badSpan.properties.style, undefined);

  const quotedBangPre = {
    type: "element",
    tagName: "pre",
    properties: {
      style:
        'background-color:#101010;color:#f0f0f0;--shiki-font-family:"What a Font!";--shiki-alt-font:"Hello!" !important;--shiki-marker:"Step: "',
    },
    children: [],
  };
  const markerSpan = {
    type: "element",
    tagName: "span",
    properties: { style: 'color:#d8dee9;--shiki-marker:"Step: "' },
    children: [{ type: "text", value: "step" }],
  };
  quotedBangPre.children.push(markerSpan);
  transformer.span.call({ options }, markerSpan, 1, 0, quotedBangPre, {
    content: "step",
    color: "#d8dee9",
    htmlStyle: "color:#d8dee9",
    scopeNames: ["source.txt"],
  });
  transformer.root.call({ options }, { type: "root", children: [quotedBangPre] });
  assert.match(quotedBangPre.properties.style, /--shiki-font-family:"What a Font!"/u);
  assert.match(quotedBangPre.properties.style, /--shiki-alt-font:"Hello!" !important/u);
  assert.match(quotedBangPre.properties.style, /--shiki-marker:"Step: "/u);
  assert.match(markerSpan.properties.style, /--shiki-marker:"Step: "/u);

  // Single-theme class mode with a multiline `rgb()` token color compares normalized colors so
  // it is treated as a theme color (not misclassified as `ferriki-color-authored`).
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
  const classOptions = { styleMode: "classes" };
  transformer.span.call({ options: classOptions }, multilineClassSpan, 1, 0, multilineClassPre, {
    content: "const",
    color: "rgb(\n  10,\n  20,\n  30\n)",
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.root.call({ options: classOptions }, { type: "root", children: [multilineClassPre] });
  assert.match(multilineClassSpan.properties.class, /ferriki-color-token/u);
  assert.doesNotMatch(multilineClassSpan.properties.class, /ferriki-color-authored/u);
  assert.match(
    multilineClassSpan.properties.style,
    /--_ferriki-token-color:var\(--ferriki-keyword-color, rgb\( 10, 20, 30 \)\)/u,
  );

  // Frozen spans replaced via copy-on-write carry `ferriki.sanitizedCloneOrigin` so
  // `code-element-colors` still resolves their semantic record in `root`.
  const origFrozenSpan = {
    type: "element",
    tagName: "span",
    properties: { style: "color:#81a1c1" },
    children: [{ type: "text", value: "const" }],
  };
  const clonedFrozenSpan = {
    type: "element",
    tagName: "span",
    properties: { style: "color:#81a1c1" },
    children: [{ type: "text", value: "const" }],
  };
  Object.defineProperty(clonedFrozenSpan, Symbol.for("ferriki.sanitizedCloneOrigin"), {
    value: origFrozenSpan,
    enumerable: false,
  });
  const clonePre = {
    type: "element",
    tagName: "pre",
    properties: { style: "color:#f0f0f0;background-color:#101010" },
    children: [clonedFrozenSpan],
  };
  transformer.span.call({ options: { styleMode: "inline" } }, origFrozenSpan, 1, 0, clonePre, {
    content: "const",
    color: "#81a1c1",
    htmlStyle: "color:#81a1c1",
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.root.call(
    { options: { styleMode: "inline" } },
    { type: "root", children: [clonePre] },
  );
  assert.match(clonedFrozenSpan.properties.class, /ferriki-color-token/u);
  assert.match(
    clonedFrozenSpan.properties.style,
    /--_ferriki-token-color:var\(--ferriki-keyword-color, #81a1c1\)/u,
  );

  // Valid composed colors inside `light-dark(...)` semantic fallbacks survive validation while
  // deeply nested `light-dark(...)` expressions beyond the depth cap are rejected.
  const composedLightArg = `var(--light-a, var(--light-b, color-mix(in oklch, var(--${"a".repeat(220)}) 50%, var(--${"b".repeat(220)}))))`;
  const composedDarkArg = `var(--dark-a, var(--dark-b, color-mix(in oklch, var(--${"c".repeat(220)}) 50%, var(--${"d".repeat(220)}))))`;
  assert.equal(isSafeCssColor(composedLightArg), true);
  assert.equal(isSafeCssColor(composedDarkArg), true);
  const combinedLightDark = `light-dark(${composedLightArg}, ${composedDarkArg})`;
  assert.equal(isSafeCssColor(combinedLightDark), true);
  assert.equal(
    sanitizeCssDeclarations(
      `--_ferriki-token-color:var(--ferriki-keyword-color, ${combinedLightDark})`,
    ),
    `--_ferriki-token-color:var(--ferriki-keyword-color, ${combinedLightDark})`,
  );
  const tooDeep = `light-dark(light-dark(light-dark(light-dark(light-dark(${composedLightArg}, #000), #000), #000), #000), #000)`;
  assert.equal(isSafeCssColor(tooDeep), false);

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
  const themedOptions = {
    styleMode: "inline",
    themes: { light: "github-light", dark: "github-dark" },
  };
  transformer.span.call({ options: themedOptions }, fontOverridesSpan, 1, 0, fontOverridesPre, {
    content: "const",
    variants: { light: { color: "#111111" }, dark: { color: "#eeeeee" } },
    htmlStyle: fontOverridesSpan.properties.style,
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.root.call({ options: themedOptions }, { type: "root", children: [fontOverridesPre] });
  assert.match(fontOverridesSpan.properties.style, /--shiki-dark-font-style:oblique 12deg/u);
  assert.match(fontOverridesSpan.properties.style, /--shiki-dark-font-weight:450\.5/u);
  assert.match(
    fontOverridesSpan.properties.style,
    /--shiki-dark-text-decoration:underline wavy #ff0000 2px/u,
  );
  assert.doesNotMatch(fontOverridesSpan.properties.style, /--shiki-light-font-style/u);
  assert.doesNotMatch(fontOverridesSpan.properties.style, /--shiki-light-font-weight/u);
  assert.doesNotMatch(fontOverridesSpan.properties.style, /--shiki-light-text-decoration/u);
});

test("code-element-colors preserves valid theme colors with CSS comments and rejects hostile comments", () => {
  const transformer = createCodeElementColorTransformer();
  const commentedSpan = {
    type: "element",
    tagName: "span",
    properties: { style: "color:rgb(255 /* red */ 0 0)" },
    children: [{ type: "text", value: "const" }],
  };
  const unclosedSpan = {
    type: "element",
    tagName: "span",
    properties: { style: "color:rgb(255 /* unclosed" },
    children: [{ type: "text", value: "var" }],
  };
  const styleTagSpan = {
    type: "element",
    tagName: "span",
    properties: { style: "color:rgb(255 /* </style> */ 0 0)" },
    children: [{ type: "text", value: "let" }],
  };
  const pre = {
    type: "element",
    tagName: "pre",
    properties: {
      style: "color:rgb(255 /* fg */ 0 0);background-color:/* bg */ #101010",
    },
    children: [commentedSpan, unclosedSpan, styleTagSpan],
  };
  transformer.span.call({ options: { styleMode: "inline" } }, commentedSpan, 1, 0, pre, {
    content: "const",
    color: "rgb(255 /* red */ 0 0)",
    htmlStyle: "color:rgb(255 /* red */ 0 0)",
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.span.call({ options: { styleMode: "inline" } }, unclosedSpan, 1, 1, pre, {
    content: "var",
    color: "rgb(255 /* unclosed",
    htmlStyle: "color:rgb(255 /* unclosed",
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.span.call({ options: { styleMode: "inline" } }, styleTagSpan, 1, 2, pre, {
    content: "let",
    color: "rgb(255 /* </style> */ 0 0)",
    htmlStyle: "color:rgb(255 /* </style> */ 0 0)",
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.root.call({ options: { styleMode: "inline" } }, { type: "root", children: [pre] });
  assert.match(pre.properties.style, /color:var\(--ferriki-foreground, rgb\(255 0 0\)\)/u);
  assert.match(
    pre.properties.style,
    /background-color:var\(--ferriki-background-color, #101010\)/u,
  );
  assert.match(
    commentedSpan.properties.style,
    /--_ferriki-token-color:var\(--ferriki-keyword-color, rgb\(255 0 0\)\)/u,
  );
  assert.match(
    unclosedSpan.properties.style,
    /--_ferriki-token-color:var\(--ferriki-keyword-color, inherit\)/u,
  );
  assert.match(
    styleTagSpan.properties.style,
    /--_ferriki-token-color:var\(--ferriki-keyword-color, inherit\)/u,
  );
  assert.doesNotMatch(styleTagSpan.properties.style, /<\/style>/iu);

  // `env(<ident>, <safe-color>)` is preserved as a valid theme color while hostile fallbacks
  // or malformed env identifiers fall back to `inherit`.
  const envSpan = {
    type: "element",
    tagName: "span",
    properties: { style: "color:env(viewport-segment-color 0 0, #c00)" },
    children: [{ type: "text", value: "const" }],
  };
  const badEnvSpan = {
    type: "element",
    tagName: "span",
    properties: { style: "color:env(viewport-segment-color -1, #c00)" },
    children: [{ type: "text", value: "var" }],
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
    content: "var",
    color: "env(viewport-segment-color -1, #c00)",
    htmlStyle: "color:env(viewport-segment-color -1, #c00)",
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.root.call({ options: { styleMode: "inline" } }, { type: "root", children: [envPre] });
  assert.match(envPre.properties.style, /color:var\(--ferriki-foreground, env\(📐, blue\)\)/u);
  assert.match(
    envSpan.properties.style,
    /--_ferriki-token-color:var\(--ferriki-keyword-color, env\(viewport-segment-color 0 0, #c00\)\)/u,
  );
  assert.match(
    badEnvSpan.properties.style,
    /--_ferriki-token-color:var\(--ferriki-keyword-color, inherit\)/u,
  );

  // Frozen uncategorized spans (and frozen pre/root ancestors) with trailing CSS comments are
  // cleaned by cloning instead of throwing a `TypeError` on read-only property assignment.
  const frozenProps = Object.freeze({ style: "color:#111; /* trailing comment */" });
  const frozenSpan = Object.freeze({
    type: "element",
    tagName: "span",
    properties: frozenProps,
    children: Object.freeze([{ type: "text", value: "plain" }]),
  });
  const frozenPre = Object.freeze({
    type: "element",
    tagName: "pre",
    properties: Object.freeze({ style: "color:#f0f0f0;background-color:#101010" }),
    children: Object.freeze([frozenSpan]),
  });
  const frozenRoot = Object.freeze({ type: "root", children: Object.freeze([frozenPre]) });
  transformer.span.call({ options: { styleMode: "inline" } }, frozenSpan, 1, 0, frozenPre, {
    content: "plain",
    color: "#111",
    htmlStyle: "color:#111; /* trailing comment */",
  });
  const updatedFrozenRoot = transformer.root.call({ options: { styleMode: "inline" } }, frozenRoot);
  assert.notEqual(updatedFrozenRoot, frozenRoot);
  assert.equal(frozenSpan.properties, frozenProps);
  assert.equal(frozenSpan.properties.style, "color:#111; /* trailing comment */");
  assert.equal(updatedFrozenRoot.children[0].children[0].properties.style, "color:#111");
  assert.match(
    updatedFrozenRoot.children[0].properties.style,
    /color:var\(--ferriki-foreground, #f0f0f0\)/u,
  );
});

test("var() and env() accept valid CSS identifier escapes and reject invalid escapes", () => {
  for (const valid of [
    "var(--brand\\+accent)",
    "var(--brand\\3a accent)",
    "var(--brand\\3a accent, #fff)",
    "var(--brand\\+accent, var(--fallback\\3a color, rgb(10 20 30)))",
    "color-mix(in oklch, var(--brand\\+accent) 50%, var(--brand\\3a accent))",
    "light-dark(var(--brand\\+accent, #111), var(--brand\\3a accent, #eee))",
    "env(my\\-env 0, #fff)",
    "env(my\\3a env 0, #fff)",
  ]) {
    assert.equal(isSafeCssColor(valid), true, `expected safe: ${valid}`);
    assert.equal(sanitizeCssDeclarations(`color:${valid}`), `color:${valid}`);
  }
  assert.equal(
    sanitizeCssDeclarations("border-color:var(--brand\\+accent);--brand\\3a accent:#fff"),
    "border-color:var(--brand\\+accent);--brand\\3a accent:#fff",
  );
  for (const invalid of [
    "var(--a\\0b)",
    "var(--a\\)",
    "var(--a\\0)",
    "var(--a\\000000b)",
    "var(--a\\0a b)",
    "var(--a\\7f b)",
    "var(--a\\d800 b)",
    "var(--a\\d800x)",
    "var(--a\\110000b)",
    "var(--a+b)",
    "var(--a:b)",
    "var(--a\\;color:red)",
    "rgb(255 \\30 0)",
    "var(--a\\+b, \\30)",
    "env(my\\0env 0, #fff)",
    "env(my\\)",
  ]) {
    assert.equal(isSafeCssColor(invalid), false, `expected rejected: ${invalid}`);
    assert.equal(sanitizeCssDeclarations(`color:${invalid}`), "");
  }

  // Verify the Vite code-element color pass stays in lockstep.
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
    properties: { style: "color:var(--brand\\+accent);background-color:var(--brand\\3a accent)" },
    children: [plusSpan, hexSpan, badNullSpan, badParenSpan],
  };
  const opts = { options: { styleMode: "inline" } };
  transformer.span.call(opts, plusSpan, 1, 0, pre, {
    content: "const",
    color: "var(--brand\\+accent)",
    htmlStyle: "color:var(--brand\\+accent)",
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.span.call(opts, hexSpan, 1, 1, pre, {
    content: "let",
    color: "var(--brand\\3a accent)",
    htmlStyle: "color:var(--brand\\3a accent)",
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.span.call(opts, badNullSpan, 1, 2, pre, {
    content: "var",
    color: "var(--a\\0b)",
    htmlStyle: "color:var(--a\\0b)",
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.span.call(opts, badParenSpan, 1, 3, pre, {
    content: "for",
    color: "var(--a\\)",
    htmlStyle: "color:var(--a\\)",
    scopeNames: ["source.js", "keyword.control.js"],
  });
  transformer.root.call(opts, { type: "root", children: [pre] });
  assert.match(
    pre.properties.style,
    /color:var\(--ferriki-foreground, var\(--brand\\\+accent\)\)/u,
  );
  assert.match(
    pre.properties.style,
    /background-color:var\(--ferriki-background-color, var\(--brand\\3a accent\)\)/u,
  );
  assert.match(
    plusSpan.properties.style,
    /--_ferriki-token-color:var\(--ferriki-keyword-color, var\(--brand\\\+accent\)\)/u,
  );
  assert.match(
    hexSpan.properties.style,
    /--_ferriki-token-color:var\(--ferriki-keyword-color, var\(--brand\\3a accent\)\)/u,
  );
  assert.match(
    badNullSpan.properties.style,
    /--_ferriki-token-color:var\(--ferriki-keyword-color, inherit\)/u,
  );
  assert.match(
    badParenSpan.properties.style,
    /--_ferriki-token-color:var\(--ferriki-keyword-color, inherit\)/u,
  );
});

test("nestScopes handles frozen containers and children without mutating them", () => {
  const token = Object.freeze({
    type: "element",
    tagName: "span",
    properties: Object.freeze({ class: "tok" }),
    children: Object.freeze([{ type: "text", value: "x" }]),
  });
  const frozenLine = Object.freeze({
    type: "element",
    tagName: "span",
    properties: Object.freeze({ class: "line" }),
    children: Object.freeze([token]),
  });
  const root = Object.freeze({
    type: "root",
    children: Object.freeze([frozenLine]),
  });
  const paths = new WeakMap([[token, ["source.js"]]]);
  const nested = nestScopes(root, paths, createScopeClassCache());
  assert.notEqual(nested, root);
  assert.equal(frozenLine.children[0], token);
  assert.equal(nested.children[0].children[0].tagName, "span");
  assert.match(nested.children[0].children[0].properties.class, /exact-source-js/u);
});
