// Freeze the facade for an addon-only comparison. Never add benchmark overrides
// to the published native loader or edit the historical reproduction script.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const [inputs, baseline, candidate, assets, output] = process.argv
  .slice(2)
  .map((arg) => resolve(arg));
assert.equal(process.argv.length, 7, "Expected inputs, baseline, candidate, assets, output");
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const baselineHash = hash(baseline);
const candidateHash = hash(candidate);
assert.notEqual(baselineHash, candidateHash, "The two native builds must differ");
const cache = join(repo, "node/.cache");
mkdirSync(cache, { recursive: true });
const temporary = mkdtempSync(join(cache, "indexed-reader-comparison-"));
try {
  const facade = join(temporary, "facade");
  cpSync(join(repo, "node/ferriki"), facade, { recursive: true });
  const loader = `import { createRequire } from "node:module";
import process from "node:process";
const require = createRequire(import.meta.url);
export function loadFerrikiNativeBinding() {
  if (!process.env.FERRIKI_BENCH_ADDON) throw new Error("Missing benchmark addon");
  return require(process.env.FERRIKI_BENCH_ADDON);
}
export const tryLoadFerrikiNativeBinding = loadFerrikiNativeBinding;
`;
  writeFileSync(join(facade, "native.mjs"), loader);
  let driver = readFileSync(
    join(repo, "docs/benchmarks/precompiled-patterns/decoded-cache/reproduce.mjs"),
    "utf8",
  );
  function replaceOnce(before, after) {
    assert.equal(driver.split(before).length, 2, `Historical driver marker changed: ${before}`);
    driver = driver.replace(before, after);
  }
  driver = `import { createRequire } from "node:module";\n${driver}`;
  replaceOnce(
    "  const started = performance.now();",
    "  const loadedAddonSha256 = hash(readFileSync(process.env.FERRIKI_BENCH_ADDON));\n" +
      "  const started = performance.now();",
  );
  replaceOnce(
    "  const initialized = performance.now();",
    "  const initialized = performance.now();\n" +
      "  assert.ok(createRequire(import.meta.url).cache[process.env.FERRIKI_BENCH_ADDON], 'Selected addon was not loaded');",
  );
  replaceOnce(
    "      scenario,\n      mode,",
    "      scenario,\n      mode,\n      loadedAddonSha256,",
  );
  replaceOnce(
    'if (lane.label === "after" && lane.mode === "prepared") run(scenario, lane);',
    'if (lane.label !== "after-first-fill" && lane.mode === "prepared") run(scenario, lane);',
  );
  const worker = join(temporary, "driver.mjs");
  writeFileSync(worker, driver);
  writeFileSync(join(dirname(output), "frozen-loader.mjs"), loader);
  writeFileSync(join(dirname(output), "frozen-driver.mjs"), driver);
  const result = spawnSync(
    process.execPath,
    [worker, facade, inputs, baseline, candidate, assets, output],
    {
      stdio: "inherit",
      timeout: 600_000,
    },
  );
  assert.equal(result.status, 0, result.error?.message ?? "Paired measurement failed");
  const report = JSON.parse(readFileSync(output));
  for (const row of report.rows)
    assert.equal(row.loadedAddonSha256, row.label === "before" ? baselineHash : candidateHash);
  assert.equal(report.baselineSha256, baselineHash);
  assert.equal(report.candidateSha256, candidateHash);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
