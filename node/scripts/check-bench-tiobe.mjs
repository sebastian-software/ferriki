// Real process/grammar checks: plaintext fallbacks cannot pass this gate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { compareReports, engines, repoRoot, validateOutput } from "./tiobe-benchmark.mjs";

const script = fileURLToPath(new URL("./bench-tiobe.mjs", import.meta.url));
const directory = mkdtempSync(join(os.tmpdir(), "ferriki-tiobe-check-"));
function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: join(repoRoot, "node"),
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
}
try {
  const path = join(directory, "report.json");
  const child = run(["--write", path, "--rounds", "2", "--max-rounds", "2", "--budget-ms", "0"]);
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(JSON.parse(child.stdout), report, "--write and stdout must agree");
  assert.deepEqual(
    report.languages.map((row) => row.rank),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  for (const row of report.languages) {
    if (row.rank === 15) {
      assert.equal(row.status, "unsupported");
      assert.match(row.unsupported, /Scratch/);
      continue;
    }
    assert.equal(row.status, "measured", JSON.stringify(row));
    assert.equal(row.cases.length, 2);
    for (const entry of row.cases) {
      for (const id of engines) {
        const result = entry.results[id];
        assert.equal(result.status, "ok", `${row.name}/${id}: ${result.error}`);
        assert.equal(result.validation.sourcePreserved, true);
        if (id !== "prism")
          assert.deepEqual(result.validation.referenceParity, { tokens: true, html: true });
        for (const api of ["html", "tokens"]) assert.equal(result[api].samplesMs.length, 2);
      }
    }
  }
  const same = compareReports(report, report);
  assert.equal(same.comparisons.length, 19 * 2 * 2);
  assert.ok(same.comparisons.every((row) => row.changePercent === 0));
  const different = structuredClone(report);
  different.languages[0].cases[0].results.ferriki.html.medianMs *= 1.2;
  assert.ok(Math.abs(compareReports(report, different).comparisons[0].changePercent - 20) < 1e-8);
  different.languages[0].cases[0].results.ferriki.validation.htmlSha256 = "changed";
  assert.equal(compareReports(report, different).excluded.length, 2);
  different.languages[0].cases = undefined;
  different.languages[0].status = "timeout";
  assert.equal(
    compareReports(report, different).excluded.length,
    3,
    "Failed languages must not disappear",
  );
  different.machine.node = "other";
  assert.throws(() => compareReports(report, different), /different machine/);
  const changedSource = structuredClone(report);
  changedSource.languages[0].cases[0].sha256 = "changed";
  assert.throws(() => compareReports(report, changedSource), /Source changed/);

  const timedOut = run(["--language", "rust", "--timeout-ms", "1"]);
  assert.equal(timedOut.status, 0, timedOut.stderr);
  assert.equal(JSON.parse(timedOut.stdout).languages[0].status, "timeout");
  for (const args of [
    ["--language", "missing"],
    ["--sizes", "example,example"],
    ["--budget-ms", "NaN"],
  ])
    assert.notEqual(run(args).status, 0);
  assert.throws(
    () => validateOutput("prism", "<secret>", [{ content: "<secret>" }], "<span><secret></span>"),
    /HTML changed/,
  );
  assert.throws(() => validateOutput("prism", "text", ["text"], "text"), /plaintext fallback/);
  console.log(
    "[check-bench-tiobe] 19 languages × 2 sizes × 4 engines preserve source; native and Shiki outputs match; failure/timeout/comparison contracts pass.",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
