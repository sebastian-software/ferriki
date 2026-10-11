import assert from "node:assert/strict";
import test from "node:test";

import { renderCodeElementShadows } from "../ferriki/web-component-server.mjs";

test("reference hosts receive the exact DSD protocol and escaped shared stylesheet URL", () => {
  const markup = '<main><ferriki-code class="sample" code-ref="Block-1"></ferriki-code></main>';
  const result = renderCodeElementShadows(markup, {
    blocks: { "Block-1": "<pre><code>const x = 1;</code></pre>" },
    stylesheetHref: '/assets/code.css?theme="light"&v=1',
  });

  assert.equal(
    result,
    '<main><ferriki-code class="sample" code-ref="Block-1"><template shadowrootmode="open"><!--ferriki-code:Block%2D1--><link rel="stylesheet" href="/assets/code.css?theme=&quot;light&quot;&amp;v=1" data-ferriki-code-css><pre><code>const x = 1;</code></pre></template></ferriki-code></main>',
  );
});

test("whitespace-only hosts are eligible and the stylesheet link is optional", () => {
  const markup = '<ferriki-code code-ref="one">\n \t</ferriki-code>';
  assert.equal(
    renderCodeElementShadows(markup, { blocks: { one: "<pre>one</pre>" } }),
    '<ferriki-code code-ref="one"><template shadowrootmode="open"><!--ferriki-code:one--><pre>one</pre></template></ferriki-code>',
  );
});

test("leading hyphens are valid code-ref characters and are encoded in the marker", () => {
  assert.equal(
    renderCodeElementShadows('<ferriki-code code-ref="-leading"></ferriki-code>', {
      blocks: { "-leading": "<pre>ok</pre>" },
    }),
    '<ferriki-code code-ref="-leading"><template shadowrootmode="open"><!--ferriki-code:%2Dleading--><pre>ok</pre></template></ferriki-code>',
  );
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
    `${untouched}<ferriki-code data-label="a > b" code-ref="present"><template shadowrootmode="open"><!--ferriki-code:present--><pre>ok</pre></template></ferriki-code>`,
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

test("inputs validate the complete block registry and stylesheet URL", () => {
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
});
