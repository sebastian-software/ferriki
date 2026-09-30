import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const generated = new URL("../../.generated/class-highlighting/", import.meta.url);
const read = (name) => readFileSync(new URL(name, generated), "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const dataText = read("production.json");
const data = JSON.parse(dataText);
const browser = JSON.parse(read("production-browser-results.json"));
assert.equal(browser.dataSha256, hash(dataText), "Rerun the browser against the current output");
assert.equal(
  browser.checked,
  data.cases.reduce((n, item) => n + item.expected.length, 0) * data.themes.length,
);
assert.deepEqual(browser.mismatches, []);
for (const key of ["sourcePreserved", "customOverride", "domPreserved"])
  assert.equal(browser[key], true);
assert.equal(browser.tasks.length, 20);
assert(browser.tasks.every((task) => task.passed && task.targets > 0 && task.errors === 0));
const files = [
  "src/tokens.rs",
  "src/highlighter.rs",
  "src/render.rs",
  "src/lib.rs",
  "crates/ferriki-core/src/napi_api.rs",
  "tests/public_api.rs",
  "node/ferriki/classes.mjs",
  "node/ferriki/transformers.mjs",
  "node/ferriki/src/index.mjs",
  "node/ferriki/src/api.mts",
  "node/scripts/check-class-highlighting.mjs",
  ...[
    "production.mjs",
    "production-browser.mjs",
    "production-browser.html",
    "production-sizes.mjs",
    "export-production-evidence.mjs",
  ].map((file) => `node/experiments/class-highlighting/${file}`),
];
const reference = JSON.parse(read("data.json"));
const evidence = {
  capturedOn: "2026-09-30",
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  packageVersion: JSON.parse(readFileSync(`${root}/node/ferriki/package.json`, "utf8")).version,
  referenceCorpusSha256: hash(read("data.json")),
  sources: Object.fromEntries(files.map((file) => [file, hash(readFileSync(`${root}/${file}`))])),
  corpus: reference.cases.map(({ id, lang, code }) => ({
    id,
    lang,
    utf16Length: code.length,
    sha256: hash(code),
  })),
  sizes: JSON.parse(read("production-sizes.json")),
  browser,
};
const target = new URL("production-evidence.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`Production evidence saved: ${fileURLToPath(target)}\n`);
