// Publish compact website data from the preserved, checksummed measurements.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { validateReport } from "../node/scripts/run-blacksmith-comparison.mjs";

const root = new URL("../", import.meta.url);
const archive = "docs/benchmarks/blacksmith/2026-10-10";
const check = process.argv.includes("--check");
const profiles = [];
const json = (bytes) => JSON.parse(bytes.toString("utf8"));
const read = (path) => readFileSync(new URL(path, root));
const outputs = new Map();

for (const id of ["linux-x86-64", "macos-arm64"]) {
  const directory = `${archive}/${id}/`;
  const original = new Map();
  for (const line of read(`${directory}ORIGINAL_SHA256SUMS`).toString("utf8").trim().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match, "Invalid artifact checksum record");
    const [, expected, path] = match;
    assert.ok(!path.startsWith("/") && !path.split("/").includes(".."));
    const url = new URL(`${directory}${path}`, root);
    const bytes = existsSync(url)
      ? readFileSync(url)
      : gunzipSync(readFileSync(`${fileURLToPath(url)}.gz`));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected,
      `Artifact changed: ${id}/${path}`,
    );
    original.set(path, bytes);
  }
  const context = json(original.get("context.json"));
  assert.equal(json(original.get("validation.json")).ok, true);
  assert.equal(context.profile, id);
  assert.equal(context.platform, id === "macos-arm64" ? "darwin-arm64" : "linux-x64");
  assert.equal(context.status, "");
  assert.equal(context.nativeBuild.ferriki.status, "");
  assert.equal(context.nativeBuild.ferriki.commit, context.commit);
  const reports = {};
  for (const corpus of ["comparison", "curated", "tiobe"]) {
    for (const mode of ["on", "off"]) {
      const report = json(original.get(`${corpus}-${mode}.json`));
      validateReport(report, corpus, mode === "on");
      if (corpus === "comparison") {
        assert.equal(report.source.revision, context.commit);
        assert.equal(report.source.workingTreeClean, true);
      } else {
        assert.equal(report.revision.commit, context.commit);
        assert.equal(report.revision.status, "");
        assert.equal(report.nativeBuild.binarySha256, context.nativeBuild.binarySha256);
      }
      reports[`${corpus}-${mode}`] = report;
    }
  }
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
    ferroni: context.nativeBuild.ferroni.version,
    rustc: context.rustc.split("\n")[0],
    nativeBinarySha256: context.nativeBuild.binarySha256,
    archive: directory,
    warm: { on: on.warmTotalMs.codeToHtml, off: off.warmTotalMs.codeToHtml },
    cold: {
      on: Object.fromEntries(Object.entries(on.cold).map(([id, value]) => [id, value.medianMs])),
      off: Object.fromEntries(Object.entries(off.cold).map(([id, value]) => [id, value.medianMs])),
    },
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
    archive: directory,
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
  measured: "2026-10-10",
  runUrl: "https://github.com/sebastian-software/ferriki/actions/runs/38043610857",
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
