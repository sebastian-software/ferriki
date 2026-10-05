import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { loadFerrikiNativeBinding } from "../ferriki/native.mjs";
import { TEST_ASSET_CACHE_DIR } from "./test-asset-env.mjs";

const binding = loadFerrikiNativeBinding();
const highlighter = binding.createHighlighter({
  standardAssetRoot: fileURLToPath(new URL("../ferriki/assets/shiki", import.meta.url)),
  assets: { remote: false, cacheDir: TEST_ASSET_CACHE_DIR },
});
try {
  assert(highlighter.loadStandardGrammar("javascript"));
  assert(highlighter.loadStandardTheme("nord"));
  assert(highlighter.loadStandardTheme("github-light"));
  const code = "// 😀\r\nconst x = 1\n";
  const options = { lang: "javascript", theme: "nord", includeExplanation: "tokenType" };
  const single = highlighter.getHtmlRenderData(code, options);
  assert.equal(typeof single, "object");
  assert.equal(single.themeName, "nord");
  assert.equal(single.tokens[1][0].offset, 7, "offsets stay UTF-16 with CRLF");
  assert.equal(single.tokens[0][0].type, 1, "comment type stays numeric");
  assert.equal(typeof single.tokens[0][0].fontStyle, "number");
  assert(!Object.hasOwn(single.tokens[0][0], "scopeNames"));
  assert.deepEqual(single.tokens.at(-1), []);
  // Keys keep the former JSON order; the writer reuses internalized names.
  assert.deepEqual(Object.keys(single.tokens[1][0]), [
    "content",
    "offset",
    "color",
    "fontStyle",
    "type",
  ]);
  assert.deepEqual(Object.keys(single), ["tokens", "fg", "bg", "themeName"]);
  // ASCII takes the Latin-1 fast path; any other text must still decode as UTF-8.
  const text = highlighter.getHtmlRenderData("const café = 'ü€😀'", options);
  assert.equal(text.tokens[0].map((token) => token.content).join(""), "const café = 'ü€😀'");
  const colors = text.tokens[0].map((token) => token.color);
  assert(colors.every((color) => typeof color === "string" && color.startsWith("#")));
  const plain = highlighter.getHtmlRenderData("😀", {
    ...options,
    lang: "text",
    includeExplanation: false,
  });
  assert(!Object.hasOwn(plain.tokens[0][0], "color"));
  assert(!Object.hasOwn(plain.tokens[0][0], "fontStyle"));
  assert(!Object.hasOwn(plain.tokens[0][0], "type"));
  const scopes = highlighter.getHtmlRenderData("console.log(1)", {
    ...options,
    includeExplanation: true,
  });
  assert(Array.isArray(scopes.tokens[0][0].scopeNames));
  const multi = highlighter.getHtmlRenderDataWithThemes(code, {
    ...options,
    themeEntries: [
      { color: "dark", name: "nord" },
      { color: "light", name: "github-light" },
    ],
  });
  assert.equal(typeof multi, "object");
  assert.deepEqual(
    multi.themes.map(({ color }) => color),
    ["dark", "light"],
  );
  assert.equal(multi.tokens[1][0].offset, 7);
  assert.equal(typeof multi.tokens[0][0].variants.dark.fontStyle, "number");
  assert.equal(multi.tokens[0][0].type, 1);
  assert(!Object.hasOwn(multi.tokens[0][0], "scopeNames"));
  const unusualKeys = ["__proto__", "constructor", "toString", "nul\0key", "dünkel"];
  const unusual = highlighter.getHtmlRenderDataWithThemes("let x = 1", {
    ...options,
    themeEntries: unusualKeys.map((color) => ({ color, name: "nord" })),
  });
  const variants = unusual.tokens[0][0].variants;
  assert.equal(Object.getPrototypeOf(variants), Object.prototype);
  for (const key of unusualKeys) {
    assert(
      Object.hasOwn(variants, key),
      `variant key ${JSON.stringify(key)} stays an own property`,
    );
    assert.equal(typeof variants[key].color, "string");
    const property = Object.getOwnPropertyDescriptor(variants, key);
    assert(property.enumerable && property.writable && property.configurable);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(variants)), variants);
  assert.throws(() => highlighter.getHtmlRenderDataWithThemes(code, options), /themeEntries/);
  assert.throws(() => highlighter.getHtmlRenderData(code, { theme: "nord" }), /lang/);
  const html = highlighter.codeToHtml(code, { ...options, rootStyle: false, tabindex: false });
  assert(!html.includes("tabindex="));
  assert(!html.includes("background-color:"));
  assert(highlighter.codeToHtml(code, { ...options, tabindex: "-1" }).includes('tabindex="-1"'));
  assert.deepEqual(await highlighter.planAssets(["javascript"], ["nord"]), []);
} finally {
  highlighter.dispose();
}
const bare = binding.createHighlighter({});
try {
  assert.deepEqual(await bare.planAssets([], []), []);
} finally {
  bare.dispose();
}
// Each environment caches its own property keys and releases them on exit.
const workerSource = `
  const { workerData, parentPort } = require("node:worker_threads");
  import(workerData.loader).then(({ loadFerrikiNativeBinding }) => {
    const h = loadFerrikiNativeBinding().createHighlighter(workerData.options);
    h.loadStandardGrammar("javascript");
    h.loadStandardTheme("nord");
    const result = h.getHtmlRenderData("const x = 1", { lang: "javascript", theme: "nord" });
    parentPort.postMessage(Object.keys(result.tokens[0][0]));
  });
`;
const loader = new URL("../ferriki/native.mjs", import.meta.url).href;
for (let round = 0; round < 3; round++) {
  const keys = await Promise.all(
    [0, 1].map(
      () =>
        new Promise((resolve, reject) => {
          const worker = new Worker(workerSource, {
            eval: true,
            workerData: {
              loader,
              options: {
                standardAssetRoot: fileURLToPath(
                  new URL("../ferriki/assets/shiki", import.meta.url),
                ),
                assets: { remote: false, cacheDir: TEST_ASSET_CACHE_DIR },
              },
            },
          });
          worker.once("message", (message) => worker.terminate().then(() => resolve(message)));
          worker.once("error", reject);
        }),
    ),
  );
  for (const names of keys) assert.deepEqual(names, ["content", "offset", "color", "fontStyle"]);
}
console.log("Typed native options, results, optional fields and UTF-16 offsets verified");
