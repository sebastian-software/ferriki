// One engine per process. No comparator is imported before the baseline.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { setImmediate } from "node:timers/promises";
import {
  digest,
  memoryEngines,
  memoryTheme,
  memoryWorkload,
  workloadIdentity,
} from "./memory-workloads.mjs";
import {
  standardGrammarRegistrations,
  standardThemeRegistrations,
} from "./standard-grammar-reference.mjs";
import "./test-asset-env.mjs";

const [engine, scenario, mode] = process.argv.slice(2);
const require = createRequire(import.meta.url);
function nativeBinarySha256() {
  if (engine !== "ferriki") return null;
  const binaries = Object.keys(require.cache).filter((path) => path.endsWith(".node"));
  assert.equal(binaries.length, 1, "Expected exactly one loaded native addon");
  return digest(readFileSync(binaries[0]));
}

assert.ok(memoryEngines.includes(engine), "Unknown memory engine");
assert.ok(["validate", "measure"].includes(mode), "Unknown worker mode");
assert.equal(typeof globalThis.gc, "function", "Run the worker with --expose-gc");
const workload = memoryWorkload(scenario);
const langs = [...new Set(workload.documents.map((doc) => doc.lang))];

async function collect() {
  // Let stack-local HTML and asynchronous cleanup become unreachable first.
  await setImmediate();
  globalThis.gc();
  await setImmediate();
  globalThis.gc();
}

function snapshot() {
  return { ...process.memoryUsage(), maxRssBytes: process.resourceUsage().maxRSS * 1024 };
}

await collect();
const phases = { baseline: snapshot() };
let highlighter;
if (engine === "ferriki") {
  const ferriki = await import("../ferriki/index.mjs");
  highlighter = await ferriki.createHighlighter({
    langs,
    themes: [memoryTheme],
    regexPrefilter: true,
  });
} else {
  const shiki = await import("shiki-benchmark");
  highlighter = await shiki.createHighlighter({
    langs: standardGrammarRegistrations(langs),
    themes: standardThemeRegistrations([memoryTheme]),
    engine:
      engine === "shiki-wasm"
        ? shiki.createOnigurumaEngine(import("shiki-benchmark/wasm"))
        : shiki.createJavaScriptRegexEngine(),
  });
}
await collect();
phases.initialized = snapshot();

if (mode === "validate") {
  const outputs = workload.documents.map((doc) => {
    const html = highlighter.codeToHtml(doc.code, { lang: doc.lang, theme: memoryTheme });
    return { path: doc.path, sha256: digest(html), bytes: Buffer.byteLength(html) };
  });
  highlighter.dispose();
  process.stdout.write(
    JSON.stringify({
      engine,
      nativeBinarySha256: nativeBinarySha256(),
      workload: workloadIdentity(workload),
      outputs,
    }),
  );
} else {
  let outputBytes = 0;
  function renderPass() {
    for (const doc of workload.documents) {
      const html = highlighter.codeToHtml(doc.code, { lang: doc.lang, theme: memoryTheme });
      // Consume the complete string without retaining HTML between documents.
      outputBytes += Buffer.byteLength(html);
    }
  }
  const checkpoints = [];
  for (let pass = 1; pass <= workload.checkpoints.at(-1); pass++) {
    renderPass();
    if (workload.checkpoints.includes(pass)) {
      const beforeGc = snapshot();
      await collect();
      checkpoints.push({ passes: pass, beforeGc, afterGc: snapshot(), outputBytes });
    }
  }
  highlighter.dispose();
  highlighter = null;
  await collect();
  phases.disposed = snapshot();
  process.stdout.write(
    JSON.stringify({
      engine,
      nativeBinarySha256: nativeBinarySha256(),
      workload: workloadIdentity(workload),
      phases,
      checkpoints,
    }),
  );
}
