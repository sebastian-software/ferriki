// Keep the four native paths visible without rewriting historical captures.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMemoryEvidence } from "../node/scripts/memory-evidence.mjs";
import { readShard } from "../node/scripts/merge-blacksmith-comparison.mjs";
import {
  regexModeEngines,
  regexModeLabels,
  regexModes,
} from "../node/scripts/regex-benchmark-modes.mjs";
import { summarizeMemory } from "../node/scripts/run-blacksmith-memory.mjs";

const root = new URL("../", import.meta.url);
const archive = "docs/benchmarks/blacksmith/2026-10-27-ferroni-2.8";
const read = (path) => readFileSync(new URL(path, root), "utf8");
const capture = JSON.parse(read(`${archive}/capture.json`));
const profiles = [];
for (const id of ["linux-x86-64", "macos-arm64"]) {
  const shards = Object.fromEntries(
    ["comparison", "curated", "tiobe"].map((corpus) => {
      const shard = readShard(fileURLToPath(new URL(`${archive}/timings/${id}/${corpus}/`, root)));
      assert.equal(shard.corpus, corpus);
      assert.equal(shard.context.profile, id);
      assert.equal(shard.context.commit, capture.commit);
      assert.equal(shard.context.runUrl, capture.runUrl);
      assert.equal(shard.context.nativeBuild.ferroni.version, capture.ferroni);
      assert.deepEqual(shard.context.regexModes, regexModes);
      return [corpus, shard];
    }),
  );
  const reference = shards.comparison.context;
  for (const { context } of Object.values(shards)) {
    for (const key of ["tree", "node", "rustc", "cargoLockSha256", "pnpmLockSha256", "comparators"])
      assert.deepEqual(context[key], reference[key], `Different capture ${key}`);
    for (const key of [
      "rustSourceSha256",
      "ferroni",
      "rustflags",
      "encodedRustflags",
      "targetRustflags",
      "cargoProfileEnv",
    ])
      assert.deepEqual(
        context.nativeBuild[key],
        reference.nativeBuild[key],
        `Different native ${key}`,
      );
  }
  const repository = shards.comparison.reports["comparison-modes"];
  const memory = readMemoryEvidence(fileURLToPath(new URL(`${archive}/memory/${id}/`, root)));
  assert.equal(memory.context.commit, capture.commit);
  assert.equal(memory.context.runUrl, capture.runUrl);
  assert.equal(memory.context.profile, id);
  assert.equal(memory.context.nativeBuild.ferroni.version, capture.ferroni);
  assert.equal(memory.context.nativeBuild.rustSourceSha256, reference.nativeBuild.rustSourceSha256);
  profiles.push({
    id,
    label: id === "macos-arm64" ? "macOS ARM64" : "Linux x86-64",
    corpusMachines: Object.fromEntries(
      Object.entries(shards).map(([corpus, { context }]) => [
        corpus,
        { cpu: context.cpu, os: context.os, binarySha256: context.nativeBuild.binarySha256 },
      ]),
    ),
    warm: repository.warmTotalMs.codeToHtml,
    cold: Object.fromEntries(
      Object.entries(repository.cold)
        .filter(([, value]) => Number.isFinite(value.medianMs))
        .map(([engine, value]) => [engine, value.medianMs]),
    ),
    workloads: ["curated", "tiobe"].flatMap((corpus) =>
      shards[corpus].reports[`${corpus}-modes`].languages.flatMap((language) =>
        (language.cases ?? []).map((entry) => ({
          corpus,
          language: language.name,
          size: entry.size,
          sha256: entry.sha256,
          timings: Object.fromEntries(
            Object.entries(entry.results)
              .filter(([, result]) => result.html)
              .map(([engine, result]) => [engine, result.html.medianMs]),
          ),
        })),
      ),
    ),
    memory: { cpu: memory.context.cpu, scenarios: summarizeMemory(memory.report) },
  });
}
const report = {
  ...capture,
  archive,
  engines: regexModeEngines.map((id) => ({ id, label: regexModeLabels[id] })),
  profiles,
};
const path = "docs/benchmarks/regex-modes-comparison.json";
const contents = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes("--check")) assert.equal(read(path), contents, `Regenerate ${path}`);
else writeFileSync(new URL(path, root), contents);
if (process.argv.includes("--check")) {
  for (const path of ["README.md.src", "node/ferriki/README.md"]) {
    for (const profile of profiles) {
      const factor = `${(profile.warm["shiki-wasm"] / profile.warm["ferriki-precompiled"]).toFixed(1)}×`;
      assert.ok(read(path).includes(factor), `${path}: stale ${profile.label} factor (${factor})`);
    }
    for (const scenario of ["repository", "large-typescript"]) {
      const changes = profiles
        .map((profile) => {
          const { engines } = profile.memory.scenarios.find((value) => value.id === scenario);
          return Math.round(
            100 *
              (1 -
                engines["ferriki-precompiled"].finalRss.median /
                  engines["shiki-wasm"].finalRss.median),
          );
        })
        .sort((a, b) => a - b);
      assert.ok(
        changes.every((value) => value > 0),
        "Update host-specific memory claims",
      );
      const range = changes[0] === changes[1] ? `${changes[0]}%` : `${changes[0]}–${changes[1]}%`;
      assert.ok(read(path).includes(`${range} lower`), `${path}: stale ${scenario} RSS claim`);
    }
  }
}
console.log(
  "Verified separate regex modes: six timing shards, two memory captures, all original samples and HTML gates.",
);
