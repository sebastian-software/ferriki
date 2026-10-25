// Publish compact website data from the preserved, checksummed measurements.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readShard } from "../node/scripts/merge-blacksmith-comparison.mjs";

const root = new URL("../", import.meta.url);
const archive = "docs/benchmarks/blacksmith/2026-10-24-prepared-eager/timings";
const check = process.argv.includes("--check");
const profiles = [];
const read = (path) => readFileSync(new URL(path, root));
const outputs = new Map();

for (const id of ["linux-x86-64", "macos-arm64"]) {
  const directory = `${archive}/${id}/`;
  const shards = Object.fromEntries(
    ["comparison", "curated", "tiobe"].map((corpus) => {
      const shard = readShard(fileURLToPath(new URL(`${directory}${corpus}/`, root)));
      assert.equal(shard.corpus, corpus);
      assert.equal(shard.context.profile, id);
      assert.equal(shard.context.platform, id === "macos-arm64" ? "darwin-arm64" : "linux-x64");
      return [corpus, shard];
    }),
  );
  const context = shards.comparison.context;
  // Each table compares engines within its original VM. Keep heterogeneous
  // corpus machines explicit; this does not create a successful merged CI artifact.
  for (const { context: other } of Object.values(shards)) {
    for (const key of [
      "commit",
      "tree",
      "node",
      "rustc",
      "cargoLockSha256",
      "pnpmLockSha256",
      "comparators",
    ])
      assert.deepEqual(other[key], context[key], `Different corpus ${key}`);
    for (const key of [
      "rustSourceSha256",
      "rustflags",
      "encodedRustflags",
      "targetRustflags",
      "cargoProfileEnv",
    ])
      assert.deepEqual(other.nativeBuild[key], context.nativeBuild[key], `Different build ${key}`);
    for (const key of ["version", "source", "features", "revision", "sourceSha256"])
      assert.deepEqual(
        other.nativeBuild.ferroni[key],
        context.nativeBuild.ferroni[key],
        `Different Ferroni ${key}`,
      );
  }
  const reports = Object.assign({}, ...Object.values(shards).map((shard) => shard.reports));
  const on = reports["comparison-on"];
  const off = reports["comparison-off"];
  assert.deepEqual(
    on.warm.codeToHtml.map((row) => row.sha256),
    off.warm.codeToHtml.map((row) => row.sha256),
  );
  const summary = {
    id,
    label: id === "macos-arm64" ? "macOS ARM64" : "Linux x86-64",
    runner: context.runnerLabel,
    machine: on.machine,
    revision: context.commit,
    ferriki: on.versions.ferriki,
    ferroni: context.nativeBuild.ferroni.version,
    rustc: context.rustc.split("\n")[0],
    nativeBinarySha256: context.nativeBuild.binarySha256,
    archive: directory,
    corpusMachines: Object.fromEntries(
      Object.entries(shards).map(([corpus, shard]) => [
        corpus,
        {
          cpu: shard.context.cpu,
          os: shard.context.os,
          nativeBinarySha256: shard.context.nativeBuild.binarySha256,
          archive: `${directory}${corpus}/`,
        },
      ]),
    ),
    warm: { on: on.warmTotalMs.codeToHtml, off: off.warmTotalMs.codeToHtml },
    cold: {
      on: Object.fromEntries(Object.entries(on.cold).map(([id, value]) => [id, value.medianMs])),
      off: Object.fromEntries(Object.entries(off.cold).map(([id, value]) => [id, value.medianMs])),
    },
    workloads: ["curated", "tiobe"].flatMap((corpus) =>
      reports[`${corpus}-on`].languages.flatMap((language) =>
        (language.cases ?? []).map((entry) => ({
          corpus,
          language: language.name,
          size: entry.size,
          bytes: entry.bytes,
          sha256: entry.sha256,
          timings: Object.fromEntries(
            Object.entries(entry.results)
              .filter(([, result]) => result.html)
              .map(([id, result]) => [id, result.html.medianMs]),
          ),
        })),
      ),
    ),
    jsonAstro: reports["curated-on"].languages
      .filter((row) => ["JSON", "Astro"].includes(row.name))
      .flatMap((row) =>
        row.cases.map((entry) => {
          const other = reports["curated-off"].languages
            .find((candidate) => candidate.name === row.name)
            .cases.find((candidate) => candidate.size === entry.size);
          assert.equal(entry.sha256, other.sha256);
          const timings = (value) =>
            Object.fromEntries(
              Object.entries(value.results)
                .filter(([, result]) => result.html)
                .map(([id, result]) => [id, result.html.medianMs]),
            );
          return {
            language: row.name,
            size: entry.size,
            bytes: entry.bytes,
            sha256: entry.sha256,
            on: timings(entry),
            off: timings(other),
          };
        }),
      ),
  };
  profiles.push(summary);
  const compact = JSON.parse(
    JSON.stringify(on, (key, value) => (key === "samplesMs" ? undefined : value)),
  );
  compact.evidence = {
    profile: id,
    runUrl: context.runUrl,
    ferroni: summary.ferroni,
    archive: `${directory}comparison/`,
  };
  outputs.set(
    id === "linux-x86-64"
      ? "docs/benchmarks/shiki-comparison.json"
      : "docs/benchmarks/shiki-comparison-macos.json",
    compact,
  );
}
assert.equal(profiles[0].revision, profiles[1].revision);
assert.equal(profiles[0].ferroni, profiles[1].ferroni);
outputs.set("docs/benchmarks/blacksmith-comparison.json", {
  measured: "2026-10-24",
  runUrl: "https://github.com/sebastian-software/ferriki/actions/runs/40135588303",
  corpusDocuments: 14,
  profiles,
});
for (const [path, report] of outputs) {
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  if (check)
    assert.equal(
      read(path).toString("utf8"),
      contents,
      `Regenerate ${path}: node scripts/publish-blacksmith-evidence.mjs`,
    );
  else writeFileSync(new URL(path, root), contents);
}
// The authored README owns its wording; check its repeated headline figures.
if (check) {
  for (const path of ["README.md.src", "node/ferriki/README.md"]) {
    const text = read(path).toString("utf8");
    for (const profile of profiles) {
      const factor = `${(profile.warm.on["shiki-wasm"] / profile.warm.on.ferriki).toFixed(1)}×`;
      assert.ok(
        text.includes(factor),
        `${path} must state the current ${profile.label} factor (${factor})`,
      );
    }
  }
}
console.log(
  `${check ? "Verified" : "Published"} two profiles from twelve checksummed Blacksmith reports.`,
);
