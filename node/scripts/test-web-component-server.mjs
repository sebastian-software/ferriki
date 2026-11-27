import assert from "node:assert/strict";
import test from "node:test";

import { renderCodeElementShadows } from "../ferriki/web-component-server.mjs";
import { codeElementStyles } from "../ferriki/web-component.mjs";

test("reference hosts receive the exact DSD protocol and escaped shared stylesheet URL", () => {
  const markup = '<main><ferriki-code class="sample" code-ref="Block-1"></ferriki-code></main>';
  const result = renderCodeElementShadows(markup, {
    blocks: { "Block-1": "<pre><code>const x = 1;</code></pre>" },
    stylesheetHref: '/assets/code.css?theme="light"&v=1',
  });

  assert.equal(
    result,
    `<main><ferriki-code class="sample" code-ref="Block-1"><template shadowrootmode="open"><!--ferriki-code:Block%2D1--><style data-ferriki-code-base>${codeElementStyles()}</style><link rel="stylesheet" href="/assets/code.css?theme=&quot;light&quot;&amp;v=1" data-ferriki-code-css><pre><code>const x = 1;</code></pre></template></ferriki-code></main>`,
  );
});

test("whitespace-only hosts are eligible and the stylesheet link is optional", () => {
  const markup = '<ferriki-code code-ref="one">\n \t</ferriki-code>';
  assert.equal(
    renderCodeElementShadows(markup, { blocks: { one: "<pre>one</pre>" } }),
    `<ferriki-code code-ref="one"><template shadowrootmode="open"><!--ferriki-code:one--><style data-ferriki-code-base>${codeElementStyles()}</style><pre>one</pre></template></ferriki-code>`,
  );
});

test("leading hyphens are valid code-ref characters and are encoded in the marker", () => {
  assert.equal(
    renderCodeElementShadows('<ferriki-code code-ref="-leading"></ferriki-code>', {
      blocks: { "-leading": "<pre>ok</pre>" },
    }),
    `<ferriki-code code-ref="-leading"><template shadowrootmode="open"><!--ferriki-code:%2Dleading--><style data-ferriki-code-base>${codeElementStyles()}</style><pre>ok</pre></template></ferriki-code>`,
  );
});

test("SSR uses the supplied aliases for the embedded base style", () => {
  const markup = '<ferriki-code code-ref="one"></ferriki-code>';
  const result = renderCodeElementShadows(markup, {
    blocks: { one: "<pre>one</pre>" },
    themeAliases: ["day", "night"],
  });

  assert.match(result, /data-ferriki-code-base>[\s\S]*data-ferriki-theme="day"/);
  assert.match(result, /data-ferriki-theme="night"/);
  assert.doesNotMatch(result, /data-ferriki-theme="light"/);
});

test("manual, nonempty, property-backed, and non-reference hosts are preserved", () => {
  const markup = [
    '<ferriki-code highlightedCode="manual" code-ref="known"></ferriki-code>',
    '<ferriki-code highlighted-code="manual" code-ref="known"></ferriki-code>',
    '<ferriki-code code-ref="known"><pre>manual</pre></ferriki-code>',
    '<ferriki-code code-ref="known">text</ferriki-code>',
    "<ferriki-code></ferriki-code>",
    '<ferriki-code code-ref="known" />',
  ].join("");

  assert.equal(
    renderCodeElementShadows(markup, { blocks: { known: "<pre>generated</pre>" } }),
    markup,
  );
});

test("scanner ignores comments, declarations, raw text, RCDATA, quoted attributes, and templates", () => {
  const apparentHost = '<ferriki-code code-ref="missing"></ferriki-code>';
  const markup = [
    `<!-- ${apparentHost} -->`,
    "<!doctype html PUBLIC \"<ferriki-code code-ref='missing'></ferriki-code>\">",
    `<script>const source = ${JSON.stringify(apparentHost)};</script>`,
    `<style>.sample::after { content: ${JSON.stringify(apparentHost)}; }</style>`,
    `<textarea>${apparentHost}</textarea>`,
    `<title>${apparentHost}</title>`,
    `<template>${apparentHost}</template>`,
    `<div data-markup="${apparentHost.replaceAll('"', "&quot;")}"></div>`,
    '<ferriki-code data-label="a > b" code-ref="present"> \n </ferriki-code>',
  ].join("");

  const untouched = markup.slice(0, markup.lastIndexOf('<ferriki-code data-label="a > b"'));
  assert.equal(
    renderCodeElementShadows(markup, { blocks: { present: "<pre>ok</pre>" } }),
    `${untouched}<ferriki-code data-label="a > b" code-ref="present"><template shadowrootmode="open"><!--ferriki-code:present--><style data-ferriki-code-base>${codeElementStyles()}</style><pre>ok</pre></template></ferriki-code>`,
  );
});

test("a second pass leaves existing declarative roots unchanged", () => {
  const options = {
    blocks: { "block-2": "<pre><code>safe</code></pre>" },
    stylesheetHref: "/code.css",
  };
  const once = renderCodeElementShadows(
    '<ferriki-code code-ref="block-2"></ferriki-code>',
    options,
  );
  assert.equal(renderCodeElementShadows(once, options), once);
});

test("unknown and malformed references fail only for empty reference hosts", () => {
  assert.throws(
    () =>
      renderCodeElementShadows('<ferriki-code code-ref="missing"></ferriki-code>', { blocks: {} }),
    /No trusted HTML block was provided for code-ref "missing"/,
  );
  assert.equal(
    renderCodeElementShadows('<ferriki-code code-ref="missing">manual</ferriki-code>', {
      blocks: {},
    }),
    '<ferriki-code code-ref="missing">manual</ferriki-code>',
  );
  assert.throws(
    () =>
      renderCodeElementShadows('<ferriki-code code-ref="has space"></ferriki-code>', {
        blocks: {},
      }),
    /Unsupported code-ref ID/,
  );
  assert.throws(
    () =>
      renderCodeElementShadows('<ferriki-code code-ref="one" code-ref="two"></ferriki-code>', {
        blocks: { one: "", two: "" },
      }),
    /exactly one `code-ref` attribute/,
  );
});

test("inputs validate the complete block registry, stylesheet URL, and theme aliases", () => {
  assert.throws(() => renderCodeElementShadows(null, { blocks: {} }), /`markup` must be a string/);
  assert.throws(() => renderCodeElementShadows("", null), /`options` must be an object/);
  assert.throws(() => renderCodeElementShadows("", {}), /`blocks` must be a record/);
  assert.throws(() => renderCodeElementShadows("", { blocks: [] }), /`blocks` must be a record/);
  assert.throws(
    () => renderCodeElementShadows("", { blocks: { "": "" } }),
    /Unsupported code-ref ID/,
  );
  assert.throws(
    () => renderCodeElementShadows("", { blocks: { é: "" } }),
    /Unsupported code-ref ID/,
  );
  assert.throws(() => renderCodeElementShadows("", { blocks: { safe: 42 } }), /must be a string/);
  const symbolKeyedBlocks = { [Symbol("hidden")]: "<pre>ignored</pre>" };
  assert.throws(
    () => renderCodeElementShadows("", { blocks: symbolKeyedBlocks }),
    /Unsupported code-ref ID/,
  );
  const nonEnumerableInvalidBlock = {};
  Object.defineProperty(nonEnumerableInvalidBlock, "hidden", { value: 42 });
  assert.throws(
    () => renderCodeElementShadows("", { blocks: nonEnumerableInvalidBlock }),
    /must be a string/,
  );
  assert.throws(
    () => renderCodeElementShadows("", { blocks: {}, stylesheetHref: "" }),
    /nonempty string/,
  );
  assert.throws(
    () => renderCodeElementShadows("", { blocks: {}, stylesheetHref: "/code.css\nunsafe" }),
    /control characters/,
  );
  assert.throws(
    () => renderCodeElementShadows("", { blocks: {}, themeAliases: null }),
    /themeAliases/,
  );
  assert.throws(
    () => renderCodeElementShadows("", { blocks: {}, themeAliases: ["safe", "safe"] }),
    /Duplicate theme alias/,
  );
  for (const unsafeHref of [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/css,body{color:red}",
    "DATA:text/css,body{}",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.com/abc",
    "//evil.example/code.css",
    "/\\evil.example/code.css",
    "\\evil.example/code.css",
    " /code.css",
    "/code.css ",
    "   ",
    "http:evil.example/code.css",
    "https:/evil.example/code.css",
    "https://",
    "foo:bar/code.css",
  ]) {
    assert.throws(
      () => renderCodeElementShadows("", { blocks: {}, stylesheetHref: unsafeHref }),
      TypeError,
      `expected unsafe stylesheetHref to throw: ${JSON.stringify(unsafeHref)}`,
    );
  }
  for (const safeHref of [
    "/code.css",
    "./code.css",
    "../assets/code.css",
    "assets/code.css?a=1:2",
    "https://cdn.example.com/assets/code.css",
    "http://localhost:5173/code.css",
  ]) {
    assert.equal(
      renderCodeElementShadows("<main></main>", { blocks: {}, stylesheetHref: safeHref }),
      "<main></main>",
    );
  }
});

test("scanner matches HTML5 short comments, bogus comments, rawtext slash closes, and script double-escaped state", () => {
  const host = '<ferriki-code code-ref="ok"></ferriki-code>';
  const blocks = { ok: "<pre>ok</pre>" };
  const expectedShadow = `<ferriki-code code-ref="ok"><template shadowrootmode="open"><!--ferriki-code:ok--><style data-ferriki-code-base>${codeElementStyles()}</style><pre>ok</pre></template></ferriki-code>`;

  // Short HTML5 comments (`<!-->`, `<!--->`) and `--!>` close comments immediately.
  assert.equal(
    renderCodeElementShadows(`<!--><textarea>-->${host}</textarea>`, { blocks }),
    `<!--><textarea>-->${host}</textarea>`,
  );
  assert.equal(
    renderCodeElementShadows(`<!---><textarea>-->${host}</textarea>`, { blocks }),
    `<!---><textarea>-->${host}</textarea>`,
  );
  assert.equal(
    renderCodeElementShadows(`<!-- x --!><textarea>-->${host}</textarea>`, { blocks }),
    `<!-- x --!><textarea>-->${host}</textarea>`,
  );
  assert.equal(renderCodeElementShadows(`<!-->${host}`, { blocks }), `<!-->${expectedShadow}`);
  assert.equal(renderCodeElementShadows(`<!--->${host}`, { blocks }), `<!--->${expectedShadow}`);

  // Bogus comments (`<!foo>`, `<?foo>`, `</1...>`) end at the first `>`, ignoring quotes.
  for (const prefix of ['<!foo ">', '<?foo ">']) {
    const insideTextarea = `${prefix}<textarea>">${host}</textarea>`;
    assert.equal(renderCodeElementShadows(insideTextarea, { blocks }), insideTextarea);
    const afterBogus = `${prefix}${host}`;
    assert.equal(renderCodeElementShadows(afterBogus, { blocks }), `${prefix}${expectedShadow}`);
  }
  const insideEndBogus = `</1 ${host}>`;
  assert.equal(renderCodeElementShadows(insideEndBogus, { blocks }), insideEndBogus);

  // Raw text closing tags with `/` after the tag name (`</script/>`, `</style/>`, `</textarea/>`).
  assert.equal(
    renderCodeElementShadows(`<script>const x = 1;</script/>${host}`, { blocks }),
    `<script>const x = 1;</script/>${expectedShadow}`,
  );
  assert.equal(
    renderCodeElementShadows(`<style>a{}</style/>${host}`, { blocks }),
    `<style>a{}</style/>${expectedShadow}`,
  );
  assert.equal(
    renderCodeElementShadows(`<textarea>x</textarea/>${host}`, { blocks }),
    `<textarea>x</textarea/>${expectedShadow}`,
  );

  // Script data double-escaped state: `</script>` inside `<!-- <script>...</script> -->`
  // does NOT close the outer `<script>` element.
  const doubleEscaped = `<script><!-- <script></script>${host} --></script>`;
  assert.equal(renderCodeElementShadows(doubleEscaped, { blocks }), doubleEscaped);

  const doubleEscapedSlash = `<script><!-- <script/></script/>${host} --></script>`;
  assert.equal(renderCodeElementShadows(doubleEscapedSlash, { blocks }), doubleEscapedSlash);

  // Once the double-escaped outer `<script>` closes properly, a subsequent host IS hydrated.
  assert.equal(
    renderCodeElementShadows(`${doubleEscaped}${host}`, { blocks }),
    `${doubleEscaped}${expectedShadow}`,
  );

  // `<!-->` inside `<script>` immediately exits escaped state back to script data state,
  // so the following `</script>` closes `<script>`.
  assert.equal(
    renderCodeElementShadows(`<script><!--><script></script>${host}`, { blocks }),
    `<script><!--><script></script>${expectedShadow}`,
  );

  // Foreign-content CDATA sections (`<svg>`, `<math>`) stay opaque even when they
  // contain `>` before a literal `<ferriki-code>` example.
  const svgCdata = `<svg><![CDATA[a > b ${host}]]></svg>`;
  assert.equal(renderCodeElementShadows(svgCdata, { blocks }), svgCdata);
  assert.equal(
    renderCodeElementShadows(`${svgCdata}${host}`, { blocks }),
    `${svgCdata}${expectedShadow}`,
  );
  const mathCdata = `<math><![CDATA[x > y ${host}]]></math>`;
  assert.equal(renderCodeElementShadows(mathCdata, { blocks }), mathCdata);
  const unclosedSvgCdata = `<svg><![CDATA[a > b ${host}`;
  assert.equal(renderCodeElementShadows(unclosedSvgCdata, { blocks }), unclosedSvgCdata);

  // Outside foreign content, `<![CDATA[>` is an HTML bogus comment ending at the first `>`.
  const htmlBogusCdata = `<![CDATA[><textarea>]]>${host}</textarea>`;
  assert.equal(renderCodeElementShadows(htmlBogusCdata, { blocks }), htmlBogusCdata);

  // SVG `<script>` uses foreign-content XML/CDATA parsing, not HTML script double-escaped state.
  const svgScript = "<svg><script><![CDATA[<!-- <script>]]></script></svg>";
  assert.equal(
    renderCodeElementShadows(`${svgScript}${host}`, { blocks }),
    `${svgScript}${expectedShadow}`,
  );
  const hostInsideSvgScript = `<svg><script><![CDATA[<!-- <script>]]>${host}</script></svg>`;
  assert.equal(renderCodeElementShadows(hostInsideSvgScript, { blocks }), hostInsideSvgScript);

  // HTML integration points inside SVG/MathML (`foreignObject`, `desc`, `title`,
  // `annotation-xml[encoding="text/html"]`, `mtext`, etc.) re-enter HTML namespace
  // so raw-text/RCDATA elements like `<textarea>` and `<style>` stay opaque.
  const foreignTextarea = `<svg><foreignObject><textarea>${host}</textarea></foreignObject></svg>`;
  assert.equal(renderCodeElementShadows(foreignTextarea, { blocks }), foreignTextarea);
  const foreignRealHost = `<svg><foreignObject>${host}</foreignObject></svg>`;
  assert.equal(
    renderCodeElementShadows(foreignRealHost, { blocks }),
    `<svg><foreignObject>${expectedShadow}</foreignObject></svg>`,
  );
  const afterForeignCdata = `<svg><foreignObject><textarea></textarea></foreignObject><![CDATA[ > ${host} ]]></svg>`;
  assert.equal(renderCodeElementShadows(afterForeignCdata, { blocks }), afterForeignCdata);
  const mathAnnotationTextarea = `<math><annotation-xml encoding="text/html"><textarea>${host}</textarea></annotation-xml></math>`;
  assert.equal(
    renderCodeElementShadows(mathAnnotationTextarea, { blocks }),
    mathAnnotationTextarea,
  );
  const mathMtextStyle = `<math><mtext><style>${host}</style></mtext></math>`;
  assert.equal(renderCodeElementShadows(mathMtextStyle, { blocks }), mathMtextStyle);

  // CDATA remains opaque directly inside foreign HTML integration points (`<svg><title>`,
  // `<svg><foreignObject>`), because the current open element is still in the foreign namespace.
  const svgTitleCdata = `<svg><title><![CDATA[>${host}]]></title></svg>`;
  assert.equal(renderCodeElementShadows(svgTitleCdata, { blocks }), svgTitleCdata);
  const foreignObjectCdata = `<svg><foreignObject><![CDATA[>${host}]]></foreignObject></svg>`;
  assert.equal(renderCodeElementShadows(foreignObjectCdata, { blocks }), foreignObjectCdata);
  // Once an HTML child element opens inside an integration point, CDATA reverts to HTML bogus comment.
  const htmlChildCdata = `<svg><foreignObject><div><![CDATA[><textarea>]]>${host}</textarea></div></foreignObject></svg>`;
  assert.equal(renderCodeElementShadows(htmlChildCdata, { blocks }), htmlChildCdata);

  // MathML `annotation-xml` decodes HTML character references in `encoding` before matching.
  const entityEncodingHost = `<math><annotation-xml encoding="text&#47;html">${host}</annotation-xml></math>`;
  assert.equal(
    renderCodeElementShadows(entityEncodingHost, { blocks }),
    `<math><annotation-xml encoding="text&#47;html">${expectedShadow}</annotation-xml></math>`,
  );
  const entityEncodingTextarea = `<math><annotation-xml encoding="text&#x2f;html"><textarea>${host}</textarea></annotation-xml></math>`;
  assert.equal(
    renderCodeElementShadows(entityEncodingTextarea, { blocks }),
    entityEncodingTextarea,
  );
  const entityXhtmlHost = `<math><annotation-xml encoding="application&sol;xhtml&#43;xml">${host}</annotation-xml></math>`;
  assert.equal(
    renderCodeElementShadows(entityXhtmlHost, { blocks }),
    `<math><annotation-xml encoding="application&sol;xhtml&#43;xml">${expectedShadow}</annotation-xml></math>`,
  );
  // Uppercase `&#X...;` hex numeric reference is valid HTML5; uppercase `&SOL;` is NOT a valid named reference.
  const uppercaseHexHost = `<math><annotation-xml encoding="text&#X2F;html">${host}</annotation-xml></math>`;
  assert.equal(
    renderCodeElementShadows(uppercaseHexHost, { blocks }),
    `<math><annotation-xml encoding="text&#X2F;html">${expectedShadow}</annotation-xml></math>`,
  );
  const uppercaseNamedHost = `<math><annotation-xml encoding="text&SOL;html">${host}</annotation-xml></math>`;
  assert.equal(renderCodeElementShadows(uppercaseNamedHost, { blocks }), uppercaseNamedHost);

  // Unquoted attribute values ending in `/` do NOT make the tag self-closing in HTML5,
  // so `<foreignObject data-path=/docs/>` still opens an HTML integration point.
  const unquotedSlashForeignHost = `<svg><foreignObject data-path=/docs/>${host}</foreignObject></svg>`;
  assert.equal(
    renderCodeElementShadows(unquotedSlashForeignHost, { blocks }),
    `<svg><foreignObject data-path=/docs/>${expectedShadow}</foreignObject></svg>`,
  );
  const unquotedSlashForeignTextarea = `<svg><foreignObject data-path=/docs/><textarea>${host}</textarea></foreignObject></svg>`;
  assert.equal(
    renderCodeElementShadows(unquotedSlashForeignTextarea, { blocks }),
    unquotedSlashForeignTextarea,
  );
  // Quoted attribute values followed by `/>` ARE self-closing, keeping foreign namespace active.
  const quotedSelfClosingForeign = `<svg><foreignObject data-path="/docs/"/>${host}</svg>`;
  assert.equal(
    renderCodeElementShadows(quotedSelfClosingForeign, { blocks }),
    quotedSelfClosingForeign,
  );
  // Self-closing `<ferriki-code code-ref="known" />` remains skipped (not an empty paired host).
  const selfClosingHost = '<ferriki-code code-ref="known" />';
  assert.equal(renderCodeElementShadows(selfClosingHost, { blocks }), selfClosingHost);

  // HTML5 §13.2.6.5 foreign-content breakout tags (`div`, `p`, `<font color=...>`, etc.)
  // exit SVG/MathML back to HTML, so `<ferriki-code>` inside them is hydrated and raw-text
  // HTML elements like `<textarea>` stay opaque.
  assert.equal(
    renderCodeElementShadows(`<svg><div>${host}</div></svg>`, { blocks }),
    `<svg><div>${expectedShadow}</div></svg>`,
  );
  assert.equal(
    renderCodeElementShadows(`<svg><p>${host}</p></svg>`, { blocks }),
    `<svg><p>${expectedShadow}</p></svg>`,
  );
  assert.equal(
    renderCodeElementShadows(`<svg><font color="red">${host}</font></svg>`, { blocks }),
    `<svg><font color="red">${expectedShadow}</font></svg>`,
  );
  // Plain SVG `<font>` without `color`, `face`, or `size` does NOT break out of SVG.
  const svgFontHost = `<svg><font>${host}</font></svg>`;
  assert.equal(renderCodeElementShadows(svgFontHost, { blocks }), svgFontHost);
  const breakoutTextarea = `<svg><div><textarea>${host}</textarea></div></svg>`;
  assert.equal(renderCodeElementShadows(breakoutTextarea, { blocks }), breakoutTextarea);
  const nestedBreakoutWithOuterCdata = `<svg><foreignObject><svg><div>${host}</div></svg></foreignObject><![CDATA[>${host}]]></svg>`;
  assert.equal(
    renderCodeElementShadows(nestedBreakoutWithOuterCdata, { blocks }),
    `<svg><foreignObject><svg><div>${expectedShadow}</div></svg></foreignObject><![CDATA[>${host}]]></svg>`,
  );
  // Breakout inside `<svg><script>` pops the foreign `<script>` frame so `foreignScriptDepth` resets.
  assert.equal(
    renderCodeElementShadows(`<svg><script><div>${host}</div></script></svg>`, { blocks }),
    `<svg><script><div>${expectedShadow}</div></script></svg>`,
  );

  // MathML `mglyph` and `malignmark` inside MathML text integration points (`mi`, `mo`, `mn`,
  // `ms`, `mtext`) stay in the MathML namespace so CDATA inside them remains opaque.
  const mathMglyphCdata = `<math><mtext><mglyph><![CDATA[>${host}]]></mglyph></mtext></math>`;
  assert.equal(renderCodeElementShadows(mathMglyphCdata, { blocks }), mathMglyphCdata);
  const mathMalignmarkCdata = `<math><mtext><malignmark><![CDATA[>${host}]]></malignmark>${host}</mtext></math>`;
  assert.equal(
    renderCodeElementShadows(mathMalignmarkCdata, { blocks }),
    `<math><mtext><malignmark><![CDATA[>${host}]]></malignmark>${expectedShadow}</mtext></math>`,
  );
  assert.equal(
    renderCodeElementShadows(`<math><mtext><mglyph/>${host}</mtext></math>`, { blocks }),
    `<math><mtext><mglyph/>${expectedShadow}</mtext></math>`,
  );
  assert.equal(
    renderCodeElementShadows(`<math><mtext><div><mglyph>${host}</mglyph></div></mtext></math>`, {
      blocks,
    }),
    `<math><mtext><div><mglyph>${expectedShadow}</mglyph></div></mtext></math>`,
  );

  // Foreign `<template></template>` inside an HTML `<template>` does not close the outer
  // HTML `<template>` or decrement `templateDepth` prematurely.
  const foreignTemplateInsideHtmlTemplate = `<template><svg><template></template>${host}</svg>${host}</template>`;
  assert.equal(
    renderCodeElementShadows(foreignTemplateInsideHtmlTemplate, { blocks }),
    foreignTemplateInsideHtmlTemplate,
  );
  assert.equal(
    renderCodeElementShadows(`${foreignTemplateInsideHtmlTemplate}${host}`, { blocks }),
    `${foreignTemplateInsideHtmlTemplate}${expectedShadow}`,
  );

  // Nested `<svg>` inside MathML (outside an integration point) stays in MathML namespace,
  // and nested `<math>` inside SVG stays in SVG namespace (WHATWG HTML5 §13.2.6.5).
  assert.equal(
    renderCodeElementShadows(`<math><mrow><svg><mtext>${host}</mtext></svg></mrow></math>`, {
      blocks,
    }),
    `<math><mrow><svg><mtext>${expectedShadow}</mtext></svg></mrow></math>`,
  );
  const mathInsideSvg = `<svg><math><mtext>${host}</mtext></math></svg>`;
  assert.equal(renderCodeElementShadows(mathInsideSvg, { blocks }), mathInsideSvg);

  // A direct `<svg>` child of MathML `<annotation-xml>` (e.g. `encoding="image/svg+xml"`)
  // enters the SVG namespace so nested `<foreignObject>` becomes an HTML integration point.
  assert.equal(
    renderCodeElementShadows(
      `<math><annotation-xml encoding="image/svg+xml"><svg><foreignObject>${host}</foreignObject></svg></annotation-xml></math>`,
      { blocks },
    ),
    `<math><annotation-xml encoding="image/svg+xml"><svg><foreignObject>${expectedShadow}</foreignObject></svg></annotation-xml></math>`,
  );
  // A non-direct `<svg>` inside `<annotation-xml><mrow>` stays in MathML namespace.
  const nestedNonDirectSvg = `<math><annotation-xml encoding="image/svg+xml"><mrow><svg><foreignObject>${host}</foreignObject></svg></mrow></annotation-xml></math>`;
  assert.equal(renderCodeElementShadows(nestedNonDirectSvg, { blocks }), nestedNonDirectSvg);

  // Linear-time scanning even with thousands of unclosed HTML tags, raw-text elements, and
  // stray closing tags across an HTML integration point barrier.
  const unclosedListWithTextarea = `<svg><foreignObject>${"<li><textarea></textarea>".repeat(4000)}${"</svg>".repeat(4000)}${host}</foreignObject></svg>`;
  const started = performance.now();
  const linearOutput = renderCodeElementShadows(unclosedListWithTextarea, { blocks });
  const elapsedMs = performance.now() - started;
  assert.equal(
    linearOutput,
    `<svg><foreignObject>${"<li><textarea></textarea>".repeat(4000)}${"</svg>".repeat(4000)}${expectedShadow}</foreignObject></svg>`,
  );
  assert.ok(elapsedMs < 1000, `expected linear-time scan (<1000ms), got ${elapsedMs.toFixed(1)}ms`);

  // Foreign-content breakout end tags `</p>` and `</br>` exit SVG/MathML back to HTML.
  assert.equal(
    renderCodeElementShadows(`<svg></p>${host}</svg>`, { blocks }),
    `<svg></p>${expectedShadow}</svg>`,
  );
  assert.equal(
    renderCodeElementShadows(`<svg></br>${host}</svg>`, { blocks }),
    `<svg></br>${expectedShadow}</svg>`,
  );
  assert.equal(
    renderCodeElementShadows(`<math></p>${host}</math>`, { blocks }),
    `<math></p>${expectedShadow}</math>`,
  );
  assert.equal(
    renderCodeElementShadows(
      `<svg><foreignObject><svg></p>${host}</foreignObject><![CDATA[>${host}]]></svg>`,
      { blocks },
    ),
    `<svg><foreignObject><svg></p>${expectedShadow}</foreignObject><![CDATA[>${host}]]></svg>`,
  );

  // Nested foreign elements (e.g., nested `<mrow>`) are tracked on the namespace stack so
  // closing an inner `<mrow>` does not pop the outer `<mrow>` back to `<annotation-xml>`.
  assert.equal(
    renderCodeElementShadows(
      `<math><annotation-xml encoding="image/svg+xml"><mrow><mrow></mrow><svg><mtext>${host}</mtext></svg></mrow></annotation-xml></math>`,
      { blocks },
    ),
    `<math><annotation-xml encoding="image/svg+xml"><mrow><mrow></mrow><svg><mtext>${expectedShadow}</mtext></svg></mrow></annotation-xml></math>`,
  );

  // HTML `<template>` acts as a scope barrier in `popNamespaceTag` so a stray `</div>`
  // inside `<template>` under `<svg><foreignObject><div>` never pops `<template>`.
  const templateBarrier = `<svg><foreignObject><div><template></div>${host}</template></div></foreignObject></svg>`;
  assert.equal(renderCodeElementShadows(templateBarrier, { blocks }), templateBarrier);

  // Skipped `<ferriki-code>` hosts (non-empty, missing `code-ref`, or manual) still push
  // an HTML namespace frame inside foreign integration points so `<![CDATA[...` parses as
  // an HTML bogus comment rather than SVG CDATA.
  assert.equal(
    renderCodeElementShadows(
      `<svg><foreignObject><ferriki-code>nonempty<![CDATA[>${host}]]></ferriki-code></foreignObject></svg>`,
      { blocks },
    ),
    `<svg><foreignObject><ferriki-code>nonempty<![CDATA[>${expectedShadow}]]></ferriki-code></foreignObject></svg>`,
  );

  // Non-void HTML elements with a trailing slash (e.g. `<div/>`) stay open at foreign HTML
  // integration points, switching to HTML namespace so `<![CDATA[>` ends at the first `>`.
  assert.equal(
    renderCodeElementShadows(
      `<svg><foreignObject><div/><![CDATA[>${host}]]>${host}</foreignObject></svg>`,
      { blocks },
    ),
    `<svg><foreignObject><div/><![CDATA[>${expectedShadow}]]>${expectedShadow}</foreignObject></svg>`,
  );

  // Self-closing `<svg/>` and `<math/>` leave the parent namespace intact (do not push an
  // HTML frame), so following `<![CDATA[...` inside `<svg><foreignObject>` stays SVG CDATA.
  for (const selfClosingForeign of ["<svg/>", "<math/>"]) {
    assert.equal(
      renderCodeElementShadows(
        `<svg><foreignObject>${selfClosingForeign}<![CDATA[><ferriki-code code-ref="missing"></ferriki-code>]]>${host}</foreignObject></svg>`,
        { blocks },
      ),
      `<svg><foreignObject>${selfClosingForeign}<![CDATA[><ferriki-code code-ref="missing"></ferriki-code>]]>${expectedShadow}</foreignObject></svg>`,
    );
  }

  // `<noscript>` stays opaque raw text by default (HTML5 scripting-enabled mode), while
  // opt-in `includeNoscript: true` hydrates eligible hosts inside `<noscript>` fallbacks
  // without hydrating inert `<template>` / `<script>` content nested inside `<noscript>`.
  const noscriptMarkup = `<noscript>${host}<template>${host}</template><script>${host}</script></noscript>`;
  assert.equal(renderCodeElementShadows(noscriptMarkup, { blocks }), noscriptMarkup);
  assert.equal(
    renderCodeElementShadows(noscriptMarkup, { blocks, includeNoscript: false }),
    noscriptMarkup,
  );
  assert.equal(
    renderCodeElementShadows(noscriptMarkup, { blocks, includeNoscript: true }),
    `<noscript>${expectedShadow}<template>${host}</template><script>${host}</script></noscript>`,
  );
  assert.throws(
    () => renderCodeElementShadows(noscriptMarkup, { blocks, includeNoscript: "yes" }),
    TypeError,
  );

  // Stateful getters on `options.stylesheetHref` (and `options.blocks`) are read once during
  // validation and emitted from the validated snapshot so TOCTOU mutation cannot smuggle URLs.
  let hrefReads = 0;
  const statefulOptions = {
    blocks,
    get stylesheetHref() {
      return ++hrefReads === 1 ? "/assets/ferriki.css" : "javascript:alert(1)";
    },
  };
  const statefulOut = renderCodeElementShadows(`${host}${host}`, statefulOptions);
  assert.equal(hrefReads, 1);
  assert.equal(statefulOut.includes("/assets/ferriki.css"), true);
  assert.equal(statefulOut.includes("javascript:"), false);
});

test("fast path skips full scanning when no <ferriki-code tag exists while keeping validation and case-insensitive matching", () => {
  const largeHtml = `<main>${"<section><p>Ordinary server-rendered HTML</p></section>".repeat(2000)}</main>`;
  assert.equal(renderCodeElementShadows(largeHtml, { blocks: {} }), largeHtml);

  // Validation still runs before the fast path returns.
  assert.throws(
    () => renderCodeElementShadows("<main>no hosts</main>", { blocks: { "bad key": "<pre />" } }),
    /Unsupported code-ref ID/,
  );
  assert.throws(
    () =>
      renderCodeElementShadows("<main>no hosts</main>", {
        blocks: {},
        stylesheetHref: "javascript:alert(1)",
      }),
    TypeError,
  );
  assert.throws(
    () => renderCodeElementShadows("<main>no hosts</main>", { blocks: {}, themeAliases: null }),
    /themeAliases/,
  );

  // Case-insensitive `<FERRIKI-CODE>` still enters the scanner and hydrates cleanly.
  const upperHost = '<main><FERRIKI-CODE code-ref="upper"></FERRIKI-CODE></main>';
  assert.equal(
    renderCodeElementShadows(upperHost, { blocks: { upper: "<pre>UPPER</pre>" } }),
    `<main><FERRIKI-CODE code-ref="upper"><template shadowrootmode="open"><!--ferriki-code:upper--><style data-ferriki-code-base>${codeElementStyles()}</style><pre>UPPER</pre></template></FERRIKI-CODE></main>`,
  );
});
