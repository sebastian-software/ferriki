// Keep decoded-cache timings separate from the earlier memory capture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { gunzipSync } from "node:zlib";
import { validateCorpusProvenance } from "../node/scripts/merge-blacksmith-comparison.mjs";
import {
  regexModeEngines,
  regexModeLabels,
  regexModes,
} from "../node/scripts/regex-benchmark-modes.mjs";
import { validateReport } from "../node/scripts/run-blacksmith-comparison.mjs";

const root = new URL("../", import.meta.url);
const archive = "docs/benchmarks/blacksmith/2026-10-25-shared-storage";
const read = (path) => readFileSync(new URL(path, root));
const capture = JSON.parse(read(`${archive}/capture.json`));
const profiles = [];
for (const id of ["linux-x86-64", "macos-arm64"]) {
  const directory = `${archive}/${id}`;
  const originals = new Map();
  for (const line of read(`${directory}/SHA256SUMS`).toString().trim().split("\n")) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    assert.ok(match, "Invalid checksum record");
    const [, hash, name] = match;
    assert.ok(!name.startsWith("/") && !name.split("/").includes(".."));
    assert.ok(!originals.has(name), "Duplicate artifact");
    const path = `${directory}/${name}`;
    const bytes = existsSync(new URL(path, root)) ? read(path) : gunzipSync(read(`${path}.gz`));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      hash,
      `Changed artifact ${name}`,
    );
    originals.set(name, bytes);
  }
  const json = (name) => JSON.parse(originals.get(name));
  assert.equal(json("validation.json").ok, true);
  const context = json("context.json");
  assert.equal(context.commit, capture.commit);
  assert.equal(context.runUrl, capture.runUrl);
  assert.equal(context.profile, id);
  assert.equal(context.nativeBuild.ferroni.version, capture.ferroni);
  assert.equal(
    context.nativeBuild.ferroni.source,
    "registry+https://github.com/rust-lang/crates.io-index",
  );
  assert.deepEqual(context.regexModes, regexModes);
  const reports = {};
  for (const corpus of ["comparison", "curated", "tiobe"]) {
    const source = json(`contexts/${corpus}.json`);
    assert.deepEqual(source, context.corpusContexts[corpus]);
    assert.equal(source.commit, capture.commit);
    assert.equal(source.runUrl, capture.runUrl);
    assert.equal(source.profile, id);
    assert.deepEqual(source.nativeBuild.ferroni, context.nativeBuild.ferroni);
    assert.equal(source.nativeBuild.rustSourceSha256, context.nativeBuild.rustSourceSha256);
    assert.equal(source.nativeBuild.cargoLockSha256, context.nativeBuild.cargoLockSha256);
    const report = json(`${corpus}-modes.json`);
    validateReport(report, corpus, true);
    validateCorpusProvenance(report, corpus, source);
    reports[corpus] = report;
  }
  const repository = reports.comparison;
  assert.match(repository.method.assetCache, /decoded containers/);
  profiles.push({
    id,
    label: id === "macos-arm64" ? "macOS ARM64" : "Linux x86-64",
    corpusMachines: Object.fromEntries(
      Object.entries(context.corpusContexts).map(([corpus, source]) => [
        corpus,
        {
          cpu: source.cpu,
          os: source.os,
          binarySha256: source.nativeBuild.binarySha256,
        },
      ]),
    ),
    warm: repository.warmTotalMs.codeToHtml,
    cold: Object.fromEntries(
      Object.entries(repository.cold)
        .filter(([, value]) => Number.isFinite(value.medianMs))
        .map(([engine, value]) => [engine, value.medianMs]),
    ),
    workloads: ["curated", "tiobe"].flatMap((corpus) =>
      reports[corpus].languages.flatMap((language) =>
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
  });
}
const report = {
  ...capture,
  archive,
  engines: regexModeEngines.map((id) => ({ id, label: regexModeLabels[id] })),
  profiles,
};
const path = "docs/benchmarks/decoded-cache-comparison.json";
const contents = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes("--check"))
  assert.equal(read(path).toString(), contents, `Regenerate ${path}`);
else writeFileSync(new URL(path, root), contents);
// The authored README owns its wording; verify its current headline figures.
if (process.argv.includes("--check")) {
  for (const path of ["README.md.src", "node/ferriki/README.md"]) {
    const text = read(path).toString("utf8");
    for (const profile of profiles) {
      const factor = `${(profile.warm["shiki-wasm"] / profile.warm["ferriki-precompiled"]).toFixed(1)}×`;
      assert.ok(
        text.includes(factor),
        `${path} must state the current ${profile.label} factor (${factor})`,
      );
    }
  }
}
console.log(
  "Verified decoded-cache timing evidence: six corpus VMs, complete HTML gates and original checksums.",
);
