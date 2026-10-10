// Run separately from throughput measurements, with --expose-gc.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serialize } from "node:v8";

async function main() {
  const out = fileURLToPath(new URL("../", import.meta.url));
  const nodeRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
  const { createScopeClassCache } = await import(
    pathToFileURL(join(nodeRoot, ".cache/render-memoization/candidate/classes.mjs"))
  );
  await import(pathToFileURL(join(nodeRoot, "scripts/test-asset-env.mjs")));
  const { loadCases, loadCorpus, quantile } = await import(
    pathToFileURL(join(nodeRoot, "scripts/tiobe-benchmark.mjs"))
  );
  assert.equal(typeof globalThis.gc, "function", "Pass --expose-gc");
  const median = (values) => quantile(values, 0.5);

  async function retained(factory, copies) {
    const samples = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      globalThis.renderCacheMemoryValues = undefined;
      await new Promise((resolve) => setImmediate(resolve));
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      globalThis.renderCacheMemoryValues = Array.from({ length: copies }, factory);
      await new Promise((resolve) => setImmediate(resolve));
      globalThis.gc();
      samples.push((process.memoryUsage().heapUsed - before) / copies);
      assert.ok(globalThis.renderCacheMemoryValues.at(-1));
      globalThis.renderCacheMemoryValues = undefined;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return samples;
  }

  const control = await retained(() => Array.from({ length: 10000 }).fill("control"), 100);
  assert.ok(median(control) > 75000, "Retained-heap control must keep allocated arrays alive");
  const rows = [];
  for (const entry of JSON.parse(readFileSync(join(out, "phases-baseline.json"))).rows) {
    const { scopes, styles } = entry.samples[0];
    const populate = () => {
      const cache = createScopeClassCache();
      for (const scope of scopes) cache(scope);
      return cache;
    };
    for (let i = 0; i < 20; i++) populate();
    const constructionMs = [];
    for (let i = 0; i < 30; i++) {
      const started = performance.now();
      populate();
      constructionMs.push(performance.now() - started);
    }
    // This isolates the extra lookup Map. Both keys and digest strings are
    // shared with the rule data; baseline already retains the CSS rules.
    const names = styles.map((style) => [
      style,
      `ferriki-style-${createHash("sha256").update(style).digest("hex")}`,
    ]);
    const payload = populate();
    rows.push({
      id: entry.id,
      distinctScopes: scopes.length,
      distinctStyles: styles.length,
      constructionMs,
      scopeCacheHeapBytesPerCopy: await retained(populate, 100),
      styleLookupMapHeapBytesPerCopy: await retained(() => new Map(names), 1000),
      scopeCacheSerializedPayloadBytes: serialize(scopes.map((scope) => [scope, payload(scope)]))
        .byteLength,
    });
  }

  const lifecycle = [];
  for (const name of ["baseline", "candidate"]) {
    const api = await import(
      pathToFileURL(join(nodeRoot, ".cache/render-memoization", name, "index.mjs"))
    );
    const language = loadCorpus("curated").languages.find((entry) => entry.textmate === "tsx");
    const { code } = loadCases(language, ["example"], "curated")[0];
    const started = performance.now();
    const highlighter = await api.createHighlighter({
      langs: ["tsx"],
      themes: ["github-dark"],
      assets: { remote: false },
    });
    const highlighterConstructionMs = performance.now() - started;
    const options = { lang: "tsx", theme: "github-dark" };
    for (let i = 0; i < 20; i++) highlighter.codeToHtmlWithCss(code, options);
    globalThis.gc();
    const heapSamples = [process.memoryUsage().heapUsed];
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < 50; i++) highlighter.codeToHtmlWithCss(code, options);
      globalThis.gc();
      heapSamples.push(process.memoryUsage().heapUsed);
    }
    lifecycle.push({ name, highlighterConstructionMs, heapSamples, callsPerBatch: 50 });
    highlighter.dispose();
  }
  writeFileSync(
    join(out, "memory.json"),
    `${JSON.stringify({
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      harnessSha256: createHash("sha256")
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .digest("hex"),
      phaseInputSha256: createHash("sha256")
        .update(readFileSync(join(out, "phases-baseline.json")))
        .digest("hex"),
      candidateSource: JSON.parse(readFileSync(join(out, "candidate-source.json"))),
      retainedHeapControlBytesPerArray: control,
      method:
        "Five full-GC heap-delta samples with 100 populated scope caches or 1000 style lookup maps alive. Style map measurement shares existing keys/digests and excludes baseline CSS rule storage. Serialized scope payload is a volume proxy, not heap usage. Lifecycle snapshots discard outputs and force GC after batches.",
      rows,
      lifecycle,
    })}\n`,
  );
  for (const entry of rows)
    console.error(
      entry.id,
      median(entry.constructionMs),
      median(entry.scopeCacheHeapBytesPerCopy),
      median(entry.styleLookupMapHeapBytesPerCopy),
    );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
