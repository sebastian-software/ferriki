import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import * as shiki from "shiki";
import { resolveFerrikiPlatformTarget } from "../ferriki/platforms.mjs";
import { createHighlighter } from "../ferriki/index.mjs";
import { loadCorpus, loadCases, repoRoot, sha256, statistics, theme } from "./tiobe-benchmark.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const nodeRoot = dirname(dirname(scriptPath));
const curated = loadCorpus("curated");
const selectedNames = new Set(["cpp", "typescript", "tsx", "json", "html", "astro"]);
const sizes = ["example", "large"];
const minRounds = 30;
const maxRounds = 1000;
const budgetMsPerMode = 100;
const warmup = 5;
const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const require = createRequire(new URL("../ferriki/native.mjs", import.meta.url));
const outputPath = process.argv[2]
  ? join(repoRoot, process.argv[2])
  : join(nodeRoot, "benchmarks/curated/results/prism-investigation/output-modes.json");

function nativeIdentity() {
  const target = resolveFerrikiPlatformTarget();
  assert.ok(target, "No supported native platform");
  const receiptPath = join(nodeRoot, "ferriki/.benchmark-build.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const candidates = [
    `${target.packageName}/ferriki.node`,
    join(nodeRoot, "ferriki/dist", target.binaryName),
    join(nodeRoot, "ferriki/dist/ferriki.node"),
    join(nodeRoot, "ferriki/ferriki.node"),
  ];
  let loadedAddon;
  for (const candidate of candidates) {
    try {
      loadedAddon = require.resolve(candidate);
      require(loadedAddon);
      break;
    } catch {
      // Follow the same candidate order as the package facade.
    }
  }
  assert.ok(loadedAddon, "No native addon available; run pnpm build:native first");
  const binarySha256 = sha256(readFileSync(loadedAddon));
  assert.equal(binarySha256, receipt.binarySha256, "Loaded native addon differs from its receipt");
  assert.deepEqual(receipt.cargoProfileEnv, {}, "Use an ordinary release addon for timed captures");
  assert.ok(receipt.ferriki.commit, "Native build receipt must name its Ferriki commit");
  return { receiptPath, receipt, loadedAddon, binarySha256 };
}

function identitySnapshot() {
  const native = nativeIdentity();
  const fixtureFiles = manifest.cases.map((entry) => ({
    path: join(resultRoot, entry.file),
    sha256: sha256(readFileSync(join(resultRoot, entry.file))),
  }));
  return {
    addon: {
      path: native.loadedAddon,
      sha256: native.binarySha256,
      receiptSha256: sha256(readFileSync(native.receiptPath)),
    },
    assetsSha256: sha256(readFileSync(join(nodeRoot, "ferriki/assets/shiki/release-manifest.json"))),
    harnessSha256: sha256(readFileSync(scriptPath)),
    sharedHarnessSha256: sha256(readFileSync(join(nodeRoot, "scripts/tiobe-benchmark.mjs"))),
    curatedManifestSha256: sha256(readFileSync(join(nodeRoot, "benchmarks/curated/manifest.json"))),
    fixtureManifestSha256: sha256(readFileSync(manifestPath)),
    fixtureFiles,
  };
}

function sourcePreserved(html, code) {
  assert.equal(toString(fromHtml(html, { fragment: true })), code);
}

function makeCall(highlighter, language, code, mode) {
  return mode === "inline"
    ? () => highlighter.codeToHtml(code, { lang: language, theme })
    : () => highlighter.codeToHtmlWithCss(code, { lang: language, theme, styleMode: "classes" });
}

function consume(mode, output) {
  return mode === "inline" ? output.length : output.html.length + output.css.length;
}

const candidates = curated.languages.filter((language) =>
  selectedNames.has(language.textmate),
);
assert.equal(candidates.length, selectedNames.size, "Curated corpus is missing a requested profile language");

const identityBefore = identitySnapshot();
const buildReceipt = nativeIdentity().receipt;

const rows = [];
for (const language of candidates) {
  const highlighter = await createHighlighter({
    langs: [language.textmate, ...(language.embedded ?? [])],
    themes: [theme],
    assets: { remote: false },
  });
  const oracle = await shiki.createHighlighter({
    langs: [language.textmate, ...(language.embedded ?? [])],
    themes: [theme],
    engine: shiki.createOnigurumaEngine(import("shiki/wasm")),
    assets: { remote: false },
  });
  try {
    for (const { code, ...workload } of loadCases(language, sizes, "curated")) {
      const calls = {
        inline: makeCall(highlighter, language.textmate, code, "inline"),
        classes: makeCall(highlighter, language.textmate, code, "classes"),
      };
      const inlineValidation = calls.inline();
      const classValidation = calls.classes();
      const oracleHtml = oracle.codeToHtml(code, { lang: language.textmate, theme });
      sourcePreserved(inlineValidation, code);
      sourcePreserved(classValidation.html, code);
      assert.equal(inlineValidation, oracleHtml, `${language.textmate}/${workload.size}: Shiki HTML parity failed`);
      assert(!classValidation.html.includes(" style="), "Class output unexpectedly contains inline styles");

      const samples = { inline: [], classes: [] };
      const consumed = { inline: 0, classes: 0 };
      const modes = ["inline", "classes"];
      for (let i = 0; i < warmup; i++) {
        for (const mode of modes) consumed[mode] += consume(mode, calls[mode]());
      }

      const started = performance.now();
      let round = 0;
      while (
        round < maxRounds &&
        (round < minRounds || performance.now() - started < budgetMsPerMode * modes.length)
      ) {
        const scheduled = round % 2 === 0 ? modes : [...modes].reverse();
        for (const mode of scheduled) {
          const sampleStart = performance.now();
          const output = calls[mode]();
          samples[mode].push(performance.now() - sampleStart);
          consumed[mode] += consume(mode, output);
        }
        round++;
      }
      const elapsedMs = performance.now() - started;

      const inlineHtml = calls.inline();
      const classOutput = calls.classes();
      rows.push({
        language: language.name,
        textmate: language.textmate,
        size: workload.size,
        copies: workload.copies,
        bytes: workload.bytes,
        lines: workload.lines,
        sourceSha256: workload.sha256,
        validation: {
          sourcePreserved: true,
          inlineExactShikiWasmHtml: true,
          classMode: "source preserved; CSS returned separately; no exact HTML parity claim",
        },
        output: {
          inlineHtmlBytes: Buffer.byteLength(inlineHtml),
          inlineHtmlSha256: sha256(inlineHtml),
          classHtmlBytes: Buffer.byteLength(classOutput.html),
          classHtmlSha256: sha256(classOutput.html),
          classCssBytes: Buffer.byteLength(classOutput.css),
          classCssSha256: sha256(classOutput.css),
          classCombinedBytes: Buffer.byteLength(classOutput.html) + Buffer.byteLength(classOutput.css),
        },
        timing: {
          samplesMs: samples,
          inline: statistics(samples.inline, workload.bytes),
          classes: statistics(samples.classes, workload.bytes),
          classesVsInlinePercent: 100 * (statistics(samples.classes, workload.bytes).medianMs / statistics(samples.inline, workload.bytes).medianMs - 1),
          consumedCharacters: consumed,
          elapsedMs,
          samplesPerMode: Object.fromEntries(Object.entries(samples).map(([mode, values]) => [mode, values.length])),
          method: "Each call renders complete HTML; class mode also constructs and returns its CSS. Five warmups; rotate inline/classes order each round; source/HTML validation excluded.",
          minRounds,
          budgetMsPerMode,
        },
      });
    }
  } finally {
    highlighter.dispose();
    oracle.dispose();
  }
}

const output = {
  schema: 1,
  capturedAt: new Date().toISOString(),
  revision: { commit: git("rev-parse", "HEAD"), status: git("status", "--porcelain") },
  machine: {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    cpu: os.cpus()[0]?.model ?? null,
    os: `${os.type()} ${os.release()}`,
  },
  versions: {
    ferriki: JSON.parse(readFileSync(join(nodeRoot, "ferriki/package.json"), "utf8")).version,
    shiki: JSON.parse(readFileSync(join(nodeRoot, "compat/upstream/shiki/packages/shiki/package.json"), "utf8")).version,
    ferroni: buildReceipt.ferroni.version,
  },
  nativeBuild: buildReceipt,
  identity: identityBefore,
  harnessSha256: sha256(readFileSync(scriptPath)),
  curatedManifestSha256: sha256(readFileSync(join(nodeRoot, "benchmarks/curated/manifest.json"))),
  method: {
    corpus: "Existing curated examples; example is one source fixture, large is 16 repeated copies.",
    output: "Ferriki inline mode returns themed HTML with inline styles. Class mode returns HTML and its required CSS from codeToHtmlWithCss; both resolve the same TextMate grammar and github-dark theme.",
    host: "Native release addon from the verified build receipt; remote assets disabled.",
  },
  rows,
};

assert.deepEqual(identitySnapshot(), identityBefore, "Addon, build receipt, assets, fixtures, or harness changed during timed run");

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);
