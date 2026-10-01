// Exercise the complete curated corpus through real native and comparator engines.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { compareReports, engines, loadCorpus, repoRoot } from "./tiobe-benchmark.mjs";

const expected = [
  "TypeScript",
  "TSX",
  "Rust",
  "CSS",
  "HTML",
  "C++",
  "Swift",
  "Java",
  "Markdown",
  "TOML",
  "YAML",
  "JSON",
  "Astro",
  "Svelte",
  "Ruby",
  "Python",
  "Vue",
  "MDX",
  "SCSS",
  "Bash",
];
const corpus = loadCorpus("curated");
assert.deepEqual(
  corpus.languages.map((row) => row.name),
  expected,
);
assert.throws(() => loadCorpus("missing"), /Invalid --corpus/);
const script = fileURLToPath(new URL("./bench-tiobe.mjs", import.meta.url));
const directory = mkdtempSync(join(os.tmpdir(), "ferriki-curated-check-"));
try {
  const path = join(directory, "report.json");
  const child = spawnSync(
    process.execPath,
    [
      script,
      "--corpus",
      "curated",
      "--write",
      path,
      "--rounds",
      "2",
      "--max-rounds",
      "2",
      "--budget-ms",
      "0",
    ],
    {
      cwd: join(repoRoot, "node"),
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(JSON.parse(child.stdout), report);
  assert.deepEqual(
    report.languages.map((row) => row.name),
    expected,
  );
  assert.equal(report.corpus.id, "curated");
  for (const row of report.languages) {
    assert.equal(row.status, "measured", `${row.name}: ${row.error}`);
    assert.equal(row.cases.length, 2);
    for (const entry of row.cases) {
      for (const id of engines) {
        const result = entry.results[id];
        if (id === "prism" && !row.prism) {
          assert.equal(result.status, "unsupported");
          assert.equal(result.reason, row.prismUnsupported);
          assert.equal(result.tokens, undefined, "Unsupported grammars cannot produce timings");
          continue;
        }
        assert.equal(result.status, "ok", `${row.name}/${entry.size}/${id}: ${result.error}`);
        assert.equal(result.validation.sourcePreserved, true);
        if (id !== "prism")
          assert.deepEqual(
            result.validation.referenceParity,
            { tokens: true, html: true },
            `${row.name}/${entry.size}/${id}`,
          );
        for (const api of ["html", "tokens"]) assert.equal(result[api].samplesMs.length, 2);
      }
    }
  }
  assert.equal(compareReports(report, report).comparisons.length, 80);
  const rendererChange = structuredClone(report);
  rendererChange.nativeBuild.ferriki.commit = "renderer-candidate";
  rendererChange.nativeBuild.rustSourceSha256 = "changed-renderer";
  assert.throws(() => compareReports(report, rendererChange), /Ferriki must stay/);
  assert.equal(
    compareReports(report, rendererChange, { isolation: "ferriki" }).comparisons.length,
    80,
  );
  rendererChange.nativeBuild.ferroni.sourceSha256 = "changed-engine";
  assert.throws(
    () => compareReports(report, rendererChange, { isolation: "ferriki" }),
    /Ferroni must stay unchanged/,
  );
  assert.throws(() => compareReports(report, report, { isolation: "other" }), /Invalid comparison/);
  const changed = structuredClone(report);
  changed.corpus.id = "tiobe";
  assert.throws(() => compareReports(report, changed), /different corpus/);
  for (const args of [
    ["--corpus", "missing"],
    ["--corpus", "curated", "--language", "missing"],
  ]) {
    const invalid = spawnSync(process.execPath, [script, ...args], {
      cwd: join(repoRoot, "node"),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.notEqual(invalid.status, 0);
  }
  const profiler = fileURLToPath(new URL("./profile-tiobe.mjs", import.meta.url));
  const profile = spawnSync(
    process.execPath,
    [
      profiler,
      "--corpus",
      "curated",
      "--language",
      "vue",
      "--boundary",
      "native",
      "--seconds",
      "0.001",
    ],
    { cwd: join(repoRoot, "node"), encoding: "utf8", timeout: 30000 },
  );
  assert.equal(profile.status, 0, profile.stderr);
  assert.deepEqual(JSON.parse(profile.stdout).validation.referenceParity, {
    tokens: true,
    html: true,
  });
  console.log(
    "[check-bench-curated] 20 formats × 2 sizes preserve source and exact TextMate output; 16 Prism components pass, 4 remain explicitly unsupported; corpus and native embedded-language profiling contracts pass.",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
