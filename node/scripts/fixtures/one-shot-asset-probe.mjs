import assert from "node:assert/strict";
import process from "node:process";

import {
  codeToHtml,
  codeToHtmlWithCss,
  createHighlighter,
  FerrikiError,
  getSingletonHighlighter,
} from "../../ferriki/index.mjs";

const scenario = process.argv[2];

function isAssetError(error) {
  assert(error instanceof FerrikiError);
  assert.equal(error.code, "ERR_ASSET");
  return true;
}

async function checkCss(code, options) {
  const cold = await codeToHtmlWithCss(code, options);
  assert.match(cold.html, /<span/);
  assert.match(cold.css, /:where\(\.ferriki-style-/);
  assert.deepEqual(await codeToHtmlWithCss(code, options), cold);

  const highlighter = await createHighlighter({
    langs: [options.lang],
    themes: options.theme ? [options.theme] : Object.values(options.themes),
  });
  try {
    assert.deepEqual(highlighter.codeToHtmlWithCss(code, options), cold);
    assert.deepEqual(codeToHtmlWithCss(highlighter, code, options), cold);
  } finally {
    highlighter.dispose();
  }
}

switch (scenario) {
  case "css-single":
    await checkCss('{"x":1}', { lang: "json", theme: "nord" });
    break;
  case "css-multi-embedded":
    await checkCss("<script setup lang='ts'>const answer: number = 42</script>", {
      lang: "vue",
      themes: { light: "vitesse-light", dark: "nord" },
    });
    break;
  case "css-offline":
  case "css-integrity":
    await assert.rejects(
      codeToHtmlWithCss('{"x":1}', { lang: "json", theme: "nord" }),
      isAssetError,
    );
    break;
  case "singleton-retry": {
    const originalFetch = globalThis.fetch;
    let failedFetches = 0;
    globalThis.fetch = async () => {
      failedFetches++;
      throw new Error("controlled first-download failure");
    };
    const attempts = await Promise.allSettled([
      codeToHtml('{"x":1}', { lang: "json", theme: "nord" }),
      codeToHtmlWithCss('{"x":1}', { lang: "json", theme: "nord" }),
    ]);
    globalThis.fetch = originalFetch;
    assert.equal(failedFetches, 1, "concurrent first calls share one failed download attempt");
    assert(attempts.every((attempt) => attempt.status === "rejected"));
    assert.strictEqual(attempts[0].reason, attempts[1].reason);
    isAssetError(attempts[0].reason);

    const marker = {
      pre(node) {
        node.properties["data-singleton-default"] = "yes";
      },
    };
    const highlighter = await getSingletonHighlighter({
      langs: ["json"],
      themes: ["nord"],
      transformers: [marker],
    });
    assert.strictEqual(await getSingletonHighlighter(), highlighter);
    assert.match(
      await codeToHtml('{"x":1}', { lang: "json", theme: "nord" }),
      /data-singleton-default="yes"/,
    );
    assert.match(
      (await codeToHtmlWithCss('{"x":1}', { lang: "json", theme: "nord" })).html,
      /data-singleton-default="yes"/,
    );

    await assert.rejects(
      getSingletonHighlighter({
        langs: [{ name: "broken", scopeName: "source.broken", patterns: "invalid" }],
      }),
      { code: "ERR_USAGE" },
    );
    assert.strictEqual(await getSingletonHighlighter(), highlighter);
    assert.match(
      await codeToHtml('{"x":1}', { lang: "json", theme: "nord" }),
      /data-singleton-default="yes"/,
    );
    break;
  }
  default:
    throw new Error(`Unknown one-shot asset probe: ${scenario}`);
}

console.log(`One-shot asset probe passed: ${scenario}`);
