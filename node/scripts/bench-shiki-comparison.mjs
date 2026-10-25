import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { coldSamples, rotate } from "./benchmark-schedule.mjs";
import {
  checkPhikiPrerequisites,
  createPhikiSetup,
  renderPhikiCold,
  startPhikiWorker,
} from "./phiki-benchmark.mjs";
import { compareHighlightedHtml, phikiStyleCriteria } from "./phiki-html-agreement.mjs";
import {
  ferrikiRegexOptions,
  regexModeEngines,
  regexModes,
  validateRegexDiagnostics,
} from "./regex-benchmark-modes.mjs";
import { comparisonCorpus } from "./shiki-comparison-corpus.mjs";
import {
  standardGrammarRegistrations,
  standardThemeRegistrations,
} from "./standard-grammar-reference.mjs";
import { engineUnsupportedReason } from "./tiobe-benchmark.mjs";
// Measures Ferriki, Shiki with two regex engines, and optional Phiki on the
// same repository corpus. Ferriki and both Shiki engines must produce the
// same serialized HTML for supported grammars. A known JavaScript converter
// limitation is explicit and excludes that engine's full-corpus totals.
// Phiki is compared by visible source text and
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
const measureRegexModes = process.argv.includes("--regex-modes");
const nodeEngines = measureRegexModes
  ? regexModeEngines.filter((id) => id !== "prism")
  : ["ferriki", "shiki-wasm", "shiki-js"];
const htmlApi = "codeToHtml";
const prefilterIndex = process.argv.indexOf("--regex-prefilter");
const prefilter = prefilterIndex === -1 ? "on" : process.argv[prefilterIndex + 1];
if (!["on", "off"].includes(prefilter)) throw new Error("--regex-prefilter must be on or off");
if (measureRegexModes && prefilter !== "on")
  throw new Error("--regex-modes selects fixed contenders; omit --regex-prefilter off");
const regexPrefilter = prefilter === "on";
const keepSamples = process.argv.includes("--raw-samples");

async function createEngine(id, selectedLangs = langs) {
  const regexOptions = ferrikiRegexOptions(id, regexPrefilter);
  if (regexOptions) {
    const ferriki = await import("../ferriki/index.mjs");
    return ferriki.createHighlighter({ langs: selectedLangs, themes: [theme], ...regexOptions });
  }
  const shiki = await import("shiki-benchmark");
  const engine =
    id === "shiki-wasm"
      ? shiki.createOnigurumaEngine(import("shiki-benchmark/wasm"))
      : shiki.createJavaScriptRegexEngine();
  return shiki.createHighlighter({
    langs: standardGrammarRegistrations(selectedLangs),
    themes: standardThemeRegistrations([theme]),
    engine,
  });
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
  const selectedPaths = process.argv[4] ? JSON.parse(process.argv[4]) : undefined;
  const selectedDocs = loadCorpus(selectedPaths);
  const highlighter = await createEngine(process.argv[3], [
    ...new Set(selectedDocs.map((doc) => doc.lang)),
  ]);
  for (const doc of selectedDocs) {
    highlighter.codeToHtml(doc.code, { lang: doc.lang, theme });
  }
  const ms = performance.now() - started;
  const regexDiagnostics =
    measureRegexModes && ferrikiRegexOptions(process.argv[3])
      ? highlighter.getRegexDiagnostics()
      : undefined;
  if (regexDiagnostics)
    validateRegexDiagnostics(
      regexDiagnostics,
      regexModes[process.argv[3]],
      regexModes[process.argv[3]] === "prepared",
    );
  process.stdout.write(measureRegexModes ? JSON.stringify({ ms, regexDiagnostics }) : String(ms));
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
const unsupported = new Map(docs.map((doc) => [doc.path, {}]));
const highlighters = {};
for (const id of nodeEngines) {
  try {
    highlighters[id] = await createEngine(id);
  } catch (error) {
    const reason =
      langs.includes("yaml") && engineUnsupportedReason(id, { textmate: "yaml" }, error);
    if (!reason) throw error;
    for (const doc of docs.filter((doc) => doc.lang === "yaml"))
      unsupported.get(doc.path)[id] = reason;
    highlighters[id] = await createEngine(
      id,
      langs.filter((lang) => lang !== "yaml"),
    );
  }
}

// Keep the strict output gate across all three Node engines: serialized HTML
// must match Shiki + Oniguruma for every document before its timing is counted.
const nodeAgreement = Object.fromEntries(nodeEngines.map((id) => [id, []]));
const wasmHtml = new Map();
for (const doc of docs) {
  const options = { lang: doc.lang, theme };
  const reference = highlighters["shiki-wasm"][htmlApi](doc.code, options);
  wasmHtml.set(doc.path, reference);
  for (const id of nodeEngines) {
    if (unsupported.get(doc.path)[id]) continue;
    try {
      const same = highlighters[id][htmlApi](doc.code, options) === reference;
      if (same) nodeAgreement[id].push(doc.path);
    } catch (error) {
      const reason = engineUnsupportedReason(id, { textmate: doc.lang }, error);
      if (!reason) throw error;
      unsupported.get(doc.path)[id] = reason;
      // Restart after a failed conversion so later comparisons use a clean engine.
      highlighters[id].dispose();
      highlighters[id] = await createEngine(
        id,
        langs.filter((lang) => lang !== doc.lang),
      );
    }
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
    ...(Object.keys(unsupported.get(doc.path)).length
      ? { unsupported: unsupported.get(doc.path) }
      : {}),
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

const coldRegexDiagnostics = Object.fromEntries(Object.keys(regexModes).map((id) => [id, []]));
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
      ...(measureRegexModes ? ["--regex-modes"] : []),
    ],
    { cwd: nodeRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (child.error || child.status !== 0) {
    throw new Error(`Cold run for ${id} failed:\n${child.stderr || child.error?.message}`);
  }
  if (!measureRegexModes) return Number(child.stdout);
  const sample = JSON.parse(child.stdout);
  if (sample.regexDiagnostics && !selectedPaths)
    coldRegexDiagnostics[id].push(sample.regexDiagnostics);
  return sample.ms;
}

const eligibleColdEngines = nodeEngines.filter((id) =>
  docs.every((doc) => !unsupported.get(doc.path)[id]),
);
const fullColdSamples = coldSamples(eligibleColdEngines, coldRuns, (id) => runNodeCold(id));
const cold = Object.fromEntries(
  nodeEngines.map((id) => {
    const runs = fullColdSamples[id];
    return [
      id,
      runs
        ? { medianMs: median(runs), runs: coldRuns, ...(keepSamples ? { samplesMs: runs } : {}) }
        : {
            status: "unsupported",
            reason: "Full-corpus cold timing requires every grammar to be supported",
            paths: docs.filter((doc) => unsupported.get(doc.path)[id]).map((doc) => doc.path),
          },
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

  const runs = coldSamples([...nodeEngines, "phiki"], coldRuns, (id) =>
    id === "phiki"
      ? renderPhikiCold(nodeRoot, phikiPrepared, sharedHtmlDocs)
      : runNodeCold(id, selectedPaths),
  );
  coldMatching = {
    status: "available",
    documents: sharedHtmlDocs.length,
    of: docs.length,
    paths: selectedPaths,
    medianMs: Object.fromEntries([
      ...nodeEngines.map((id) => [id, median(runs[id])]),
      ["phiki", median(runs.phiki)],
    ]),
    runs: coldRuns,
    ...(keepSamples ? { samplesMs: runs } : {}),
  };
}

const versions = {
  ferriki: packageVersion("ferriki"),
  shiki: packageVersion("node_modules/shiki-benchmark"),
  tmGrammars: packageVersion("node_modules/tm-grammars"),
  tmThemes: packageVersion("node_modules/tm-themes"),
  phiki: phikiPrepared?.versions.phiki ?? null,
  psrSimpleCache: phikiPrepared?.versions.psrSimpleCache ?? null,
  php: phikiPrepared?.versions.php ?? prerequisites.runtime?.version ?? null,
  composer: phikiPrepared?.versions.composer ?? null,
};
const workingTreeStatus = git("status", "--porcelain");
const report = {
  ...(measureRegexModes ? { schema: 2 } : {}),
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
  ...(measureRegexModes
    ? {
        regexDiagnostics: Object.fromEntries(
          Object.entries(highlighters)
            .filter(([id]) => ferrikiRegexOptions(id))
            .map(([id, highlighter]) => {
              const snapshot = highlighter.getRegexDiagnostics();
              validateRegexDiagnostics(snapshot, regexModes[id], regexModes[id] === "prepared");
              return [id, snapshot];
            }),
        ),
        coldRegexDiagnostics,
      }
    : {}),
  method: {
    ...(!measureRegexModes ? { regexPrefilter } : {}),
    ...(measureRegexModes ? { regexModes } : { regexMode: regexPrefilter ? "auto" : "off" }),
    apis: [htmlApi],
    warmup,
    minSamples,
    minMilliseconds,
    coldRuns,
    coldTimingOrder:
      "Ten rounds of fresh processes; eligible engine order rotates each round, serially",
    assetCache:
      "Downloaded payloads are pre-populated. Prepared mode also reuses decoded containers populated by untimed output validation; cold means a fresh process, not an empty asset cache. First-fill decompression is measured separately in docs/benchmarks/precompiled-patterns/decoded-cache.",
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
        "full corpus and shared cohort: ten rounds of fresh processes, rotating eligible engines each round; shared cohort includes Phiki in the rotation",
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
