import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const addonDir = process.env.FERRIKI_BENCH_ADDON_DIR;
assert.ok(addonDir, "Set FERRIKI_BENCH_ADDON_DIR to the directory containing the saved addons");
const engines = (process.env.FERRIKI_BENCH_ENGINES ?? "2.1.0,2.2.1").split(",");
const languages = (
  process.env.FERRIKI_BENCH_LANGUAGES ?? "typescript,cpp,scss,rust,html,json,astro"
).split(",");
const rounds = Number(process.env.FERRIKI_BENCH_ROUNDS ?? 6);
const sizes = ["example", "large"];

if (process.argv[2] === "worker") {
  const [engine, lang, size] = process.argv.slice(3);
  const manifest = JSON.parse(readFileSync(`${root}/node/benchmarks/curated/manifest.json`));
  const entry = manifest.languages.find((language) => language.textmate === lang);
  const fixture = readFileSync(`${root}/node/benchmarks/curated/fixtures/${entry.file}`, "utf8");
  const code = fixture.repeat(size === "large" ? 16 : 1);
  // Process startup and fixture I/O are outside the timer. Addon loading,
  // local theme/grammar setup, and the first complete render are inside it.
  const start = performance.now();
  const version = engine;
  const native = createRequire(import.meta.url)(`${addonDir}/ferroni-${version}.node`);
  const loaded = performance.now();
  const highlighter = native.createHighlighter({
    standardAssetRoot: `${root}/node/ferriki/assets/standard`,
    assets: { remote: false, cacheDir: `${root}/node/.cache/ferriki-assets` },
  });
  highlighter.loadStandardTheme("github-dark");
  highlighter.loadStandardGrammar(lang);
  const setup = performance.now();
  const html = highlighter.codeToHtml(code, { lang, theme: "github-dark", tokenizeTimeLimit: 500 });
  const end = performance.now();
  highlighter.dispose();
  process.stdout.write(
    `${JSON.stringify({
      loadMs: loaded - start,
      setupMs: setup - loaded,
      firstHtmlMs: end - setup,
      totalMs: end - start,
      bytes: Buffer.byteLength(html),
      outputSha256: createHash("sha256").update(html).digest("hex"),
    })}\n`,
  );
} else {
  const samples = [];
  for (let run = 0; run < rounds; run++) {
    for (const lang of languages) {
      for (const size of sizes) {
        const hashes = [];
        for (let index = 0; index < engines.length; index++) {
          const engine = engines[(run + index) % engines.length];
          const result = spawnSync(
            process.execPath,
            [import.meta.filename, "worker", engine, lang, size],
            { encoding: "utf8" },
          );
          assert.equal(result.status, 0, result.stderr);
          const sample = JSON.parse(result.stdout);
          hashes.push(sample.outputSha256);
          samples.push({ run, lang, size, engine, ...sample });
        }
        for (const hash of hashes) assert.equal(hash, hashes[0], "Engine outputs differ");
      }
    }
    console.error(`[cold] round ${run + 1}/${rounds} done`);
  }
  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    engines,
    languages,
    rounds,
    samples,
  };
  writeFileSync(
    new URL(process.env.FERRIKI_BENCH_OUTPUT ?? "./cold.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
