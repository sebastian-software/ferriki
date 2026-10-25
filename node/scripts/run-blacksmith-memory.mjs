import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { rotate } from "./benchmark-schedule.mjs";
import { installedComparators } from "./check-benchmark-versions.mjs";
import {
  digest,
  memoryEngines,
  memoryModeEngines,
  memoryRepetitions,
  memoryRoot,
  memoryScenarios,
  memoryTheme,
  memoryWorkload,
  workloadIdentity,
} from "./memory-workloads.mjs";

import { regexModeLabels, regexModes, validateRegexDiagnostics } from "./regex-benchmark-modes.mjs";

const nodeRoot = join(memoryRoot, "node");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const snapshotFields = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers", "maxRssBytes"];
export const memoryMethod = {
  repetitions: memoryRepetitions,
  theme: memoryTheme,
  regexPrefilter: true,
  excludedRepositoryLanguages: {
    yaml: "Shiki/JS cannot translate the current multi-codepoint hex escape.",
    sql: "Shiki/JS differs from native/WASM on the SQL fixture in a fresh isolated process. Excluded from every engine in this shared memory cohort.",
  },
  engineOrder:
    "Serial fresh processes; rotate engines once per repetition, separately per scenario.",
  baseline: "Inputs loaded; two explicit V8 collections before engine-specific imports.",
  checkpoints:
    "After initialization and passes 1/10/50 (repository) or 1/5/10 (large TypeScript). Two explicit V8 collections at each checkpoint; no forced GC between documents.",
  output:
    "Consume UTF-8 HTML byte length and discard each result. Exact HTML SHA-256 agreement is checked in separate validation processes before measuring.",
  peak: "OS process-lifetime high-water RSS through the final render checkpoint, in bytes (Node maxRSS KiB multiplied by 1024). Includes startup, inputs, imports, setup, rendering and explicit GC; no baseline subtraction.",
  limits:
    "RSS includes the Node runtime, native code, WASM and allocator retention. V8 heap/external/ArrayBuffer fields are diagnostic subsets, not native allocation counters. Forced GC does not force native allocators or WASM to return pages to the OS. Fixed sequential workloads are not a leak, concurrency or capacity test. Compare within a host, not across operating systems.",
};

export const memoryModeMethod = {
  ...Object.fromEntries(Object.entries(memoryMethod).filter(([key]) => key !== "regexPrefilter")),
  regexModes,
};
const reportEngines = (report) => (report.schemaVersion === 2 ? memoryModeEngines : memoryEngines);

function checkSnapshot(snapshot) {
  assert.deepEqual(Object.keys(snapshot).sort(), [...snapshotFields].sort());
  for (const key of snapshotFields)
    assert.ok(Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0, `Invalid ${key}`);
  assert.ok(snapshot.rss > 0 && snapshot.maxRssBytes > 0, "Missing OS RSS measurement");
}

export function validateMemorySample(sample, scenario, engine, identity, bytesPerPass) {
  assert.equal(sample.engine, engine);
  assert.equal(identity.id, scenario);
  assert.deepEqual(sample.workload, identity, "Worker inputs changed");
  assert.deepEqual(Object.keys(sample.phases).sort(), ["baseline", "disposed", "initialized"]);
  for (const snapshot of Object.values(sample.phases)) checkSnapshot(snapshot);
  assert.deepEqual(
    sample.checkpoints.map((point) => point.passes),
    identity.checkpoints,
  );
  let peak = sample.phases.initialized.maxRssBytes;
  for (const point of sample.checkpoints) {
    checkSnapshot(point.beforeGc);
    checkSnapshot(point.afterGc);
    assert.equal(point.outputBytes, bytesPerPass * point.passes, "Rendered output size changed");
    for (const snapshot of [point.beforeGc, point.afterGc]) {
      assert.ok(snapshot.maxRssBytes >= peak, "Process peak decreased");
      peak = snapshot.maxRssBytes;
    }
  }
}

export function validateMemoryReport(report) {
  assert.ok([1, 2].includes(report.schemaVersion));
  assert.deepEqual(report.method, report.schemaVersion === 2 ? memoryModeMethod : memoryMethod);
  const measuredEngines = reportEngines(report);
  assert.deepEqual(
    report.scenarios.map((scenario) => scenario.id),
    memoryScenarios,
  );
  for (const scenario of report.scenarios) {
    const identity = scenario.workload;
    assert.equal(identity.id, scenario.id);
    assert.deepEqual(identity.checkpoints, scenario.id === "repository" ? [1, 10, 50] : [1, 5, 10]);
    assert.equal(identity.documents.length, scenario.id === "repository" ? 12 : 1);
    for (const doc of identity.documents) {
      assert.match(doc.sha256, /^[a-f0-9]{64}$/);
      assert.ok(doc.bytes > 0 && doc.copies >= 1);
    }
    assert.deepEqual(Object.keys(scenario.validation), measuredEngines);
    const reference = scenario.validation["shiki-wasm"];
    assert.deepEqual(
      reference.map((row) => row.path),
      identity.documents.map((doc) => doc.path),
    );
    for (const row of reference) {
      assert.match(row.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0);
    }
    for (const engine of measuredEngines)
      assert.deepEqual(scenario.validation[engine], reference, `${engine}: HTML mismatch`);
    const bytesPerPass = reference.reduce((total, row) => total + row.bytes, 0);
    assert.equal(scenario.samples.length, measuredEngines.length * memoryRepetitions);
    for (let repeat = 0; repeat < memoryRepetitions; repeat++) {
      for (const [index, engine] of rotate(measuredEngines, repeat).entries()) {
        const sample = scenario.samples[repeat * measuredEngines.length + index];
        assert.equal(sample.repetition, repeat + 1);
        validateMemorySample(sample, scenario.id, engine, identity, bytesPerPass);
        if (report.schemaVersion === 2 && Object.hasOwn(regexModes, engine))
          validateRegexDiagnostics(
            sample.regexDiagnostics,
            regexModes[engine],
            regexModes[engine] === "prepared",
          );
      }
    }
  }
}

export function validateMemoryContext(context) {
  assert.equal(context.status, "", "Dirty benchmark checkout");
  assert.equal(context.nativeBuild.ferriki.status, "", "Dirty native build");
  assert.equal(context.nativeBuild.ferriki.commit, context.commit, "Stale native build");
  assert.equal(context.nativeBuild.binarySha256, context.binarySha256, "Native binary changed");
  assert.equal(context.nativeBuild.cargoLockSha256, context.cargoLockSha256);
  assert.equal(context.nodeOptions, "", "Uncontrolled NODE_OPTIONS");
}

const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: (sorted[2] + sorted[3]) / 2, max: sorted.at(-1) };
};

export function summarizeMemory(report) {
  validateMemoryReport(report);
  return report.scenarios.map((scenario) => ({
    id: scenario.id,
    documents: scenario.workload.documents.length,
    inputBytes: scenario.workload.documents.reduce((total, doc) => total + doc.bytes, 0),
    passes: scenario.workload.checkpoints.at(-1),
    engines: Object.fromEntries(
      reportEngines(report).map((engine) => {
        const samples = scenario.samples.filter((sample) => sample.engine === engine);
        return [
          engine,
          {
            baselineRss: distribution(samples.map((sample) => sample.phases.baseline.rss)),
            initializedRss: distribution(samples.map((sample) => sample.phases.initialized.rss)),
            finalRss: distribution(samples.map((sample) => sample.checkpoints.at(-1).afterGc.rss)),
            peakRss: distribution(
              samples.map((sample) => sample.checkpoints.at(-1).afterGc.maxRssBytes),
            ),
            checkpoints: scenario.workload.checkpoints.map((passes, index) => ({
              passes,
              rss: distribution(samples.map((sample) => sample.checkpoints[index].afterGc.rss)),
            })),
          },
        ];
      }),
    ),
  }));
}

export function memorySummary(report, context) {
  const lines = [
    `# Blacksmith process memory: ${context.profile}`,
    "",
    `Commit: ${context.commit}. Runner: ${context.runnerLabel}. Node: ${context.node}.`,
    "",
    "Six fresh processes per engine and scenario. MiB (2^20 bytes); median [min–max]. Absolute whole-process RSS, including Node, Rust and WASM. Lower uses less resident memory. Peak includes startup through the last render checkpoint. Exact HTML agreement passed before measurement.",
    "",
    "| Scenario | Engine | Initialized RSS | Final RSS after GC | Peak RSS |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  const format = (value) =>
    `${(value.median / 2 ** 20).toFixed(1)} [${(value.min / 2 ** 20).toFixed(1)}–${(value.max / 2 ** 20).toFixed(1)}]`;
  for (const scenario of summarizeMemory(report))
    for (const [engine, metrics] of Object.entries(scenario.engines))
      lines.push(
        `| ${scenario.id} | ${report.schemaVersion === 2 ? regexModeLabels[engine] : engine} | ${format(metrics.initializedRss)} | ${format(metrics.finalRss)} | ${format(metrics.peakRss)} |`,
      );
  lines.push(
    "",
    memoryMethod.limits,
    "",
    "See memory.json for baseline, every checkpoint, V8 diagnostic fields, output validation and individual samples.",
    "",
  );
  return lines.join("\n");
}

function run(directory, measureRegexModes = false) {
  const measuredEngines = measureRegexModes ? memoryModeEngines : memoryEngines;
  mkdirSync(directory, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: memoryRoot, encoding: "utf8" }).trim();
  const context = {
    measuredAt: new Date().toISOString(),
    ...(measureRegexModes ? { regexModes } : {}),
    profile: process.env.PROFILE ?? `${process.platform}-${process.arch}`,
    runnerLabel: process.env.RUNNER_LABEL ?? "local",
    runUrl: process.env.COMPARISON_RUN_URL ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    status: git("status", "--porcelain"),
    cpu: os.cpus()[0]?.model,
    cores: os.availableParallelism(),
    platform: `${process.platform}-${process.arch}`,
    os: `${os.type()} ${os.release()}`,
    memoryBytes: os.totalmem(),
    node: process.version,
    nodeOptions: process.env.NODE_OPTIONS ?? "",
    comparators: installedComparators(),
    ferriki: read(join(nodeRoot, "ferriki/package.json")).version,
    nativeBuild: read(join(nodeRoot, "ferriki/.benchmark-build.json")),
    binarySha256: digest(readFileSync(join(nodeRoot, "ferriki/ferriki.node"))),
    cargoLockSha256: digest(readFileSync(join(memoryRoot, "Cargo.lock"))),
    pnpmLockSha256: digest(readFileSync(join(nodeRoot, "pnpm-lock.yaml"))),
  };
  writeFileSync(join(directory, "context.json"), `${JSON.stringify(context, null, 2)}\n`);
  const errors = [];
  try {
    validateMemoryContext(context);
    const worker = (engine, scenario, mode, repetition) => {
      const child = spawnSync(
        process.execPath,
        ["--expose-gc", "scripts/bench-memory-worker.mjs", engine, scenario, mode],
        { cwd: nodeRoot, encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
      );
      const name = `${scenario}-${mode}-${engine}-${repetition ?? 0}`;
      writeFileSync(join(directory, `${name}.stderr.log`), child.stderr ?? "");
      writeFileSync(join(directory, `${name}.json`), child.stdout ?? "");
      assert.equal(child.status, 0, `${name}: ${child.error?.message ?? child.stderr}`);
      const result = JSON.parse(child.stdout);
      assert.equal(
        result.nativeBinarySha256,
        Object.hasOwn(regexModes, engine) ? context.binarySha256 : null,
        "Loaded addon differs from its build receipt",
      );
      return result;
    };
    const report = {
      schemaVersion: measureRegexModes ? 2 : 1,
      method: measureRegexModes ? memoryModeMethod : memoryMethod,
      scenarios: [],
    };
    for (const scenario of memoryScenarios) {
      const identity = workloadIdentity(memoryWorkload(scenario));
      const validation = {};
      for (const engine of measuredEngines) {
        const result = worker(engine, scenario, "validate");
        assert.equal(result.engine, engine);
        assert.deepEqual(result.workload, identity);
        validation[engine] = result.outputs;
      }
      for (const engine of measuredEngines)
        assert.deepEqual(validation[engine], validation["shiki-wasm"], `${engine}: HTML mismatch`);
      const samples = [];
      for (let repeat = 0; repeat < memoryRepetitions; repeat++) {
        for (const engine of rotate(measuredEngines, repeat)) {
          console.log(`[Memory] ${scenario} / ${repeat + 1} / ${engine}`);
          const result = worker(engine, scenario, "measure", repeat + 1);
          samples.push({ repetition: repeat + 1, ...result });
        }
      }
      report.scenarios.push({ id: scenario, workload: identity, validation, samples });
    }
    validateMemoryReport(report);
    writeFileSync(join(directory, "memory.json"), `${JSON.stringify(report, null, 2)}\n`);
    const summary = memorySummary(report, context);
    writeFileSync(join(directory, "summary.md"), summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch (error) {
    errors.push(error.stack);
    process.exitCode = 1;
  }
  writeFileSync(
    join(directory, "validation.json"),
    `${JSON.stringify({ ok: !errors.length, errors }, null, 2)}\n`,
  );
  writeFileSync(
    join(directory, "SHA256SUMS"),
    readdirSync(directory)
      .filter((name) => name !== "SHA256SUMS")
      .sort()
      .map((name) => `${digest(readFileSync(join(directory, name)))}  ${name}\n`)
      .join(""),
  );
  if (errors.length) console.error(errors.join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(
    process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === "--regex-modes"),
    "Usage: node scripts/run-blacksmith-memory.mjs OUTPUT [--regex-modes]",
  );
  run(resolve(process.argv[2]), process.argv.includes("--regex-modes"));
}
