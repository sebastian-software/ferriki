// Bounded issue #240 experiment. All timing workers run sequentially.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import inspector from "node:inspector";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import * as shiki from "shiki";

const nodeRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const out = fileURLToPath(new URL("../", import.meta.url));
const { loadCases, loadCorpus, quantile, sha256 } = await import(pathToFileURL(join(nodeRoot, "scripts/tiobe-benchmark.mjs")));
await import(pathToFileURL(join(nodeRoot, "scripts/test-asset-env.mjs")));
const { values } = parseArgs({ options: {
  mode: { type: "string", default: "bench" },
  engines: { type: "string", default: "baseline,candidate" },
  processes: { type: "string", default: "4" },
  rounds: { type: "string", default: "12" },
  worker: { type: "string" },
  write: { type: "string", default: "measure.json" },
} });
const names = values.engines.split(",");
const selected = new Set(["typescript", "tsx", "html", "cpp", "json", "astro"]);
const languages = loadCorpus("curated").languages.filter((entry) => selected.has(entry.textmate));
const median = (samples) => quantile(samples, 0.5);
const nativePath = join(nodeRoot, "platforms/darwin-arm64/ferriki.node");
const git = (...args) => execFileSync("git", args, { cwd: nodeRoot, encoding: "utf8" }).trim();
const identity = () => ({
  commit: git("rev-parse", "HEAD"),
  addonSha256: sha256(readFileSync(nativePath)),
  build: JSON.parse(readFileSync(join(out, "baseline-build.json"))),
  assetsSha256: sha256(readFileSync(join(nodeRoot, "ferriki/assets/shiki/release-manifest.json"))),
  cargoLockSha256: sha256(readFileSync(join(nodeRoot, "../Cargo.lock"))),
  pnpmLockSha256: sha256(readFileSync(join(nodeRoot, "pnpm-lock.yaml"))),
  harnessSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  sharedHarnessSha256: sha256(readFileSync(join(nodeRoot, "scripts/tiobe-benchmark.mjs"))),
  engines: Object.fromEntries(names.map((name) => [name, JSON.parse(readFileSync(join(out, `${name}-source.json`)))])),
  node: process.version, platform: `${process.platform}-${process.arch}`, cpu: os.cpus()[0].model,
  os: os.release(),
});
const optionsFor = (language, lane) => ({
  lang: language,
  ...(lane.includes("multi") ? { themes: { dark: "github-dark", light: "github-light" } } : { theme: "github-dark" }),
  ...(lane.includes("transformer") ? { transformers: [{ line(node) { node.properties["data-line"] = ""; } }] } : {}),
});
const profileState = () => ({ nativeMs: 0, renderMs: 0, serializeMs: 0, scopeMs: 0, styleMs: 0, scopeCalls: 0, styleCalls: 0, scopes: new Set(), styles: new Set() });
const outputHash = (value) => sha256(JSON.stringify(value));

async function open(name, language) {
  const api = await import(pathToFileURL(join(nodeRoot, ".cache/render-memoization", name, "index.mjs")));
  return api.createHighlighter({ langs: [language.textmate, ...(language.embedded ?? [])], themes: ["github-dark", "github-light"], assets: { remote: false } });
}

async function worker(seed) {
  const cases = [];
  for (const language of languages) {
    const engines = await Promise.all(names.map((name) => open(name, language)));
    const oracle = await shiki.createHighlighter({ langs: [language.textmate, ...(language.embedded ?? [])], themes: ["github-dark", "github-light"] });
    try {
      for (const { code, ...workload } of loadCases(language, ["example", "large"], "curated")) {
        for (const lane of ["classes", "classes-multi", "inline", "inline-transformer"]) {
          const options = optionsFor(language.textmate, lane);
          const calls = engines.map((engine) => lane.startsWith("classes")
            ? () => engine.codeToHtmlWithCss(code, options)
            : () => engine.codeToHtml(code, options));
          const outputs = calls.map((call) => call());
          for (const output of outputs) {
            assert.equal(toString(fromHtml(typeof output === "string" ? output : output.html, { fragment: true })), code);
            assert.deepEqual(output, outputs[0], "Exact baseline/candidate HTML and CSS parity");
          }
          if (lane === "inline") assert.equal(outputs[0], oracle.codeToHtml(code, options), "Exact Shiki inline parity");
          for (let round = 0; round < 5; round++) for (const call of calls) call();
          const samples = names.map(() => []);
          for (let round = 0; round < Number(values.rounds); round++) {
            for (let step = 0; step < names.length; step++) {
              const index = (round + seed + step) % names.length;
              const started = performance.now();
              const output = calls[index]();
              samples[index].push(performance.now() - started);
              assert.ok(output);
            }
          }
          cases.push({ id: `${language.textmate}/${workload.size}/${lane}`, ...workload,
            outputSha256: outputHash(outputs[0]),
            outputBytes: Buffer.byteLength(typeof outputs[0] === "string" ? outputs[0] : outputs[0].html + outputs[0].css),
            samplesMs: Object.fromEntries(names.map((name, i) => [name, samples[i]])),
          });
        }
      }
    } finally { engines.forEach((engine) => engine.dispose()); oracle.dispose(); }
  }
  return { seed, cases };
}

async function profile() {
  const rows = [];
  for (const language of languages) {
    const base = await open("baseline", language);
    const diagnostic = await open("diagnostic", language);
    try {
      for (const { code, ...workload } of loadCases(language, ["example", "large"], "curated")) {
        const options = optionsFor(language.textmate, "classes");
        const samples = [];
        for (let i = 0; i < 14; i++) {
          globalThis.renderProfile = profileState();
          const started = performance.now();
          const output = diagnostic.codeToHtmlWithCss(code, options);
          globalThis.renderProfile.totalMs = performance.now() - started;
          if (i === 0) assert.deepEqual(output, base.codeToHtmlWithCss(code, options));
          if (i >= 5) samples.push({ ...globalThis.renderProfile, scopes: [...globalThis.renderProfile.scopes], styles: [...globalThis.renderProfile.styles] });
        }
        rows.push({ id: `${language.textmate}/${workload.size}`, ...workload, samples });
        console.error(`[phases] ${rows.at(-1).id}`);
      }
    } finally { base.dispose(); diagnostic.dispose(); }
  }
  // Uninstrumented ordinary JS CPU profiles corroborate the phase counters.
  for (const language of languages) {
    const base = await open("baseline", language);
    const entry = loadCases(language, ["large"], "curated")[0];
    const options = optionsFor(language.textmate, "classes");
    for (let i = 0; i < 5; i++) base.codeToHtmlWithCss(entry.code, options);
    const session = new inspector.Session(); session.connect();
    const post = (method) => new Promise((resolve, reject) => session.post(method, (error, data) => error ? reject(error) : resolve(data)));
    await post("Profiler.enable"); await post("Profiler.start");
    const end = performance.now() + 2000;
    while (performance.now() < end) base.codeToHtmlWithCss(entry.code, options);
    const { profile: cpu } = await post("Profiler.stop");
    session.disconnect(); base.dispose();
    writeFileSync(join(out, `cpu-${language.textmate}.json`), JSON.stringify(cpu) + "\n");
  }
  return { identity: identity(), rows };
}

if (values.mode === "profile") {
  writeFileSync(join(out, values.write), JSON.stringify(await profile()) + "\n");
} else if (values.worker !== undefined) {
  process.stdout.write(JSON.stringify(await worker(Number(values.worker))));
} else {
  const before = identity();
  assert.deepEqual(before.build.cargoProfileEnv, {});
  assert.equal(before.addonSha256, before.build.binarySha256);
  const runs = [];
  for (let seed = 0; seed < Number(values.processes); seed++) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2), "--worker", String(seed)], { stdio: ["ignore", "pipe", "inherit"] });
    let result = ""; child.stdout.on("data", (chunk) => result += chunk);
    assert.equal(await new Promise((resolve) => child.on("close", resolve)), 0);
    runs.push(JSON.parse(result));
    console.error(`[rotating] process ${seed + 1}/${values.processes}`);
  }
  assert.deepEqual(identity(), before, "Measurement identities changed");
  const cases = runs[0].cases.map((entry, index) => {
    const byEngine = Object.fromEntries(names.map((name) => [name, median(runs.flatMap((run) => run.cases[index].samplesMs[name]))]));
    for (const run of runs) assert.equal(run.cases[index].outputSha256, entry.outputSha256);
    return { id: entry.id, medianMs: byEngine, changePerProcess: Object.fromEntries(names.slice(1).map((name) => [name, runs.map((run) => median(run.cases[index].samplesMs[name]) / median(run.cases[index].samplesMs[names[0]]) - 1)])) };
  });
  writeFileSync(join(out, values.write), JSON.stringify({ capturedAt: new Date().toISOString(), identity: before, options: values, validation: "exact HTML/CSS equality and source preservation for all engines/cases; inline equality with Shiki", cases, runs }) + "\n");
  for (const entry of cases) console.log(entry.id, entry.medianMs);
}
