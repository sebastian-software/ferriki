import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  checkPhikiPrerequisites,
  createPhikiSetup,
  renderPhikiCold,
  startPhikiWorker,
} from "./phiki-benchmark.mjs";
import { compareHighlightedHtml, phikiStyleCriteria } from "./phiki-html-agreement.mjs";
import { comparisonCorpus } from "./shiki-comparison-corpus.mjs";
// Measures Ferriki, Shiki with two regex engines, and optional Phiki on the
// same repository corpus. Ferriki and both Shiki engines must produce the
// same serialized HTML. Phiki is compared by visible source text and
// per-character styles because it produces HTML with different wrappers.
//
// Warm Phiki timing forces PendingHtmlOutput::toString() and uses one
// persistent PHP process. PHP measures the render operation inside its worker,
// so sending JSON over stdin and receiving the response are outside the sample.
// Phiki per-document warm timings remain visible when its output differs;
// aggregate Phiki comparisons use only documents where its output and every
// Node engine's strict HTML check agree. Full Node headline totals stay
// full-corpus.
//
// Usage (from node/ after native/compat builds and optional Composer install):
//   node scripts/bench-shiki-comparison.mjs                 # print the report
//   node scripts/bench-shiki-comparison.mjs --write <path>  # also write JSON
import "./test-asset-env.mjs";

const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = join(nodeRoot, "..");
const scriptPath = fileURLToPath(import.meta.url);
// Freeze source inputs across a boundary migration without changing the
// implementation loaded by each engine. Cold children inherit this setting.
const corpusRoot = process.env.FERRIKI_BENCH_CORPUS_ROOT || repoRoot;
const corpus = comparisonCorpus;
const theme = "github-dark";
const langs = [...new Set(corpus.map(([lang]) => lang))];
const nodeEngines = ["ferriki", "shiki-wasm", "shiki-js"];
const htmlApi = "codeToHtml";
const prefilterIndex = process.argv.indexOf("--regex-prefilter");
const prefilter = prefilterIndex === -1 ? "on" : process.argv[prefilterIndex + 1];
if (!["on", "off"].includes(prefilter)) throw new Error("--regex-prefilter must be on or off");
const regexPrefilter = prefilter === "on";
const keepSamples = process.argv.includes("--raw-samples");

async function createEngine(id) {
  if (id === "ferriki") {
    const ferriki = await import("../ferriki/index.mjs");
    return ferriki.createHighlighter({ langs, themes: [theme], regexPrefilter });
  }
  const shiki = await import("shiki");
  const engine =
    id === "shiki-wasm"
      ? shiki.createOnigurumaEngine(import("shiki/wasm"))
      : shiki.createJavaScriptRegexEngine();
  return shiki.createHighlighter({ langs, themes: [theme], engine });
}

function loadCorpus(selectedPaths) {
  const allowed = selectedPaths ? new Set(selectedPaths) : null;
  return corpus
    .filter(([, path]) => !allowed || allowed.has(path))
    .map(([lang, path]) => {
      const code = readFileSync(join(corpusRoot, path), "utf8");
      return {
        lang,
        path,
        code,
        lines: code.split("\n").length,
        bytes: new TextEncoder().encode(code).length,
        sha256: createHash("sha256").update(code).digest("hex"),
      };
    });
}

// Each cold child uses the same startup boundary: process creation is outside
// the clock, and the timer starts before its engine-specific imports/autoload.
if (process.argv[2] === "--cold") {
  const started = performance.now();
  const highlighter = await createEngine(process.argv[3]);
  const selectedPaths = process.argv[4] ? JSON.parse(process.argv[4]) : undefined;
  for (const doc of loadCorpus(selectedPaths)) {
    highlighter.codeToHtml(doc.code, { lang: doc.lang, theme });
  }
  process.stdout.write(String(performance.now() - started));
  process.exit(0);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

const packageVersion = (path) =>
  JSON.parse(readFileSync(join(nodeRoot, path, "package.json"), "utf8")).version;

const docs = loadCorpus();
const highlighters = Object.fromEntries(
  await Promise.all(nodeEngines.map(async (id) => [id, await createEngine(id)])),
);

// Keep the strict output gate across all three Node engines: serialized HTML
// must match Shiki + Oniguruma for every document before its timing is counted.
const nodeAgreement = Object.fromEntries(nodeEngines.map((id) => [id, []]));
const wasmHtml = new Map();
for (const doc of docs) {
  const options = { lang: doc.lang, theme };
  const reference = highlighters["shiki-wasm"][htmlApi](doc.code, options);
  wasmHtml.set(doc.path, reference);
  for (const id of nodeEngines) {
    const same = highlighters[id][htmlApi](doc.code, options) === reference;
    if (same) nodeAgreement[id].push(doc.path);
  }
}

const prerequisites = checkPhikiPrerequisites(nodeRoot);
let phikiPrepared;
let phikiWorker;
let phikiRuntime;
let phikiStatus = { status: prerequisites.status, reason: prerequisites.reason };
const phikiAgreement = new Map();

if (prerequisites.status === "available") {
  try {
    phikiPrepared = await createPhikiSetup({
      nodeRoot,
      repoRoot,
      langs,
      theme,
      docs,
      prerequisites,
    });
    const started = await startPhikiWorker(nodeRoot, phikiPrepared);
    phikiWorker = started.worker;
    phikiRuntime = started.runtime;
    phikiStatus = { status: "available" };

    for (const doc of docs) {
      const result = await phikiWorker.request({
        op: "render",
        code: doc.code,
        lang: doc.lang,
        includeHtml: true,
      });
      if (!result.ok) {
        phikiAgreement.set(doc.path, {
          path: doc.path,
          lang: doc.lang,
          status: "error",
          reason: result.error,
        });
        continue;
      }

      try {
        const comparison = compareHighlightedHtml(wasmHtml.get(doc.path), result.html, doc.code);
        phikiAgreement.set(doc.path, {
          path: doc.path,
          lang: doc.lang,
          status: comparison.agrees ? "match" : "different",
          textAgrees: comparison.textAgrees,
          stylesAgree: comparison.stylesAgree,
          removedFinalNewlineSentinel: comparison.removedFinalNewlineSentinel,
          difference: comparison.difference,
        });
      } catch (error) {
        phikiAgreement.set(doc.path, {
          path: doc.path,
          lang: doc.lang,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    const worker = phikiWorker;
    phikiWorker = undefined;
    if (worker) {
      try {
        await worker.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Phiki output agreement failed during cleanup.",
        );
      }
    }
    throw error;
  }
}

const warmup = 5;
const minSamples = 30;
const coldRuns = 10;
const minMilliseconds = 1500;

function rotate(values, start) {
  const offset = start % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

async function measure(doc, documentIndex) {
  const options = { lang: doc.lang, theme };
  const timed = nodeEngines.filter((id) => nodeAgreement[id].includes(doc.path));
  const phikiOutputStatus = phikiAgreement.get(doc.path)?.status;
  if (phikiWorker && ["match", "different"].includes(phikiOutputStatus)) {
    timed.push("phiki");
  }
  const samples = Object.fromEntries(timed.map((id) => [id, []]));

  const invoke = async (id, collectSample) => {
    if (id === "phiki") {
      const result = await phikiWorker.request({ op: "render", code: doc.code, lang: doc.lang });
      if (!result.ok) throw new Error(`Warm Phiki render failed for ${doc.path}: ${result.error}`);
      if (collectSample) samples.phiki.push(result.elapsedNs / 1_000_000);
      return;
    }

    const before = performance.now();
    highlighters[id][htmlApi](doc.code, options);
    if (collectSample) samples[id].push(performance.now() - before);
  };

  for (let round = 0; round < warmup; round++) {
    for (const id of rotate(timed, documentIndex + round)) await invoke(id, false);
  }

  const started = performance.now();
  let round = 0;
  while (
    timed.some((id) => samples[id].length < minSamples) ||
    performance.now() - started < minMilliseconds * timed.length
  ) {
    // Serial cyclic order avoids running engines concurrently and gives each
    // engine each position in the repeating order over successive samples.
    for (const id of rotate(timed, documentIndex + round)) await invoke(id, true);
    round++;
  }

  const medianMs = Object.fromEntries(timed.map((id) => [id, median(samples[id])]));
  return {
    lang: doc.lang,
    path: doc.path,
    lines: doc.lines,
    bytes: doc.bytes,
    medianMs,
    samples: samples[timed[0]].length,
    sha256: doc.sha256,
    ...(keepSamples ? { samplesMs: samples } : {}),
    ...(phikiWorker ? { phikiAgreement: phikiAgreement.get(doc.path)?.status ?? "error" } : {}),
  };
}

const warm = { [htmlApi]: [] };
let htmlMeasurementError;
try {
  for (const [documentIndex, doc] of docs.entries()) {
    warm[htmlApi].push(await measure(doc, documentIndex));
  }
} catch (error) {
  htmlMeasurementError = error;
}

const htmlWorker = phikiWorker;
phikiWorker = undefined;
if (htmlWorker) {
  try {
    await htmlWorker.close();
  } catch (closeError) {
    if (htmlMeasurementError) {
      throw new AggregateError(
        [htmlMeasurementError, closeError],
        "Phiki HTML measurement and worker cleanup both failed.",
      );
    }
    throw closeError;
  }
}
if (htmlMeasurementError) throw htmlMeasurementError;

function runNodeCold(id, selectedPaths) {
  const child = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--cold",
      id,
      JSON.stringify(selectedPaths ?? null),
      "--regex-prefilter",
      prefilter,
    ],
    { cwd: nodeRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (child.error || child.status !== 0) {
    throw new Error(`Cold run for ${id} failed:\n${child.stderr || child.error?.message}`);
  }
  return Number(child.stdout);
}

const cold = Object.fromEntries(
  nodeEngines.map((id) => {
    const runs = [];
    for (let run = 0; run < coldRuns; run++) runs.push(runNodeCold(id));
    return [
      id,
      { medianMs: median(runs), runs: coldRuns, ...(keepSamples ? { samplesMs: runs } : {}) },
    ];
  }),
);

const sharedHtmlDocs = docs.filter(
  (doc) =>
    phikiAgreement.get(doc.path)?.status === "match" &&
    nodeEngines.every((id) => nodeAgreement[id].includes(doc.path)),
);

let coldMatching = {
  status: prerequisites.status === "available" ? "no-matching-documents" : "skipped",
  documents: 0,
  of: docs.length,
  reason:
    prerequisites.status === "available"
      ? "No documents matched the four-engine HTML output agreement criteria."
      : prerequisites.reason,
};
let warmMatchingTotalMs;
if (phikiPrepared && sharedHtmlDocs.length > 0) {
  const selectedPaths = sharedHtmlDocs.map(({ path }) => path);
  const medianMs = {};
  for (const id of nodeEngines) {
    const rows = warm.codeToHtml.filter((row) => selectedPaths.includes(row.path));
    medianMs[id] = rows.reduce((sum, row) => sum + row.medianMs[id], 0);
  }
  medianMs.phiki = warm.codeToHtml
    .filter((row) => selectedPaths.includes(row.path))
    .reduce((sum, row) => sum + row.medianMs.phiki, 0);
  warmMatchingTotalMs = { documents: sharedHtmlDocs.length, of: docs.length, medianMs };

  const runs = Object.fromEntries(nodeEngines.map((id) => [id, []]));
  for (let run = 0; run < coldRuns; run++) {
    for (const id of nodeEngines) runs[id].push(runNodeCold(id, selectedPaths));
  }
  const phikiRuns = [];
  for (let run = 0; run < coldRuns; run++)
    phikiRuns.push(renderPhikiCold(nodeRoot, phikiPrepared, sharedHtmlDocs));
  coldMatching = {
    status: "available",
    documents: sharedHtmlDocs.length,
    of: docs.length,
    paths: selectedPaths,
    medianMs: Object.fromEntries([
      ...nodeEngines.map((id) => [id, median(runs[id])]),
      ["phiki", median(phikiRuns)],
    ]),
    runs: coldRuns,
    ...(keepSamples ? { samplesMs: { ...runs, phiki: phikiRuns } } : {}),
  };
}

const versions = {
  ferriki: packageVersion("ferriki"),
  shiki: packageVersion("node_modules/shiki"),
  tmGrammars: packageVersion("node_modules/tm-grammars"),
  tmThemes: packageVersion("node_modules/tm-themes"),
  phiki: phikiPrepared?.versions.phiki ?? null,
  psrSimpleCache: phikiPrepared?.versions.psrSimpleCache ?? null,
  php: phikiPrepared?.versions.php ?? prerequisites.runtime?.version ?? null,
  composer: phikiPrepared?.versions.composer ?? null,
};
const workingTreeStatus = git("status", "--porcelain");
const report = {
  measured: new Date().toISOString().slice(0, 10),
  revision: git("rev-parse", "--short=8", "HEAD"),
  source: {
    revision: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    workingTreeClean: workingTreeStatus === "",
    distribution:
      "Ferriki version is read from the workspace source package; this report does not certify a registry artifact.",
  },
  machine: {
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    cores: os.availableParallelism(),
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    platform: `${process.platform}-${process.arch}`,
    os: `${os.type()} ${os.release()}`,
    node: process.version,
  },
  versions,
  assets: {
    tmGrammars: versions.tmGrammars,
    tmThemes: versions.tmThemes,
    phiki: phikiPrepared?.assets ?? null,
  },
  runtime: {
    node: process.version,
    phiki: phikiRuntime ?? prerequisites.runtime ?? null,
    phpIniArguments: phikiPrepared
      ? ["opcache.enable_cli=0", "opcache.jit=disable", "opcache.jit_buffer_size=0"]
      : [],
  },
  theme,
  method: {
    regexPrefilter,
    apis: [htmlApi],
    warmup,
    minSamples,
    minMilliseconds,
    coldRuns,
    statistic: "median",
    phiki: {
      status: phikiStatus.status,
      reason: phikiStatus.reason,
      warmProcess:
        "one persistent PHP CLI process and one Phiki highlighter for output checks, warmup and samples",
      warmTimingBoundary:
        "PHP hrtime around codeToHtml()->cache(null)->toString(); JSON stdin/stdout transport and post-render HTML length checks are excluded",
      coldTimingBoundary:
        "fresh Node or PHP process per run; process creation is excluded, Node module loading / Composer autoload, highlighter setup and rendering are included",
      warmTimingOrder:
        "serial; per document, warmup and measured orders each rotate by documentIndex + round among eligible engines, separately for each phase; Phiki sample duration comes from the PHP worker stopwatch",
      coldTimingOrder:
        "full corpus: ten consecutive fresh processes per Node engine in ferriki -> shiki-wasm -> shiki-js order; shared cohort: ten rounds in ferriki -> shiki-wasm -> shiki-js order, then ten consecutive Phiki processes",
      agreement:
        "normalized visible source text and per-Unicode-codepoint color, font-style, font-weight and text-decoration",
      eolNormalization:
        "CRLF and CR normalize to LF; one final artificial LF is removed only when rendered text is exactly source plus one LF",
      differingOutputTimings:
        "per-document warm timings are shown with their output status but excluded from every aggregate total; cold Phiki timing requires a matching shared cohort",
      grammarRegistration:
        "recursive embedded grammars are registered by scope through a narrowly scoped ReflectionProperty bridge for the pinned Phiki 2.2.1 repository; external injectionSelector/injectTo assets are inventoried but not activated",
    },
  },
  agreement: {
    ...Object.fromEntries(
      nodeEngines.map((id) => [id, { documents: nodeAgreement[id].length, of: docs.length }]),
    ),
    phiki: {
      status: phikiStatus.status,
      documents: [...phikiAgreement.values()].filter((row) => row.status === "match").length,
      of: docs.length,
    },
  },
  outputAgreement: {
    criteria: `visible source text and per-Unicode-codepoint ${phikiStyleCriteria.join(", ")}`,
    documents: docs.map(({ path }) => phikiAgreement.get(path) ?? { path, status: "unavailable" }),
  },
  phiki: {
    status: phikiStatus.status,
    reason: phikiStatus.reason,
    operations: {
      codeToHtml: phikiStatus.status === "available" ? "available" : "skipped",
    },
    runtime: phikiRuntime ?? prerequisites.runtime ?? null,
  },
  warm,
  cold,
  coldMatching,
};

if (warmMatchingTotalMs) report.warmMatchingTotalMs = warmMatchingTotalMs;

// Existing headline totals intentionally remain Node-only and full-corpus.
report.warmTotalMs = Object.fromEntries(
  [htmlApi].map((api) => [
    api,
    Object.fromEntries(
      nodeEngines
        .filter((id) => nodeAgreement[id].length === docs.length)
        .map((id) => [id, warm[api].reduce((sum, row) => sum + row.medianMs[id], 0)]),
    ),
  ]),
);

if (prerequisites.status !== "available") {
  console.error(`[benchmark] Phiki skipped: ${prerequisites.reason}`);
}
console.log(JSON.stringify(report, null, 2));
const outIndex = process.argv.indexOf("--write");
if (outIndex !== -1)
  writeFileSync(process.argv[outIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
