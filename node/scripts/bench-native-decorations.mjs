// Sequential warmed public-API comparison plus separate bridge diagnostics.
// Release timings never use the counting allocator or instrumented functions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import v8 from "node:v8";
import "./test-asset-env.mjs";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    current: { type: "string" },
    write: { type: "string" },
    "profiling-addon": { type: "string" },
    worker: { type: "string" },
  },
});
const script = fileURLToPath(import.meta.url);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const git = (cwd, args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const identity = (entry) => {
  const root = resolve(dirname(entry), "../..");
  const files = git(root, [
    "ls-files",
    "src",
    "crates",
    "Cargo.toml",
    "Cargo.lock",
    "node/ferriki",
  ]).split("\n");
  for (const file of ["src/decorations.rs", "crates/ferriki-core/src/decorations.rs"])
    if (!files.includes(file)) {
      try {
        readFileSync(join(root, file));
        files.push(file);
      } catch {}
    }
  const source = files.sort().map((file) => [file, sha(readFileSync(join(root, file)))]);
  const addon = join(dirname(entry), "dist/ferriki.node");
  const addonSha256 = sha(readFileSync(addon));
  const build = JSON.parse(readFileSync(join(dirname(entry), ".benchmark-build.json")));
  assert.equal(addonSha256, build.binarySha256, "Addon differs from its build receipt");
  return {
    revision: git(root, ["rev-parse", "HEAD"]),
    runtimeSourceSha256: sha(JSON.stringify(source)),
    addonSha256,
    build,
  };
};

if (!values.worker) {
  assert(
    values.baseline && values.write,
    "Use --baseline /path/to/index.mjs --write report.json [--profiling-addon file.node]",
  );
  const entries = {
    baseline: resolve(values.baseline),
    current: resolve(
      values.current ?? fileURLToPath(new URL("../ferriki/index.mjs", import.meta.url)),
    ),
  };
  const runs = [];
  for (const order of [
    ["baseline", "current"],
    ["current", "baseline"],
    ["baseline", "current"],
  ])
    for (const engine of order) {
      const args = ["--expose-gc", script, "--worker", entries[engine]];
      if (engine === "current" && values["profiling-addon"])
        args.push("--profiling-addon", resolve(values["profiling-addon"]));
      const child = spawnSync(process.execPath, args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(child.status, 0, child.stderr);
      runs.push({ engine, ...JSON.parse(child.stdout) });
      console.error(`Completed ${engine} process ${runs.length}/6`);
    }
  const cases = runs[0].cases.map((base) => {
    const matched = (engine) =>
      runs.filter((r) => r.engine === engine).map((r) => r.cases.find((c) => c.name === base.name));
    const a = matched("baseline");
    const b = matched("current");
    assert(
      a.every((c) => c.outputSha256 === base.outputSha256) &&
        b.every((c) => c.outputSha256 === base.outputSha256),
      `${base.name}: output differs`,
    );
    const baselineMs = median(a.flatMap((c) => c.samplesMs));
    const currentMs = median(b.flatMap((c) => c.samplesMs));
    return {
      name: base.name,
      baselineMs,
      currentMs,
      changePercent: (currentMs / baselineMs - 1) * 100,
    };
  });
  const identities = Object.fromEntries(
    Object.entries(entries).map(([name, entry]) => [name, identity(entry)]),
  );
  for (const run of runs)
    assert.equal(
      run.loadedAddonSha256,
      identities[run.engine].addonSha256,
      "Loaded addon differs from build evidence",
    );
  const report = {
    date: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
    harnessSha256: sha(readFileSync(script)),
    assetsManifestSha256: sha(
      readFileSync(new URL("../ferriki/assets/shiki/release-manifest.json", import.meta.url)),
    ),
    identities,
    profilingAddonSha256: values["profiling-addon"]
      ? sha(readFileSync(values["profiling-addon"]))
      : undefined,
    cases,
    runs,
  };
  writeFileSync(values.write, `${JSON.stringify(report, null, 2)}\n`);
  for (const result of cases)
    console.log(
      `${result.name}: ${result.baselineMs.toFixed(4)} -> ${result.currentMs.toFixed(4)} ms (${result.changePercent.toFixed(1)}%)`,
    );
  process.exit(0);
}

const entry = resolve(values.worker);
const { createHighlighter } = await import(pathToFileURL(entry));
const { loadFerrikiNativeBinding } = await import(
  pathToFileURL(join(dirname(entry), "native.mjs"))
);
const native = loadFerrikiNativeBinding();
const highlighter = await createHighlighter({ langs: ["javascript"], themes: ["nord"] });
assert(
  !native.profileTokenBoundary,
  "Release timing requires an addon without the profiling feature",
);
const loadedAddon = Object.entries(createRequire(import.meta.url).cache).find(
  ([file, module]) => file.endsWith(".node") && module.exports === native,
)?.[0];
assert(loadedAddon, "Could not identify the loaded native addon");
const loadedAddonSha256 = sha(readFileSync(loadedAddon));
const profiler = values["profiling-addon"]
  ? createRequire(import.meta.url)(resolve(values["profiling-addon"]))
  : undefined;
const names = {
  splitDecorationTokens: "split",
  decorationSections: "prepare",
  planDecorationMutations: "plan",
  nextDecorationSection: "next",
};
const cases = [];
try {
  for (const lines of [4, 80])
    for (const styleMode of ["inline", "classes"])
      for (const mode of ["control", "declarative", "mixed"]) {
        const text = 'const value = build("β😀 <&>"); // example';
        const source = Array.from({ length: lines }, () => text).join("\n");
        const decorations = Array.from({ length: lines / 2 }, (_, i) => ({
          start: i * 2 * (text.length + 1) + 6,
          end: i * 2 * (text.length + 1) + 11,
          alwaysWrap: i % 2 === 0,
          tagName: i % 3 === 0 ? "strong" : "span",
          properties: { class: "highlighted-word", "data-decoration": "yes" },
          ...(mode === "mixed" && i % 5 === 0
            ? {
                transform(node) {
                  node.properties["data-callback"] = "yes";
                  return node;
                },
              }
            : {}),
        }));
        const options = {
          lang: "javascript",
          theme: "nord",
          styleMode,
          ...(mode === "control" ? {} : { decorations }),
          ...(mode === "mixed"
            ? {
                transformers: [
                  {
                    span(node) {
                      node.properties["data-transformer"] = "yes";
                      return node;
                    },
                  },
                ],
              }
            : {}),
        };
        const render = () =>
          styleMode === "classes"
            ? highlighter.codeToHtmlWithCss(source, options)
            : highlighter.codeToHtml(source, options);
        for (let i = 0; i < 40; i++) render();
        const iterations = lines === 4 ? 80 : 10;
        const samplesMs = [];
        for (let sample = 0; sample < 7; sample++) {
          globalThis.gc();
          const start = performance.now();
          for (let i = 0; i < iterations; i++) render();
          samplesMs.push((performance.now() - start) / iterations);
        }
        const heapGrowthBytes = [];
        for (let i = 0; i < 5; i++) {
          globalThis.gc();
          const before = v8.getHeapStatistics().used_heap_size;
          const result = render();
          heapGrowthBytes.push(v8.getHeapStatistics().used_heap_size - before);
          assert(result);
        }
        const calls = [];
        const originals = [];
        for (const [name, operation] of Object.entries(names))
          if (native[name]) {
            const original = native[name];
            originals.push([name, original]);
            native[name] = (...args) => {
              const start = performance.now();
              const result = original(...args);
              const ms = performance.now() - start;
              const input =
                operation === "next"
                  ? { range: args[0], decoration: args[1], alwaysWrap: args[2], cursor: args[3] }
                  : operation === "split"
                    ? { source: args[0], ranges: args[1], lines: args[2] }
                    : operation === "prepare"
                      ? { source: args[0], ranges: args[1] }
                      : { nodes: args[0], lines: args[1], sections: args[2] };
              calls.push({ operation, input, ms });
              return result;
            };
          }
        try {
          render();
        } finally {
          for (const [name, original] of originals) native[name] = original;
        }
        const phases =
          profiler && calls.length
            ? Array.from({ length: 9 }, () => {
                const total = Object.fromEntries(
                  ["input", "policy", "output"].map((name) => [
                    name,
                    { ms: 0, allocations: 0, bytes: 0 },
                  ]),
                );
                for (const call of calls) {
                  const result = profiler.profileDecorationBoundary(call.operation, call.input);
                  for (const phase of Object.keys(total))
                    for (const field of ["ms", "allocations", "bytes"])
                      total[phase][field] += result[phase][field];
                }
                return total;
              })
            : undefined;
        cases.push({
          name: `${lines}-lines/${styleMode}/${mode}`,
          sourceSha256: sha(source),
          sourceUtf16: source.length,
          decorations: mode === "control" ? 0 : decorations.length,
          iterations,
          samplesMs,
          heapGrowthBytes,
          outputSha256: sha(JSON.stringify(render())),
          boundary: {
            calls: calls.length,
            totalMs: calls.reduce((sum, c) => sum + c.ms, 0),
            operations: calls.map((c) => ({
              operation: c.operation,
              ms: c.ms,
              nodeMetadataWords: c.input.nodes?.length,
              tokenMetadataWords:
                c.operation === "split"
                  ? c.input.lines.reduce((sum, line) => sum + line.length, 0)
                  : undefined,
              sections: c.input.sections?.length,
            })),
          },
          diagnosticPhases: phases,
        });
      }
} finally {
  highlighter.dispose();
}
console.log(JSON.stringify({ loadedAddonSha256, cases }));
