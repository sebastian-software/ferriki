// Measures Ferriki's native highlighter against Shiki on the same documents.
//
// Shiki runs twice: with its default Oniguruma engine compiled to WebAssembly,
// and with its JavaScript regex engine. Every engine renders the same corpus
// with the same language and theme, and its HTML, HAST and tokens must equal
// Shiki's Oniguruma output before a document is timed: a document an engine
// renders differently is reported and left out of that engine's timings.
//
// Two measurements:
//   - warm: one reused highlighter per engine, and per document each of
//     `codeToHtml`, `codeToHast` and `codeToTokensBase`, engines interleaved
//     round by round, the median of every sample;
//   - cold: a fresh Node process per run that imports the package, creates a
//     highlighter for the corpus languages and renders every document once.
//
// Usage (after `pnpm run build:compat` and `pnpm run build:native`):
//   node scripts/bench-shiki-comparison.mjs                 # print the report
//   node scripts/bench-shiki-comparison.mjs --write <path>  # also write JSON
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { comparisonCorpus } from "./shiki-comparison-corpus.mjs";

const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = join(nodeRoot, "..");
const corpus = comparisonCorpus;
const theme = "github-dark";
const langs = [...new Set(corpus.map(([lang]) => lang))];
const engines = ["ferriki", "shiki-wasm", "shiki-js"];

async function createEngine(id) {
  if (id === "ferriki") {
    const ferriki = await import("../ferriki/index.mjs");
    return ferriki.createHighlighter({ langs, themes: [theme] });
  }
  const shiki = await import("shiki");
  const engine =
    id === "shiki-wasm"
      ? shiki.createOnigurumaEngine(import("shiki/wasm"))
      : shiki.createJavaScriptRegexEngine();
  return shiki.createHighlighter({ langs, themes: [theme], engine });
}

function loadCorpus() {
  return corpus.map(([lang, path]) => {
    const code = readFileSync(join(repoRoot, path), "utf8");
    return {
      lang,
      path,
      code,
      lines: code.split("\n").length,
      bytes: new TextEncoder().encode(code).length,
    };
  });
}

// A child process for one cold run: import, create, render everything once.
if (process.argv[2] === "--cold") {
  const started = performance.now();
  const highlighter = await createEngine(process.argv[3]);
  for (const doc of loadCorpus()) highlighter.codeToHtml(doc.code, { lang: doc.lang, theme });
  process.stdout.write(String(performance.now() - started));
  process.exit(0);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const docs = loadCorpus();
const highlighters = Object.fromEntries(
  await Promise.all(engines.map(async (id) => [id, await createEngine(id)])),
);

// Output equality before timing: Shiki with Oniguruma is the reference, and
// an engine is timed on a document only where every API below agrees with it.
const apis = ["codeToHtml", "codeToHast", "codeToTokensBase"];
const plain = (value) => (typeof value === "string" ? value : JSON.parse(JSON.stringify(value)));
const agrees = Object.fromEntries(engines.map((id) => [id, []]));
for (const doc of docs) {
  const options = { lang: doc.lang, theme };
  const reference = apis.map((api) => plain(highlighters["shiki-wasm"][api](doc.code, options)));
  for (const id of engines) {
    // Equality of the serialized value: the native HAST lists object keys in
    // another order and differs in fields JSON leaves out, neither of which a
    // consumer that serializes the tree can observe.
    const same = apis.every((api, index) =>
      isDeepStrictEqual(plain(highlighters[id][api](doc.code, options)), reference[index]),
    );
    if (same) agrees[id].push(doc.path);
  }
}

const warmup = 5;
const minSamples = 30;
// HTML is what a site build calls, so it gets the longest budget per document.
const minMilliseconds = { codeToHtml: 1500, codeToHast: 500, codeToTokensBase: 500 };

function measure(api, doc) {
  const options = { lang: doc.lang, theme };
  const timed = engines.filter((id) => agrees[id].includes(doc.path));
  const samples = Object.fromEntries(timed.map((id) => [id, []]));
  for (let round = 0; round < warmup; round++) {
    for (const id of timed) highlighters[id][api](doc.code, options);
  }
  // Engines alternate within each round, so drift on the machine reaches all of them alike.
  const started = performance.now();
  while (
    samples[timed[0]].length < minSamples ||
    performance.now() - started < minMilliseconds[api] * timed.length
  ) {
    for (const id of timed) {
      const before = performance.now();
      highlighters[id][api](doc.code, options);
      samples[id].push(performance.now() - before);
    }
  }
  return {
    lang: doc.lang,
    path: doc.path,
    lines: doc.lines,
    bytes: doc.bytes,
    medianMs: Object.fromEntries(timed.map((id) => [id, median(samples[id])])),
    samples: samples[timed[0]].length,
  };
}

const warm = Object.fromEntries(apis.map((api) => [api, docs.map((doc) => measure(api, doc))]));

const coldRuns = 10;
const cold = Object.fromEntries(
  engines.map((id) => {
    const runs = [];
    for (let run = 0; run < coldRuns; run++) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--cold", id], {
        cwd: nodeRoot,
        encoding: "utf8",
      });
      if (child.status !== 0) throw new Error(`cold run for ${id} failed:\n${child.stderr}`);
      runs.push(Number(child.stdout));
    }
    return [id, { medianMs: median(runs), runs: coldRuns }];
  }),
);

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

const packageVersion = (path) =>
  JSON.parse(readFileSync(join(nodeRoot, path, "package.json"), "utf8")).version;

const report = {
  measured: new Date().toISOString().slice(0, 10),
  revision: git("rev-parse", "--short=8", "HEAD"),
  machine: {
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    cores: os.availableParallelism(),
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    platform: `${process.platform}-${process.arch}`,
    os: `${os.type()} ${os.release()}`,
    node: process.version,
  },
  versions: {
    ferriki: packageVersion("ferriki"),
    shiki: packageVersion("node_modules/shiki"),
  },
  theme,
  method: {
    apis,
    warmup,
    minSamples,
    minMilliseconds,
    coldRuns,
    statistic: "median",
  },
  agreement: Object.fromEntries(
    engines.map((id) => [id, { documents: agrees[id].length, of: docs.length }]),
  ),
  warm,
  cold,
};

// Corpus totals, only where an engine agreed on every document.
report.warmTotalMs = Object.fromEntries(
  apis.map((api) => [
    api,
    Object.fromEntries(
      engines
        .filter((id) => agrees[id].length === docs.length)
        .map((id) => [id, warm[api].reduce((sum, row) => sum + row.medianMs[id], 0)]),
    ),
  ]),
);

console.log(JSON.stringify(report, null, 2));
const outIndex = process.argv.indexOf("--write");
if (outIndex !== -1)
  writeFileSync(process.argv[outIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
