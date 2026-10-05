// Loops native token calls over whole corpora for an external sampler such as
// samply (#225). The first round compiles grammars; later rounds are steady
// state. Pass any built addon, including a symbolized profiling build.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadFerrikiNativeBinding } from "../ferriki/native.mjs";
import { TEST_ASSET_CACHE_DIR } from "./test-asset-env.mjs";
import { loadCases, loadCorpus } from "./tiobe-benchmark.mjs";

const { values } = parseArgs({
  options: {
    addon: { type: "string" },
    mode: { type: "string", default: "single" },
    sizes: { type: "string", default: "example,large" },
    corpora: { type: "string", default: "tiobe,curated" },
    seconds: { type: "string", default: "20" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/profile-token-workload.mjs [--addon path.node] [--mode single|multi|html] [--sizes example,large] [--corpora tiobe,curated] [--seconds 20]",
  );
  process.exit(0);
}
assert.ok(["single", "multi", "html"].includes(values.mode), "Invalid --mode");
const native = values.addon
  ? createRequire(import.meta.url)(values.addon)
  : loadFerrikiNativeBinding();
const highlighter = native.createHighlighter({
  standardAssetRoot: fileURLToPath(new URL("../ferriki/assets/shiki", import.meta.url)),
  assets: { remote: false, cacheDir: TEST_ASSET_CACHE_DIR },
});
highlighter.loadStandardTheme("github-dark");
highlighter.loadStandardTheme("github-light");
const work = [];
for (const corpus of values.corpora.split(","))
  for (const language of loadCorpus(corpus).languages.filter((entry) => entry.file)) {
    highlighter.loadStandardGrammar(language.textmate);
    for (const { code } of loadCases(language, values.sizes.split(","), corpus)) {
      const options = {
        lang: language.textmate,
        theme: "github-dark",
        tokenizeTimeLimit: 500,
        ...(values.mode === "multi"
          ? {
              themeEntries: [
                { color: "dark", name: "github-dark" },
                { color: "light", name: "github-light" },
              ],
            }
          : {}),
      };
      work.push(
        {
          single: () => highlighter.getHtmlRenderData(code, options),
          multi: () => highlighter.getHtmlRenderDataWithThemes(code, options),
          html: () => highlighter.codeToHtml(code, options),
        }[values.mode],
      );
    }
  }
for (const run of work) run();
// Samples before this wall-clock mark include grammar compilation.
console.error(`[workload] steady state from ${Date.now()} (epoch ms), pid=${process.pid}`);
const end = performance.now() + Number(values.seconds) * 1000;
let rounds = 0;
while (performance.now() < end) {
  for (const run of work) run();
  rounds++;
}
console.error(`[workload] ${rounds} rounds of ${work.length} calls`);
highlighter.dispose();
