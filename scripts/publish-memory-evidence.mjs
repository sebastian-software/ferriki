// Derive public values only from complete, checksummed process evidence.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMemoryEvidence } from "../node/scripts/memory-evidence.mjs";
import { summarizeMemory } from "../node/scripts/run-blacksmith-memory.mjs";

const root = new URL("../", import.meta.url);
const archive = "docs/benchmarks/blacksmith/2026-10-24-prepared-eager/memory";
const profiles = ["linux-x86-64", "macos-arm64"].map((id) => {
  const directory = `${archive}/${id}`;
  const { context, report } = readMemoryEvidence(fileURLToPath(new URL(directory, root)));
  assert.equal(context.profile, id);
  assert.equal(context.platform, id === "linux-x86-64" ? "linux-x64" : "darwin-arm64");
  assert.equal(context.node, "v24.21.0");
  assert.equal(
    context.runnerLabel,
    id === "linux-x86-64" ? "blacksmith-4vcpu-ubuntu-2404" : "blacksmith-6vcpu-macos-26",
  );
  assert.ok(
    context.runUrl?.startsWith("https://github.com/sebastian-software/ferriki/actions/runs/"),
  );
  return {
    id,
    label: id === "linux-x86-64" ? "Linux x86-64" : "macOS ARM64",
    runner: context.runnerLabel,
    cpu: context.cpu,
    os: context.os,
    node: context.node,
    revision: context.commit,
    tree: context.tree,
    ferriki: context.ferriki,
    shiki: context.comparators.shiki,
    ferroni: context.nativeBuild.ferroni.version,
    rustc: context.nativeBuild.rustc.split("\n")[0],
    pnpmLockSha256: context.pnpmLockSha256,
    cargoLockSha256: context.cargoLockSha256,
    nativeBinarySha256: context.binarySha256,
    runUrl: context.runUrl,
    measuredAt: context.measuredAt,
    archive: directory,
    scenarios: summarizeMemory(report),
  };
});
for (const key of [
  "revision",
  "tree",
  "ferriki",
  "shiki",
  "ferroni",
  "node",
  "pnpmLockSha256",
  "cargoLockSha256",
  "runUrl",
])
  assert.equal(profiles[0][key], profiles[1][key], `Different memory capture ${key}`);
const output = `${JSON.stringify({ profiles }, null, 2)}\n`;
const target = new URL("docs/benchmarks/blacksmith-memory.json", root);
if (process.argv.includes("--check"))
  assert.equal(
    readFileSync(target, "utf8"),
    output,
    "Regenerate memory data: node scripts/publish-memory-evidence.mjs",
  );
else writeFileSync(target, output);
if (process.argv.includes("--check")) {
  // The detailed page retains these dated observations. Current README
  // claims are checked against the new capture by publish-regex-mode-evidence.mjs.
  const headlinePaths = ["homepage/app/routes/evidence/benchmarks.mdx"];
  for (const scenario of ["repository", "large-typescript"]) {
    const changes = profiles.map((profile) => {
      const { engines } = profile.scenarios.find((entry) => entry.id === scenario);
      return Math.round(
        100 * (engines.ferriki.finalRss.median / engines["shiki-wasm"].finalRss.median - 1),
      );
    });
    assert.ok(
      changes.every((value) => value > 0) || changes.every((value) => value < 0),
      "Mixed memory directions need host-specific copy",
    );
    const magnitudes = changes.map(Math.abs).sort((a, b) => a - b);
    const range = `${magnitudes[0]}–${magnitudes[1]}% ${changes[0] > 0 ? "higher" : "lower"}`;
    for (const path of headlinePaths)
      assert.ok(
        readFileSync(new URL(path, root), "utf8").includes(range),
        `${path}: stale ${scenario} memory headline (${range})`,
      );
  }
}
console.log(
  "Verified memory evidence: two profiles, two scenarios, 72 isolated measurements and 12 HTML validation processes.",
);
