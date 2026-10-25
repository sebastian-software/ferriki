// Follow up the small source-Auto difference with longer, paired measurements.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
if (process.argv[2] === "--worker") {
  const [facade, inputs, cache] = process.argv.slice(3);
  const { documents } = JSON.parse(readFileSync(inputs)).find((x) => x.id === "repository");
  const { createHighlighter } = await import(pathToFileURL(facade));
  const h = await createHighlighter({
    langs: [...new Set(documents.map((d) => d.lang))],
    themes: ["github-dark"],
    regexMode: "auto",
    assets: { remote: false, cacheDir: cache },
  });
  const run = () =>
    documents.map((d) => h.codeToHtml(d.code, { lang: d.lang, theme: "github-dark" }));
  const hashes = (output) => output.map((html) => createHash("sha256").update(html).digest("hex"));
  const expected = hashes(run());
  for (let i = 0; i < 20; i++) run();
  const times = [];
  const perDocument = documents.map(() => []);
  let last;
  for (let i = 0; i < 30; i++) {
    const started = performance.now();
    last = documents.map((d, index) => {
      const t = performance.now();
      const html = h.codeToHtml(d.code, { lang: d.lang, theme: "github-dark" });
      perDocument[index].push(performance.now() - t);
      return html;
    });
    times.push(performance.now() - started);
  }
  assert.deepEqual(hashes(last), expected);
  const diagnostics = h.getRegexDiagnostics();
  assert.equal(diagnostics.preparedArchives, 0);
  assert.equal(diagnostics.loadedPreparedGroups, 0);
  h.dispose();
  console.log(
    JSON.stringify({
      times,
      outputHashes: expected,
      diagnostics,
      documents: documents.map((d, i) => ({
        lang: d.lang,
        sha256: d.sha256,
        times: perDocument[i],
      })),
    }),
  );
} else {
  const [facade, inputs, cache, baseline, candidate, output] = process.argv.slice(2);
  const lanes = [
    ["2.7.0", baseline],
    ["2.7.1", candidate],
  ];
  const rows = [];
  for (let repeat = 0; repeat < 5; repeat++) {
    for (const [version, addon] of repeat % 2 ? [...lanes].reverse() : lanes) {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--worker", facade, inputs, cache],
        {
          env: { ...process.env, FERRIKI_BENCH_ADDON: addon },
          encoding: "utf8",
          timeout: 120_000,
        },
      );
      assert.equal(child.status, 0, child.stderr);
      const row = { version, repeat, ...JSON.parse(child.stdout) };
      assert.deepEqual(row.outputHashes, rows[0]?.outputHashes ?? row.outputHashes);
      rows.push(row);
      console.error(`${version} #${repeat}: ${median(row.times).toFixed(3)} ms`);
    }
  }
  writeFileSync(
    output,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        warmup: 20,
        passes: 30,
        summary: lanes.map(([version]) => ({
          version,
          medianMs: median(rows.filter((r) => r.version === version).map((r) => median(r.times))),
        })),
        rows,
      },
      null,
      2,
    ) + "\n",
  );
}
