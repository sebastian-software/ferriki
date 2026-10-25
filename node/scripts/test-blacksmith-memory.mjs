import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { rotate } from "./benchmark-schedule.mjs";
import { readMemoryEvidence } from "./memory-evidence.mjs";
import {
  digest,
  memoryEngines,
  memoryModeEngines,
  memoryRepetitions,
  memoryScenarios,
  memoryWorkload,
  workloadIdentity,
} from "./memory-workloads.mjs";
import { regexModes } from "./regex-benchmark-modes.mjs";
import {
  memoryMethod,
  memoryModeMethod,
  memorySummary,
  summarizeMemory,
  validateMemoryContext,
  validateMemoryReport,
  validateMemorySample,
} from "./run-blacksmith-memory.mjs";

function fixture() {
  const snapshot = {
    rss: 100,
    heapTotal: 50,
    heapUsed: 30,
    external: 10,
    arrayBuffers: 5,
    maxRssBytes: 200,
  };
  return {
    schemaVersion: 1,
    method: structuredClone(memoryMethod),
    scenarios: memoryScenarios.map((id) => {
      const workload = workloadIdentity(memoryWorkload(id));
      const outputs = workload.documents.map((doc) => ({
        path: doc.path,
        sha256: "a".repeat(64),
        bytes: 1000,
      }));
      return {
        id,
        workload,
        validation: Object.fromEntries(
          memoryEngines.map((engine) => [engine, structuredClone(outputs)]),
        ),
        samples: Array.from({ length: memoryRepetitions }, (_, repeat) =>
          rotate(memoryEngines, repeat).map((engine) => ({
            engine,
            repetition: repeat + 1,
            workload: structuredClone(workload),
            phases: {
              baseline: { ...snapshot },
              initialized: { ...snapshot },
              disposed: { ...snapshot },
            },
            checkpoints: workload.checkpoints.map((passes) => ({
              passes,
              beforeGc: { ...snapshot },
              afterGc: { ...snapshot },
              outputBytes: outputs.length * 1000 * passes,
            })),
          })),
        ).flat(),
      };
    }),
  };
}

test("publication rejects missing processes, changed work, output mismatch and invalid OS counters", () => {
  validateMemoryReport(fixture());
  for (const mutate of [
    (report) => report.scenarios.pop(),
    (report) => report.scenarios[0].samples.pop(),
    (report) => {
      report.scenarios[0].validation.ferriki[0].sha256 = "b".repeat(64);
    },
    (report) => {
      report.scenarios[0].samples[0].engine = "shiki-js";
    },
    (report) => {
      report.scenarios[0].samples[0].workload.documents[0].bytes++;
    },
    (report) => {
      report.scenarios[0].samples[0].checkpoints[0].outputBytes++;
    },
    (report) => {
      report.scenarios[0].samples[0].checkpoints[0].afterGc.rss = 0;
    },
    (report) => {
      report.scenarios[0].samples[0].checkpoints[0].afterGc.maxRssBytes = 1;
    },
    (report) => {
      report.scenarios[0].samples[0].checkpoints[0].afterGc.heapUsed = Number.NaN;
    },
    (report) => {
      report.method.repetitions = 1;
    },
  ]) {
    const report = fixture();
    mutate(report);
    assert.throws(() => validateMemoryReport(report));
  }
});

test("memory mode reports require independent samples and policy evidence for every native mode", () => {
  const report = fixture();
  report.schemaVersion = 2;
  report.method = structuredClone(memoryModeMethod);
  for (const scenario of report.scenarios) {
    const legacy = scenario.samples;
    scenario.validation = Object.fromEntries(
      memoryModeEngines.map((engine) => [
        engine,
        structuredClone(scenario.validation["shiki-wasm"]),
      ]),
    );
    scenario.samples = Array.from({ length: memoryRepetitions }, (_, repeat) =>
      rotate(memoryModeEngines, repeat).map((engine) => {
        const sample = structuredClone(legacy.find((value) => value.repetition === repeat + 1));
        sample.engine = engine;
        const mode = regexModes[engine];
        if (mode)
          sample.regexDiagnostics = {
            mode,
            staticScanners: 1,
            dynamicScanners: 0,
            offScanners: Number(mode === "off"),
            autoScanners: Number(mode === "auto"),
            eagerScanners: Number(["eager", "prepared"].includes(mode)),
            assemblyFallbacks: 0,
            invalidPreparedGroups: 0,
            preparedArchives: Number(mode === "prepared"),
            loadedPreparedGroups: Number(mode === "prepared"),
          };
        return sample;
      }),
    ).flat();
  }
  validateMemoryReport(report);
  assert.equal(Object.keys(summarizeMemory(report)[0].engines).length, 6);
  const invalid = structuredClone(report);
  invalid.scenarios[0].samples.find(
    (sample) => sample.engine === "ferriki-precompiled",
  ).regexDiagnostics.loadedPreparedGroups = 0;
  assert.throws(() => validateMemoryReport(invalid));
  report.scenarios[0].samples.pop();
  assert.throws(() => validateMemoryReport(report));
});

test("archive publication checks every original worker, not only combined report hashes", () => {
  const directory = mkdtempSync(join(os.tmpdir(), "ferriki-memory-evidence-"));
  const report = fixture();
  const binary = "1".repeat(64);
  const context = {
    profile: "test",
    runnerLabel: "local",
    node: process.version,
    status: "",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    binarySha256: binary,
    cargoLockSha256: "2".repeat(64),
    pnpmLockSha256: "3".repeat(64),
    nodeOptions: "",
    comparators: { shiki: "4.5.0" },
    nativeBuild: {
      ferriki: { status: "", commit: "a".repeat(40) },
      binarySha256: binary,
      cargoLockSha256: "2".repeat(64),
    },
  };
  const write = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value));
  const checksums = () =>
    writeFileSync(
      join(directory, "SHA256SUMS"),
      readdirSync(directory)
        .filter((name) => name !== "SHA256SUMS")
        .sort()
        .map((name) => `${digest(readFileSync(join(directory, name)))}  ${name}\n`)
        .join(""),
    );
  try {
    write("context.json", context);
    write("validation.json", { ok: true, errors: [] });
    for (const scenario of report.scenarios) {
      for (const engine of memoryEngines) {
        const name = `${scenario.id}-validate-${engine}-0`;
        write(`${name}.json`, {
          engine,
          workload: scenario.workload,
          outputs: scenario.validation[engine],
          nativeBinarySha256: engine === "ferriki" ? binary : null,
        });
        writeFileSync(join(directory, `${name}.stderr.log`), "");
      }
      for (const sample of scenario.samples) {
        sample.nativeBinarySha256 = sample.engine === "ferriki" ? binary : null;
        const { repetition, ...raw } = sample;
        const name = `${scenario.id}-measure-${sample.engine}-${repetition}`;
        write(`${name}.json`, raw);
        writeFileSync(join(directory, `${name}.stderr.log`), "");
      }
    }
    write("memory.json", report);
    writeFileSync(join(directory, "summary.md"), memorySummary(report, context));
    checksums();
    assert.deepEqual(readMemoryEvidence(directory).report, report);
    writeFileSync(join(directory, "memory.json"), "changed");
    assert.throws(() => readMemoryEvidence(directory), /artifact changed/);
    write("memory.json", report);
    const changed = structuredClone(report);
    changed.scenarios[0].samples[0].phases.initialized.rss++;
    write("memory.json", changed);
    checksums();
    assert.throws(() => readMemoryEvidence(directory), /differs from its worker/);
    write("memory.json", report);
    write("validation.json", { ok: false, errors: ["failed"] });
    checksums();
    assert.throws(() => readMemoryEvidence(directory), /Failed memory capture/);
    writeFileSync(join(directory, "SHA256SUMS"), `${"a".repeat(64)}  ../outside\n`);
    assert.throws(() => readMemoryEvidence(directory), /Invalid memory artifact checksum/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("summaries retain spread over independent processes without subtracting baselines", () => {
  const report = fixture();
  for (const scenario of report.scenarios) {
    for (const sample of scenario.samples) {
      sample.phases.initialized.rss = sample.repetition * 100;
    }
  }
  const [summary] = summarizeMemory(report);
  assert.deepEqual(summary.engines.ferriki.initializedRss, { min: 100, median: 350, max: 600 });
  assert.deepEqual(summary.engines.ferriki.peakRss, { min: 200, median: 200, max: 200 });
});

test("evidence rejects dirty, stale, changed native builds and uncontrolled Node flags", () => {
  const context = {
    status: "",
    commit: "abc",
    binarySha256: "binary",
    cargoLockSha256: "lock",
    nodeOptions: "",
    nativeBuild: {
      ferriki: { status: "", commit: "abc" },
      binarySha256: "binary",
      cargoLockSha256: "lock",
    },
  };
  validateMemoryContext(context);
  for (const mutate of [
    (value) => {
      value.status = " M file";
    },
    (value) => {
      value.nativeBuild.ferriki.status = " M file";
    },
    (value) => {
      value.nativeBuild.ferriki.commit = "old";
    },
    (value) => {
      value.binarySha256 = "changed";
    },
    (value) => {
      value.cargoLockSha256 = "changed";
    },
    (value) => {
      value.nodeOptions = "--jitless";
    },
  ]) {
    const value = structuredClone(context);
    mutate(value);
    assert.throws(() => validateMemoryContext(value));
  }
});

test(
  "real isolated workers agree on repository HTML and consume every measured pass",
  { timeout: 120_000 },
  () => {
    const worker = (engine, mode) => {
      const child = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          new URL("./bench-memory-worker.mjs", import.meta.url).pathname,
          engine,
          "repository",
          mode,
        ],
        {
          encoding: "utf8",
          timeout: 90_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      assert.equal(child.status, 0, child.stderr || child.error?.message);
      return JSON.parse(child.stdout);
    };
    const results = memoryEngines.map((engine) => worker(engine, "validate"));
    for (const result of results) assert.deepEqual(result.outputs, results[0].outputs);
    const sample = worker("ferriki", "measure");
    validateMemorySample(
      sample,
      "repository",
      "ferriki",
      results[0].workload,
      results[0].outputs.reduce((sum, row) => sum + row.bytes, 0),
    );
  },
);
