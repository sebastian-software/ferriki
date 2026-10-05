// Measures the private token boundary on both complete corpora. Works with
// the JSON and typed bindings so the same workload can measure both revisions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadFerrikiNativeBinding } from "../ferriki/native.mjs";
import { TEST_ASSET_CACHE_DIR } from "./test-asset-env.mjs";
import { loadCases, loadCorpus, sha256, statistics } from "./tiobe-benchmark.mjs";

const native = loadFerrikiNativeBinding();
const typed = process.argv.includes("--typed");
const encode = (value) => (typed ? value : JSON.stringify(value));
const decode = (value) => (typed ? value : JSON.parse(value));
const highlighter = native.createHighlighter(
  encode({
    standardAssetRoot: fileURLToPath(new URL("../ferriki/assets/shiki", import.meta.url)),
    assets: { remote: false, cacheDir: TEST_ASSET_CACHE_DIR },
  }),
);
const cases = [];
try {
  for (const corpus of ["tiobe", "curated"]) {
    for (const language of loadCorpus(corpus).languages.filter((entry) => entry.file)) {
      highlighter.loadStandardGrammar(language.textmate);
      highlighter.loadStandardTheme("github-dark");
      highlighter.loadStandardTheme("github-light");
      for (const entry of loadCases(language, ["example", "large"], corpus)) {
        for (const multi of [false, true]) {
          const options = encode({
            lang: language.textmate,
            theme: "github-dark",
            tokenizeTimeLimit: 500,
            ...(multi
              ? {
                  themeEntries: [
                    { color: "dark", name: "github-dark" },
                    { color: "light", name: "github-light" },
                  ],
                }
              : {}),
          });
          const invoke = () =>
            decode(
              multi
                ? highlighter.getHtmlRenderDataWithThemes(entry.code, options)
                : highlighter.getHtmlRenderData(entry.code, options),
            );
          const result = invoke();
          assert.equal(typeof result, "object");
          assert.equal(
            result.tokens
              .flat()
              .map((token) => token.content)
              .join(""),
            entry.code.replace(/\r?\n/g, ""),
          );
          for (let i = 0; i < 5; i++) invoke();
          const samples = [];
          for (let i = 0; i < 10; i++) {
            const started = performance.now();
            invoke();
            samples.push(performance.now() - started);
          }
          console.error(
            `${corpus}/${language.textmate}/${entry.size}/${multi ? "multi" : "single"}`,
          );
          cases.push({
            corpus,
            language: language.textmate,
            size: entry.size,
            multi,
            outputSha256: sha256(JSON.stringify(result)),
            ...statistics(samples, entry.bytes),
          });
        }
      }
    }
  }
} finally {
  highlighter.dispose();
}
const addon = fileURLToPath(new URL("../ferriki/ferriki.node", import.meta.url));
const coldRequireMs = [];
for (let i = 0; i < 30; i++) {
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "const t=performance.now();require(process.argv[1]);console.log(performance.now()-t)",
      addon,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  coldRequireMs.push(Number(child.stdout));
}
const require = createRequire(import.meta.url);
const report = {
  typed,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  addonBytes: statSync(require.resolve(addon)).size,
  coldRequire: statistics(coldRequireMs, 0),
  cases,
};
const writeIndex = process.argv.indexOf("--write");
if (writeIndex !== -1)
  writeFileSync(process.argv[writeIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, cases: `${cases.length} measured cases` }, null, 2));
