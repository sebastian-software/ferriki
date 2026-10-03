import assert from "node:assert/strict";
import test from "node:test";
import { compareHighlightedHtml } from "./phiki-html-agreement.mjs";

test("compares visible text and per-character styles across token wrappers", () => {
  const expected =
    '<pre style="background-color:#fff;color:#111"><code><span class="line"><span style="color:#ABC;font-weight:bold">A</span><span style="color:#111">é</span></span>\n<span class="line"><span style="color:#111">b</span></span></code></pre>';
  const actual =
    '<pre class="phiki" style="color:#111"><code><span class="line"><span class="token" style="font-weight:700;color:#aabbcc">A</span><span class="token">é\n</span></span><span class="line"><span class="token">b</span></span></code></pre>';

  assert.deepEqual(compareHighlightedHtml(expected, actual, "Aé\nb"), {
    agrees: true,
    textAgrees: true,
    stylesAgree: true,
    removedFinalNewlineSentinel: false,
  });
});

test("removes exactly one artificial final TextMate newline before style comparison", () => {
  const expected =
    '<pre style="color:#111"><code><span class="line"><span style="color:#111">x</span></span></code></pre>';
  const actual =
    '<pre style="color:#111"><code><span class="line"><span style="color:#111">x\n</span></span></code></pre>';

  assert.deepEqual(compareHighlightedHtml(expected, actual, "x"), {
    agrees: true,
    textAgrees: true,
    stylesAgree: true,
    removedFinalNewlineSentinel: true,
  });
});

test("reports the first foreground or font-style mismatch", () => {
  const expected =
    '<pre style="color:#111"><code><span class="line"><span style="color:#abc;font-style:italic">x</span></span></code></pre>';
  const actual =
    '<pre style="color:#111"><code><span class="line"><span style="color:#def;font-style:italic">x</span></span></code></pre>';

  const result = compareHighlightedHtml(expected, actual, "x");
  assert.equal(result.agrees, false);
  assert.equal(result.difference.kind, "style");
  assert.equal(result.difference.characterIndex, 0);
  assert.equal(result.difference.expected.color, "#aabbcc");
  assert.equal(result.difference.actual.color, "#ddeeff");
});

test("normalizes explicit font defaults against inherited defaults", () => {
  const expected =
    '<pre style="color:#111"><code><span class="line"><span style="color:#111;font-style:normal;font-weight:normal;text-decoration:none">x</span></span></code></pre>';
  const actual = '<pre style="color:#111"><code><span class="line">x</span></code></pre>';

  assert.equal(compareHighlightedHtml(expected, actual, "x").agrees, true);
});

test("normalizes CRLF source and reports visible text differences", () => {
  const expected =
    '<pre style="color:#111"><code><span class="line"><span style="color:#111">a</span></span>\n<span class="line"><span style="color:#111">b</span></span></code></pre>';
  const actual =
    '<pre style="color:#111"><code><span class="line"><span style="color:#111">a\r\nb</span></span></code></pre>';

  assert.equal(compareHighlightedHtml(expected, actual, "a\r\nb").agrees, true);

  const different = actual.replace("b</span>", "c</span>");
  const result = compareHighlightedHtml(expected, different, "a\r\nb");
  assert.equal(result.agrees, false);
  assert.equal(result.difference.kind, "text");
  assert.equal(result.difference.characterIndex, 2);
});

test("rejects a reference renderer that does not reproduce the source", () => {
  const wrongReference =
    '<pre style="color:#111"><code><span class="line"><span style="color:#111">wrong</span></span></code></pre>';
  const actual =
    '<pre style="color:#111"><code><span class="line"><span style="color:#111">right</span></span></code></pre>';

  const result = compareHighlightedHtml(wrongReference, actual, "right");
  assert.equal(result.agrees, false);
  assert.equal(result.difference.renderer, "reference");
  assert.equal(result.difference.characterIndex, 0);
});

test("preserves visible text outside line wrappers", () => {
  const unexpected = '<pre><code><span class="line">x</span>visible</code></pre>';
  const result = compareHighlightedHtml(unexpected, unexpected, "x");
  assert.equal(result.agrees, false);
  assert.equal(result.difference.kind, "text");
});

test("preserves extra visible newlines between line wrappers", () => {
  const expected =
    '<pre style="color:#111"><code><span class="line">a</span>\n\n<span class="line">b</span></code></pre>';
  const actual =
    '<pre style="color:#111"><code><span class="line">a</span>\n<span class="line">b</span></code></pre>';

  const result = compareHighlightedHtml(expected, actual, "a\nb");
  assert.equal(result.agrees, false);
  assert.equal(result.textAgrees, false);
  assert.deepEqual(result.difference, {
    kind: "text",
    characterIndex: 2,
    expected: "b",
    actual: "\n",
    renderer: "reference",
  });
});
