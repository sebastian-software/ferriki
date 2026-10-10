import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const addonDir = process.env.FERRIKI_BENCH_ADDON_DIR;
if (!addonDir)
  throw new Error("Set FERRIKI_BENCH_ADDON_DIR to the directory containing both saved addons");
const versions = ["1.8.0", "2.0.0"];
const languages = ["typescript", "cpp", "scss", "rust", "html"];
if (process.argv[2] === "worker") {
  const [version, lang] = process.argv.slice(3);
  const manifest = JSON.parse(readFileSync(`${root}/node/benchmarks/curated/manifest.json`));
  const entry = manifest.languages.find((x) => x.textmate === lang);
  const code = readFileSync(`${root}/node/benchmarks/curated/fixtures/${entry.file}`, "utf8");
  const start = performance.now();
  const native = createRequire(import.meta.url)(`${addonDir}/ferroni-${version}.node`);
  const loaded = performance.now();
  const h = native.createHighlighter({
    standardAssetRoot: `${root}/node/ferriki/assets/shiki`,
    assets: { remote: false, cacheDir: `${root}/node/.cache/ferriki-assets` },
  });
  h.loadStandardTheme("github-dark");
  h.loadStandardGrammar(lang);
  const setup = performance.now();
  const html = h.codeToHtml(code, { lang, theme: "github-dark", tokenizeTimeLimit: 500 });
  const end = performance.now();
  h.dispose();
  process.stdout.write(
    `${JSON.stringify({
      loadMs: loaded - start,
      setupMs: setup - loaded,
      firstHtmlMs: end - setup,
      totalMs: end - start,
      bytes: html.length,
    })}\n`,
  );
} else {
  const samples = [];
  for (let run = 0; run < 10; run++)
    for (const lang of languages)
      for (let k = 0; k < 2; k++) {
        const version = versions[(run + k) % 2];
        const result = spawnSync(
          process.execPath,
          [import.meta.filename, "worker", version, lang],
          { encoding: "utf8" },
        );
        if (result.status !== 0) throw new Error(result.stderr);
        samples.push({ run, lang, version, ...JSON.parse(result.stdout) });
      }
  const report = { measuredAt: new Date().toISOString(), node: process.version, samples };
  writeFileSync(new URL("./cold.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  for (const lang of languages) {
    const row = { lang };
    for (const version of versions) {
      const x = samples
        .filter((s) => s.lang === lang && s.version === version)
        .map((s) => s.totalMs)
        .sort((a, b) => a - b);
      row[version] = (x[4] + x[5]) / 2;
    }
    process.stdout.write(`${JSON.stringify(row)}\n`);
  }
}
