// Paired token-boundary benchmark: compares native addons on the same cases
// inside each process, with rotating call order, across independent processes.
// An engine is `name=path` for the typed binding or `name=json:path` for the
// napi-rs 2 binding that exchanged JSON strings (decoding stays in the timer).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TEST_ASSET_CACHE_DIR } from "./test-asset-env.mjs";
import { loadCases, loadCorpus, quantile, sha256 } from "./tiobe-benchmark.mjs";

const { values } = parseArgs({
  options: {
    engine: { type: "string", multiple: true, default: [] },
    "prefilter-off": { type: "string", multiple: true, default: [] },
    processes: { type: "string", default: "6" },
    rounds: { type: "string", default: "20" },
    warmups: { type: "string", default: "3" },
    themes: { type: "string", default: "single,multi" },
    sizes: { type: "string", default: "example,large" },
    corpora: { type: "string", default: "tiobe,curated" },
    languages: { type: "string" },
    worker: { type: "string" },
    write: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/bench-native-boundary-paired.mjs --engine base=json:old.node --engine typed=new.node [--prefilter-off typed] [--processes 6] [--rounds 20] [--themes single,multi,html] [--sizes example,large] [--corpora tiobe,curated] [--languages json,astro] [--write report.json]",
  );
  process.exit(0);
}
const engines = values.engine.map((spec) => {
  const [name, ...rest] = spec.split("=");
  const target = rest.join("=");
  const json = target.startsWith("json:");
  const path = json ? target.slice(5) : target;
  assert.ok(name && path, `Invalid --engine ${spec}`);
  return {
    name,
    json,
    path,
    regexPrefilter: values["prefilter-off"].includes(name) ? false : undefined,
  };
});
for (const name of values["prefilter-off"])
  assert.ok(
    engines.some((engine) => engine.name === name),
    `Unknown --prefilter-off engine ${name}`,
  );
assert.ok(engines.length >= 2, "Pass at least two --engine values");
const list = (value) => value.split(",").filter(Boolean);

if (values.worker === undefined) await parent();
else await worker(Number(values.worker));

async function worker(seed) {
  const require = createRequire(import.meta.url);
  const loaded = engines.map((engine) => {
    const native = require(engine.path);
    const encode = (value) => (engine.json ? JSON.stringify(value) : value);
    const decode = (value) => (engine.json ? JSON.parse(value) : value);
    const highlighter = native.createHighlighter(
      encode({
        standardAssetRoot: fileURLToPath(new URL("../ferriki/assets/shiki", import.meta.url)),
        assets: { remote: false, cacheDir: TEST_ASSET_CACHE_DIR },
        ...(engine.regexPrefilter === false ? { regexPrefilter: false } : {}),
      }),
    );
    highlighter.loadStandardTheme("github-dark");
    highlighter.loadStandardTheme("github-light");
    return { ...engine, encode, decode, highlighter };
  });
  const cases = [];
  try {
    for (const corpus of list(values.corpora)) {
      for (const language of loadCorpus(corpus).languages.filter(
        (entry) =>
          entry.file && (!values.languages || list(values.languages).includes(entry.textmate)),
      )) {
        for (const engine of loaded) engine.highlighter.loadStandardGrammar(language.textmate);
        for (const entry of loadCases(language, list(values.sizes), corpus)) {
          for (const themes of list(values.themes)) {
            const multi = themes === "multi";
            const options = {
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
            };
            const calls = loaded.map((engine) => {
              const encoded = engine.encode(options);
              const highlighter = engine.highlighter;
              // `html` measures the native renderer, which returns a string.
              if (themes === "html") return () => highlighter.codeToHtml(entry.code, encoded);
              return multi
                ? () => engine.decode(highlighter.getHtmlRenderDataWithThemes(entry.code, encoded))
                : () => engine.decode(highlighter.getHtmlRenderData(entry.code, encoded));
            });
            // Every engine must produce the same JSON-visible result.
            const hashes = calls.map((call) => sha256(JSON.stringify(call())));
            for (const hash of hashes) assert.equal(hash, hashes[0], "Engine outputs differ");
            for (let i = 0; i < Number(values.warmups); i++) for (const call of calls) call();
            const samples = loaded.map(() => []);
            for (let round = 0; round < Number(values.rounds); round++) {
              for (let k = 0; k < calls.length; k++) {
                const index = (round + seed + k) % calls.length;
                const started = performance.now();
                calls[index]();
                samples[index].push(performance.now() - started);
              }
            }
            cases.push({
              id: `${corpus}/${language.textmate}/${entry.size}/${themes}`,
              outputSha256: hashes[0],
              samplesMs: Object.fromEntries(loaded.map((engine, i) => [engine.name, samples[i]])),
            });
          }
        }
      }
    }
  } finally {
    for (const engine of loaded) engine.highlighter.dispose();
  }
  process.stdout.write(JSON.stringify({ seed, cases }));
}

async function parent() {
  const processes = Number(values.processes);
  const runs = [];
  for (let seed = 0; seed < processes; seed++) {
    const args = [fileURLToPath(import.meta.url), ...process.argv.slice(2), "--worker", `${seed}`];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, `Worker ${seed} failed`);
    runs.push(JSON.parse(output));
    console.error(`[paired] process ${seed + 1}/${processes} done`);
  }
  const [base, ...candidates] = engines.map((engine) => engine.name);
  const median = (samples) => quantile(samples, 0.5);
  const geomean = (ratios) => Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length);
  const groups = new Map();
  for (const entry of runs[0].cases) {
    const group = entry.id
      .split("/")
      .filter((_, i) => i !== 1)
      .join("/");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry.id);
  }
  const summary = {};
  for (const candidate of candidates) {
    summary[candidate] = {};
    for (const [group, ids] of [["all", runs[0].cases.map((c) => c.id)], ...groups]) {
      // One geometric mean of per-case median ratios per independent process.
      const perProcess = runs.map((run) => {
        const byId = new Map(run.cases.map((entry) => [entry.id, entry]));
        return geomean(
          ids.map((id) => {
            const entry = byId.get(id);
            return median(entry.samplesMs[candidate]) / median(entry.samplesMs[base]);
          }),
        );
      });
      const pooled = (name) =>
        ids.reduce(
          (sum, id) =>
            sum + median(runs.flatMap((run) => run.cases.find((c) => c.id === id).samplesMs[name])),
          0,
        );
      summary[candidate][group] = {
        cases: ids.length,
        geomeanChangePerProcess: perProcess.map((ratio) => ratio - 1),
        geomeanChangeMedian: quantile(perProcess, 0.5) - 1,
        geomeanChangeMin: Math.min(...perProcess) - 1,
        geomeanChangeMax: Math.max(...perProcess) - 1,
        sumOfMediansMs: { [base]: pooled(base), [candidate]: pooled(candidate) },
      };
    }
  }
  for (const run of runs.slice(1))
    for (const [i, entry] of run.cases.entries())
      assert.equal(entry.outputSha256, runs[0].cases[i].outputSha256, "Outputs differ across runs");
  const report = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    options: { ...values, engine: undefined },
    engines: engines.map((engine) => ({
      ...engine,
      bytes: statSync(engine.path).size,
      sha256: sha256(readFileSync(engine.path)),
    })),
    summary,
    runs,
  };
  if (values.write) writeFileSync(values.write, `${JSON.stringify(report)}\n`);
  const percent = (value) => `${(value * 100).toFixed(2)}%`;
  for (const [candidate, groupsSummary] of Object.entries(summary)) {
    console.log(`\n${candidate} vs ${base}`);
    for (const [group, entry] of Object.entries(groupsSummary))
      console.log(
        `${group.padEnd(24)} geomean ${percent(entry.geomeanChangeMedian).padStart(8)} [${percent(entry.geomeanChangeMin)}, ${percent(entry.geomeanChangeMax)}]  sum ${entry.sumOfMediansMs[base].toFixed(2)} -> ${entry.sumOfMediansMs[candidate].toFixed(2)} ms`,
      );
  }
}
