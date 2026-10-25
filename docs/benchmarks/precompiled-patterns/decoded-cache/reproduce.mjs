// Fresh-process diagnostic. See README.md for the frozen facade and addon setup.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

if (process.argv[2] === "--worker") {
  const [modulePath, inputsPath, scenario, mode, cacheDir] = process.argv.slice(3);
  const workload = JSON.parse(readFileSync(inputsPath, "utf8")).find(
    (item) => item.id === scenario,
  );
  const { documents } = workload;
  for (const doc of documents) assert.equal(hash(doc.code), doc.sha256);
  const started = performance.now();
  const { createHighlighter } = await import(pathToFileURL(modulePath).href);
  const imported = performance.now();
  const highlighter = await createHighlighter({
    langs: [...new Set(documents.map((doc) => doc.lang))],
    themes: ["github-dark"],
    regexMode: mode,
    assets: { cacheDir, remote: false },
  });
  const initialized = performance.now();
  const render = () =>
    documents.map((doc) =>
      highlighter.codeToHtml(doc.code, {
        lang: doc.lang,
        theme: "github-dark",
      }),
    );
  const first = render();
  const rendered = performance.now();
  const outputHashes = first.map(hash);
  for (let i = 0; i < 5; i++) render();
  const warmMs = [];
  let last;
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    last = render();
    warmMs.push(performance.now() - start);
  }
  assert.deepEqual(last.map(hash), outputHashes);
  const diagnostics = highlighter.getRegexDiagnostics();
  assert.equal(diagnostics.mode, mode);
  assert.equal(diagnostics.assemblyFallbacks, 0);
  assert.equal(diagnostics.invalidPreparedGroups, 0);
  if (mode === "prepared") {
    assert.equal(diagnostics.preparedArchives, new Set(documents.map((doc) => doc.lang)).size);
    assert.ok(diagnostics.loadedPreparedGroups > 0);
  } else {
    assert.equal(diagnostics.preparedArchives, 0);
    assert.equal(diagnostics.loadedPreparedGroups, 0);
  }
  highlighter.dispose();
  process.stdout.write(
    JSON.stringify({
      scenario,
      mode,
      importMs: imported - started,
      setupMs: initialized - imported,
      firstMs: rendered - initialized,
      startupMs: rendered - started,
      warmMs,
      outputHashes,
      diagnostics,
    }),
  );
} else {
  const [facade, inputs, baseline, candidate, assets, output] = process.argv
    .slice(2)
    .map((value) => resolve(value));
  const release = JSON.parse(readFileSync(join(assets, "release-manifest.json"), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "ferriki-decoded-startup-"));
  const cache = join(root, "cache");
  mkdirSync(cache);
  // Seed transport bytes only; this work and all downloads are outside timers.
  for (const [path, asset] of Object.entries(release.assets)) {
    const bytes = readFileSync(join(assets, path));
    assert.equal(hash(bytes), asset.sha256);
    assert.equal(bytes.length, asset.size);
    copyFileSync(join(assets, path), join(cache, asset.sha256));
  }
  const scenarios = JSON.parse(readFileSync(inputs, "utf8")).map((item) => item.id);
  const lanes = [
    ...["off", "auto", "eager", "prepared"].map((mode) => ({
      label: "before",
      addon: baseline,
      mode,
    })),
    ...["off", "auto", "eager", "prepared"].map((mode) => ({
      label: "after",
      addon: candidate,
      mode,
    })),
    { label: "after-first-fill", addon: candidate, mode: "prepared" },
  ];
  const rows = [];
  const run = (scenario, lane) => {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--worker",
        join(facade, "index.mjs"),
        inputs,
        scenario,
        lane.mode,
        cache,
      ],
      {
        env: { ...process.env, FERRIKI_BENCH_ADDON: lane.addon },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  // Populate the candidate's derived cache without including a fill in warm-cache samples.
  for (const scenario of scenarios) run(scenario, { addon: candidate, mode: "prepared" });
  for (let repeat = 0; repeat < 5; repeat++) {
    for (const scenario of scenarios) {
      const offset = (repeat + scenarios.indexOf(scenario)) % lanes.length;
      const rotated = [...lanes.slice(offset), ...lanes.slice(0, offset)];
      for (const lane of rotated) {
        if (lane.label === "after-first-fill")
          rmSync(join(cache, "decoded"), { recursive: true, force: true });
        // A first-fill run for the small scenario leaves other roots absent.
        if (lane.label === "after" && lane.mode === "prepared") run(scenario, lane);
        const row = { label: lane.label, repeat, ...run(scenario, lane) };
        rows.push(row);
        process.stderr.write(
          `${row.label} ${row.scenario} ${row.mode}: ${row.setupMs.toFixed(2)} ms setup\n`,
        );
      }
    }
  }
  for (const scenario of scenarios) {
    const selected = rows.filter((row) => row.scenario === scenario);
    for (const row of selected) assert.deepEqual(row.outputHashes, selected[0].outputHashes);
  }
  const summary = scenarios.flatMap((scenario) =>
    lanes.map((lane) => {
      const selected = rows.filter(
        (row) => row.scenario === scenario && row.label === lane.label && row.mode === lane.mode,
      );
      return {
        scenario,
        label: lane.label,
        mode: lane.mode,
        n: selected.length,
        ...Object.fromEntries(
          ["importMs", "setupMs", "firstMs", "startupMs"].map((key) => [
            key,
            median(selected.map((row) => row[key])),
          ]),
        ),
        warmMs: median(selected.map((row) => median(row.warmMs))),
      };
    }),
  );
  writeFileSync(
    output,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        node: process.version,
        baselineSha256: hash(readFileSync(baseline)),
        candidateSha256: hash(readFileSync(candidate)),
        inputsSha256: hash(readFileSync(inputs)),
        summary,
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  rmSync(root, { recursive: true, force: true });
}
