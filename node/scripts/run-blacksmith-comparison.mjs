// Run each workload serially on one host and retain failures alongside timings.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { comparisonCorpus } from "./shiki-comparison-corpus.mjs";
import { engines, loadCorpus, repoRoot } from "./tiobe-benchmark.mjs";

const nodeRoot = join(repoRoot, "node");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

function checkSamples(samples, minimum) {
  assert.ok(Array.isArray(samples) && samples.length >= minimum, "Missing raw timing samples");
  assert.ok(
    samples.every((value) => Number.isFinite(value) && value >= 0),
    "Invalid timing sample",
  );
}

export function validateReport(report, corpus, regexPrefilter) {
  assert.equal(report.method.regexPrefilter, regexPrefilter, "Wrong prefilter configuration");
  if (corpus === "comparison") {
    assert.deepEqual(
      report.warm.codeToHtml.map((row) => row.path),
      comparisonCorpus.map(([, path]) => path),
    );
    for (const id of engines.filter((id) => id !== "prism")) {
      assert.equal(report.agreement[id].documents, comparisonCorpus.length, `${id}: HTML mismatch`);
      checkSamples(report.cold[id].samplesMs, report.method.coldRuns);
      for (const row of report.warm.codeToHtml) {
        assert.match(row.sha256, /^[a-f0-9]{64}$/);
        checkSamples(row.samplesMs[id], report.method.minSamples);
      }
    }
    return;
  }
  const manifest = loadCorpus(corpus);
  assert.equal(report.corpus.id, corpus);
  assert.deepEqual(
    report.languages.map((row) => row.name),
    manifest.languages.map((row) => row.name),
  );
  for (const [index, language] of manifest.languages.entries()) {
    const row = report.languages[index];
    if (!language.file) {
      assert.equal(row.status, "unsupported");
      assert.equal(row.unsupported, language.unsupported);
      continue;
    }
    assert.equal(row.status, "measured", `${row.name}: ${row.error}`);
    assert.deepEqual(
      row.cases.map((entry) => entry.size),
      ["example", "large"],
    );
    for (const entry of row.cases) {
      for (const id of engines) {
        const result = entry.results[id];
        if (id === "prism" && !language.prism) {
          assert.equal(result.status, "unsupported");
          continue;
        }
        assert.equal(result.status, "ok", `${row.name}/${entry.size}/${id}: ${result.error}`);
        assert.equal(result.validation.sourcePreserved, true, `${row.name}/${id}: source changed`);
        if (id !== "prism")
          assert.deepEqual(
            result.validation.referenceParity,
            { html: true },
            `${row.name}/${id}: HTML changed`,
          );
        checkSamples(result.html.samplesMs, report.method.minRounds);
      }
    }
  }
}

export function renderSummary(reports, context, errors = []) {
  const lines = [
    `# Ferriki Blacksmith comparison: ${context.profile}`,
    "",
    `Commit: ${context.commit}. Runner: ${context.runnerLabel}. CPU: ${context.cpu}. Node: ${context.node}.`,
    "",
    "Warm HTML medians reuse highlighters. Cold measurements use fresh processes and include imports, setup and one full-corpus render; process creation and asset downloads are excluded. Smaller values are faster. The prefilter is enabled by default. These are observations on this host, not a comparison with an earlier Ferroni release.",
    "",
    "| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  const table = (label, mode, values) =>
    lines.push(
      `| ${label} | ${mode} | ${["ferriki", "shiki-wasm", "shiki-js"].map((id) => (Number.isFinite(values[id]) ? values[id].toFixed(3) : "invalid")).join(" | ")} |`,
    );
  for (const mode of ["on", "off"]) {
    const report = reports[`comparison-${mode}`];
    if (!report) continue;
    table("Repository / warm total", mode, report.warmTotalMs.codeToHtml);
    table(
      "Repository / cold total",
      mode,
      Object.fromEntries(Object.entries(report.cold).map(([id, value]) => [id, value.medianMs])),
    );
  }
  lines.push(
    "",
    "## JSON and Astro with reused highlighters",
    "",
    "| Language | Size | Prefilter on ms | Prefilter off ms | Off vs. on |",
    "| --- | --- | ---: | ---: | ---: |",
  );
  const on = reports["curated-on"];
  const off = reports["curated-off"];
  if (on && off) {
    for (const row of on.languages.filter((row) => ["JSON", "Astro"].includes(row.name))) {
      for (const entry of row.cases ?? []) {
        const first = entry.results.ferriki.html?.medianMs;
        const second = off.languages
          .find((other) => other.name === row.name)
          ?.cases?.find((other) => other.size === entry.size)?.results.ferriki.html?.medianMs;
        if (first > 0 && Number.isFinite(second))
          lines.push(
            `| ${row.name} | ${entry.size} | ${first.toFixed(3)} | ${second.toFixed(3)} | ${(100 * (second / first - 1)).toFixed(2)}% |`,
          );
      }
    }
  }
  lines.push(
    "",
    "## All warm workloads",
    "",
    "| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |",
    "| --- | --- | ---: | ---: | ---: |",
  );
  for (const corpus of ["curated", "tiobe"]) {
    for (const mode of ["on", "off"]) {
      for (const row of reports[`${corpus}-${mode}`]?.languages ?? []) {
        for (const entry of row.cases ?? [])
          table(
            `${corpus} / ${row.name} / ${entry.size}`,
            mode,
            Object.fromEntries(
              Object.entries(entry.results).map(([id, value]) => [id, value.html?.medianMs]),
            ),
          );
      }
    }
  }
  lines.push(
    "",
    errors.length
      ? "Validation failed; failed reports are excluded from the timing summary. See the raw artifacts for diagnostics."
      : "All required source and exact TextMate HTML checks passed. Prism uses independent grammars and is retained in raw reports without a TextMate parity claim.",
  );
  for (const error of errors) lines.push(`- ${error}`);
  lines.push(
    "",
    "Artifacts retain raw JSON samples, logs, native build receipt, runner context and SHA256SUMS. Optional Phiki availability and output differences are recorded in the repository reports.",
    "",
  );
  return lines.join("\n");
}

function run(directory) {
  mkdirSync(join(directory, "logs"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const context = {
    measuredAt: new Date().toISOString(),
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
    rustc: execFileSync("rustc", ["-Vv"], { encoding: "utf8" }).trim(),
    nativeBuild: read(join(nodeRoot, "ferriki/.benchmark-build.json")),
    cargoLockSha256: sha256(readFileSync(join(repoRoot, "Cargo.lock"))),
    pnpmLockSha256: sha256(readFileSync(join(nodeRoot, "pnpm-lock.yaml"))),
    schedule:
      "Serial comparison, curated and TIOBE reports; prefilter on then off per corpus; engines rotate warm order within each report. Both modes use the same addon.",
  };
  writeFileSync(join(directory, "context.json"), `${JSON.stringify(context, null, 2)}\n`);
  const reports = {};
  const errors = [];
  workloads: for (const corpus of ["comparison", "curated", "tiobe"]) {
    for (const mode of ["on", "off"]) {
      const name = `${corpus}-${mode}`;
      console.log(`[Blacksmith] ${name}`);
      const path = join(directory, `${name}.json`);
      const args =
        corpus === "comparison"
          ? ["scripts/bench-shiki-comparison.mjs", "--raw-samples"]
          : ["scripts/bench-tiobe.mjs", "--corpus", corpus];
      args.push("--regex-prefilter", mode, "--write", path);
      const log = openSync(join(directory, "logs", `${name}.log`), "w");
      let child;
      try {
        child = spawnSync(process.execPath, args, {
          cwd: nodeRoot,
          stdio: ["ignore", log, log],
          timeout: 20 * 60 * 1000,
        });
        assert.equal(
          child.status,
          0,
          `${child.error?.message ?? "Benchmark process failed"}; see logs/${name}.log`,
        );
        const report = read(path);
        validateReport(report, corpus, mode === "on");
        reports[name] = report;
      } catch (error) {
        errors.push(`${name}: ${error.message}`);
        // A timed-out parent may leave its worker alive briefly. Do not start
        // another timed workload while that worker could still occupy the CPU.
        if (child?.error?.code === "ETIMEDOUT") break workloads;
      } finally {
        closeSync(log);
      }
    }
  }
  const summary = renderSummary(reports, context, errors);
  writeFileSync(join(directory, "summary.md"), summary);
  writeFileSync(
    join(directory, "validation.json"),
    `${JSON.stringify({ ok: errors.length === 0, errors }, null, 2)}\n`,
  );
  const paths = [
    ...readdirSync(directory).filter((name) => name !== "logs" && name !== "SHA256SUMS"),
    ...readdirSync(join(directory, "logs")).map((name) => `logs/${name}`),
  ].sort();
  writeFileSync(
    join(directory, "SHA256SUMS"),
    paths.map((path) => `${sha256(readFileSync(join(directory, path)))}  ${path}\n`).join(""),
  );
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(
    process.argv.length,
    3,
    "Usage: node scripts/run-blacksmith-comparison.mjs /absolute/output-directory",
  );
  run(resolve(process.argv[2]));
}
