// Direct native C++ boundary control for issue #172. Run without other workloads.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { loadFerrikiNativeBinding } from "../ferriki/native.mjs";
import { loadCases, manifest, repoRoot, sha256, statistics, theme } from "./tiobe-benchmark.mjs";

const { values } = parseArgs({ options: { write: { type: "string" } } });
const language = manifest.languages.find((entry) => entry.textmate === "cpp");
const { code, ...fixture } = loadCases(language, ["large"])[0];
const native = loadFerrikiNativeBinding().createHighlighter(
  JSON.stringify({ standardAssetRoot: join(repoRoot, "node/ferriki/assets/shiki") }),
);
assert(native.loadStandardGrammar("cpp"));
assert(native.loadStandardTheme(theme));
const options = {
  plain: JSON.stringify({ lang: "cpp", theme }),
  scopes: JSON.stringify({ lang: "cpp", theme, includeExplanation: "scopeName" }),
};
const outputs = Object.fromEntries(
  Object.entries(options).map(([mode, value]) => [mode, native.codeToTokens(code, value)]),
);
const scoped = JSON.parse(outputs.scopes);
for (const line of scoped.tokens) {
  for (const token of line) delete token.scopeNames;
}
assert.deepEqual(scoped, JSON.parse(outputs.plain));
const runs = [];
let consumed = 0;
for (const mode of ["plain", "scopes", "scopes", "plain"]) {
  for (let index = 0; index < 5; index++) native.codeToTokens(code, options[mode]);
  const samples = [];
  for (let index = 0; index < 30; index++) {
    const start = performance.now();
    const output = native.codeToTokens(code, options[mode]);
    samples.push(performance.now() - start);
    consumed += output.length;
  }
  runs.push({ mode, ...statistics(samples, fixture.bytes) });
}
const report = {
  measuredAt: new Date().toISOString(),
  machine: {
    cpu: os.cpus()[0]?.model,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
  },
  nativeBuild: JSON.parse(
    readFileSync(join(repoRoot, "node/ferriki/.benchmark-build.json"), "utf8"),
  ),
  fixture,
  theme,
  method: {
    warmup: 5,
    rounds: 30,
    order: ["plain", "scopes", "scopes", "plain"],
    units: "milliseconds per document, including native JSON serialization",
  },
  outputSha256: Object.fromEntries(
    Object.entries(outputs).map(([mode, value]) => [mode, sha256(value)]),
  ),
  runs,
  consumed,
};
if (values.write) writeFileSync(values.write, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(runs.map(({ mode, medianMs }) => ({ mode, medianMs }))));
