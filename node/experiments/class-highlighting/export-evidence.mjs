import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const generated = new URL("../../.generated/class-highlighting/", import.meta.url);
const read = (name) => readFileSync(new URL(name, generated), "utf8");
const dataText = read("data.json");
const data = JSON.parse(dataText);
const browser = JSON.parse(read("browser-results.json"));
const hash = (text) => createHash("sha256").update(text).digest("hex");
assert.equal(
  browser.dataSha256,
  hash(dataText),
  "Browser results belong to a different corpus; rerun browser verification",
);
assert.equal(browser.themeSwitchPreservedNodes, true);
assert.equal(browser.sourcePreserved, true);
assert(browser.customPalette.every((palette) => palette.passed));
assert(
  browser.tasks.every((task) => task.results.every((result) => result.targets > 0)),
  "An unexercised task must not count as evidence",
);
const sourceFiles = readdirSync(fileURLToPath(new URL("./", import.meta.url)))
  .filter((file) => /\.(?:mjs|html|css)$/.test(file))
  .sort()
  .map((file) => `node/experiments/class-highlighting/${file}`);
sourceFiles.push("examples/class_highlighting_probe.rs");
const analysis = JSON.parse(read("analysis.json"));
assert.equal(analysis.nativeStyleDifferenceCount, 0, "The native/reference style baseline differs");
for (const model of ["nested", "hybrid"]) {
  assert.equal(
    browser.fidelity.find((result) => result.model === model).mismatches,
    0,
    `${model} has rendering mismatches`,
  );
}
const conflicts = new Set(analysis.models.flatMap((model) => model.lostPathGroups.flat()));
const evidence = {
  capturedOn: "2026-09-30",
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sources: Object.fromEntries(
    sourceFiles.map((file) => [file, hash(readFileSync(`${root}/${file}`))]),
  ),
  corpus: data.cases.map(({ id, lang, source, split, code }) => ({
    id,
    lang,
    source,
    split,
    utf16Length: code.length,
    sha256: hash(code),
  })),
  analysis,
  collidedPaths: data.paths
    .filter((path) => conflicts.has(path.id))
    .map(({ id, scopes }) => ({ id, scopes })),
  browser,
};
const target = new URL("evidence.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`Evidence saved: ${fileURLToPath(target)}\n`);
