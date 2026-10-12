// Run one validated, warmed workload continuously for an external CPU profiler.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import inspector from "node:inspector";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { loadFerrikiNativeBinding } from "../ferriki/native.mjs";
import {
  createEngine,
  engines,
  loadCases,
  loadCorpus,
  repoRoot,
  sha256,
  statistics,
  theme,
  validateOutput,
} from "./tiobe-benchmark.mjs";

const { values } = parseArgs({
  options: {
    corpus: { type: "string", default: "tiobe" },
    language: { type: "string", default: "cpp" },
    size: { type: "string", default: "large" },
    engine: { type: "string", default: "ferriki" },
    boundary: { type: "string", default: "facade" },
    seconds: { type: "string", default: "15" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/profile-tiobe.mjs [--corpus tiobe|curated] [--language cpp] [--size large|example] [--engine ferriki|shiki-wasm|shiki-js|prism] [--boundary facade|native] [--seconds 15]",
  );
  process.exit(0);
}
const manifest = loadCorpus(values.corpus);
const language = manifest.languages.find((entry) => entry.textmate === values.language);
assert.ok(language?.file, "Choose a supported TextMate language ID");
assert.ok(["example", "large"].includes(values.size), "Invalid --size");
assert.ok(engines.includes(values.engine), "Invalid --engine");
assert.ok(["facade", "native"].includes(values.boundary), "Invalid --boundary");
assert.ok(
  values.boundary === "facade" || values.engine === "ferriki",
  "The native boundary requires Ferriki",
);
const seconds = Number(values.seconds);
assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= 300, "Invalid --seconds");
const { code, ...workload } = loadCases(language, [values.size], values.corpus)[0];
const oracle = await createEngine("shiki-wasm", language);
const reference = { html: oracle.html(code) };
oracle.dispose();

let run;
let dispose;
let validation;
if (values.boundary === "facade") {
  const highlighter = await createEngine(values.engine, language);
  validation = validateOutput(values.engine, code, highlighter.html(code), reference);
  if (validation.referenceParity) assert.deepEqual(validation.referenceParity, { html: true });
  run = () => highlighter.html(code);
  dispose = () => highlighter.dispose();
} else {
  const highlighter = loadFerrikiNativeBinding().createHighlighter({
    standardAssetRoot: join(repoRoot, "node/ferriki/assets/shiki"),
  });
  for (const lang of [language.textmate, ...(language.embedded ?? [])])
    highlighter.loadStandardGrammar(lang);
  highlighter.loadStandardTheme(theme);
  const options = { lang: language.textmate, theme };
  const html = highlighter.codeToHtml(code, options);
  validation = validateOutput("ferriki", code, html, reference);
  assert.deepEqual(validation.referenceParity, { html: true });
  run = () => highlighter.codeToHtml(code, options);
  dispose = () => highlighter.dispose();
}
const receipt =
  values.engine === "ferriki"
    ? JSON.parse(readFileSync(join(repoRoot, "node/ferriki/.benchmark-build.json"), "utf8"))
    : null;
if (receipt) {
  // Check the loaded sidecar as well as the development copies.
  const { createRequire } = await import("node:module");
  const { resolveFerrikiPlatformTarget } = await import("../ferriki/platforms.mjs");
  const require = createRequire(new URL("../ferriki/native.mjs", import.meta.url));
  const target = resolveFerrikiPlatformTarget();
  const candidates = [
    `${target.packageName}/ferriki.node`,
    join(repoRoot, "node/ferriki/dist", target.binaryName),
    join(repoRoot, "node/ferriki/dist/ferriki.node"),
    join(repoRoot, "node/ferriki/ferriki.node"),
  ];
  let loaded;
  for (const candidate of candidates) {
    try {
      const path = require.resolve(candidate);
      require(path);
      loaded = path;
      break;
    } catch {
      // Follow the facade's native candidate order.
    }
  }
  assert.ok(loaded, "No native addon loaded");
  assert.equal(sha256(readFileSync(loaded)), receipt.binarySha256, "Stale build receipt");
}
let consumed = 0;
const cpuProfilePath = process.env.FERRIKI_CPU_PROFILE_PATH;
let cpuProfiler;
function postInspector(session, method) {
  return new Promise((resolve, reject) =>
    session.post(method, (error, result) => (error ? reject(error) : resolve(result))),
  );
}
try {
  for (let i = 0; i < 5; i++) consumed += run().length;
  process.stderr.write(`[profile-tiobe] Warm workload ready; pid=${process.pid}\n`);
  if (cpuProfilePath) {
    cpuProfiler = new inspector.Session();
    cpuProfiler.connect();
    await postInspector(cpuProfiler, "Profiler.enable");
    await postInspector(cpuProfiler, "Profiler.start");
  }
  const started = performance.now();
  const samplesMs = [];
  while (performance.now() - started < seconds * 1000) {
    const start = performance.now();
    const result = run();
    samplesMs.push(performance.now() - start);
    consumed += result.length;
  }
  let cpuProfile = null;
  if (cpuProfiler) {
    const stopped = await postInspector(cpuProfiler, "Profiler.stop");
    cpuProfile = { path: cpuProfilePath, nodes: stopped.profile.nodes.length };
    writeFileSync(cpuProfilePath, `${JSON.stringify(stopped.profile)}\n`);
    cpuProfiler.disconnect();
    cpuProfiler = null;
  }
  console.log(
    JSON.stringify({
      options: values,
      workload,
      validation,
      nativeBuild: receipt,
      measurementStartedAtMs: started,
      measurementEndedAtMs: performance.now(),
      iterations: samplesMs.length,
      consumed,
      cpuProfile,
      timing: statistics(samplesMs, workload.bytes),
    }),
  );
} finally {
  cpuProfiler?.disconnect();
  dispose();
}
