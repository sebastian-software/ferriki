import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { test } from "node:test";
import { rotate } from "./benchmark-schedule.mjs";
import {
  memoryEngines,
  memoryRepetitions,
  memoryScenarios,
  memoryWorkload,
  workloadIdentity,
} from "./memory-workloads.mjs";
import {
  memoryMethod,
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
