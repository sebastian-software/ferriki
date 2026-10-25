import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { digest, memoryEngines, memoryModeEngines, memoryScenarios } from "./memory-workloads.mjs";
import {
  memorySummary,
  validateMemoryContext,
  validateMemoryReport,
} from "./run-blacksmith-memory.mjs";

export function readMemoryEvidence(directory) {
  const original = new Map();
  for (const line of readFileSync(join(directory, "SHA256SUMS"), "utf8").trim().split("\n")) {
    const match = /^([a-f0-9]{64}) {2}([a-zA-Z0-9.-]+)$/.exec(line);
    assert.ok(match, "Invalid memory artifact checksum record");
    const [, expected, name] = match;
    assert.ok(!original.has(name), "Duplicate artifact checksum");
    const bytes = readFileSync(join(directory, name));
    assert.equal(digest(bytes), expected, `Memory artifact changed: ${name}`);
    original.set(name, bytes);
  }
  const json = (name) => {
    assert.ok(original.has(name), `Missing original ${name}`);
    return JSON.parse(original.get(name).toString("utf8"));
  };
  assert.deepEqual(json("validation.json"), { ok: true, errors: [] }, "Failed memory capture");
  const context = json("context.json");
  const report = json("memory.json");
  const measuredEngines = report.schemaVersion === 2 ? memoryModeEngines : memoryEngines;
  validateMemoryContext(context);
  validateMemoryReport(report);
  assert.deepEqual(context.regexModes, report.method.regexModes, "Memory policy metadata differs");
  for (const value of [context.commit, context.tree]) assert.match(value, /^[a-f0-9]{40}$/);
  for (const value of [context.binarySha256, context.cargoLockSha256, context.pnpmLockSha256])
    assert.match(value, /^[a-f0-9]{64}$/);
  assert.match(context.comparators.shiki, /^\d+\.\d+\.\d+$/);
  const expectedNames = new Set(["context.json", "memory.json", "validation.json", "summary.md"]);
  for (const scenario of report.scenarios) {
    for (const engine of measuredEngines) {
      const name = `${scenario.id}-validate-${engine}-0`;
      const value = json(`${name}.json`);
      assert.equal(value.engine, engine);
      assert.deepEqual(value.workload, scenario.workload);
      assert.deepEqual(value.outputs, scenario.validation[engine]);
      assert.equal(
        value.nativeBinarySha256,
        engine.startsWith("ferriki") ? context.binarySha256 : null,
      );
      expectedNames.add(`${name}.json`);
      expectedNames.add(`${name}.stderr.log`);
    }
    for (const { repetition, ...sample } of scenario.samples) {
      const name = `${scenario.id}-measure-${sample.engine}-${repetition}`;
      assert.deepEqual(
        json(`${name}.json`),
        sample,
        "Combined memory sample differs from its worker",
      );
      assert.equal(
        sample.nativeBinarySha256,
        sample.engine.startsWith("ferriki") ? context.binarySha256 : null,
      );
      expectedNames.add(`${name}.json`);
      expectedNames.add(`${name}.stderr.log`);
    }
  }
  assert.deepEqual(
    [...original.keys()].sort(),
    [...expectedNames].sort(),
    "Incomplete memory artifact",
  );
  assert.deepEqual(
    report.scenarios.map((scenario) => scenario.id),
    memoryScenarios,
  );
  assert.equal(original.get("summary.md").toString("utf8"), memorySummary(report, context));
  return { original, context, report };
}
