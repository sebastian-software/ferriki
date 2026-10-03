import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as shiki from "shiki";
import {
  checkPhikiPrerequisites,
  createPhikiSetup,
  renderPhikiCold,
  startPhikiWorker,
} from "./phiki-benchmark.mjs";
import { compareHighlightedHtml } from "./phiki-html-agreement.mjs";

const nodeRoot = fileURLToPath(new URL("..", import.meta.url));
const theme = "github-dark";

test("optional prerequisite probe reports an unavailable PHP executable", () => {
  const previousPhp = process.env.FERRIKI_BENCH_PHP;
  process.env.FERRIKI_BENCH_PHP = "ferriki-bench-missing-php";
  try {
    const prerequisites = checkPhikiPrerequisites(nodeRoot);
    assert.equal(prerequisites.status, "skipped");
    assert.match(prerequisites.reason, /PHP executable.*unavailable/);
  } finally {
    if (previousPhp === undefined) delete process.env.FERRIKI_BENCH_PHP;
    else process.env.FERRIKI_BENCH_PHP = previousPhp;
  }
});

test("Phiki warm agreement and cold materialization smoke test", async (t) => {
  const prerequisites = checkPhikiPrerequisites(nodeRoot);
  if (prerequisites.status !== "available") {
    t.skip(`Optional Phiki prerequisites are unavailable: ${prerequisites.reason}`);
    return;
  }

  const fixtureRoot = mkdtempSync(join(tmpdir(), "ferriki-phiki-benchmark-"));
  const doc = { lang: "json", path: "fixture.json", code: "{}" };
  writeFileSync(join(fixtureRoot, doc.path), doc.code);

  let worker;
  try {
    const prepared = await createPhikiSetup({
      nodeRoot,
      repoRoot: fixtureRoot,
      langs: [doc.lang, "typescript", "markdown", "cpp"],
      theme,
      docs: [doc],
      prerequisites,
    });
    const cppMacro = prepared.assets.injections.find((entry) => entry.name === "cpp-macro");
    const externalTagInjection = prepared.assets.injections.find(
      (entry) => entry.name === "es-tag-sql",
    );
    assert.equal(cppMacro?.activation, "registered-as-recursive-embedded-grammar");
    assert.equal(externalTagInjection?.activation, "unsupported-external-injection-activation");
    assert.match(externalTagInjection.sha256, /^[a-f0-9]{64}$/);

    const started = await startPhikiWorker(nodeRoot, prepared);
    worker = started.worker;
    assert.equal(started.runtime.sapi, "cli");
    assert.equal(started.runtime.mbstring, true);
    assert.ok(started.runtime.oniguruma);
    assert.ok(started.runtime.opcache);
    assert.match(started.runtime.phiki, /^v?2\.2\.1$/);

    const result = await worker.request({
      op: "render",
      lang: doc.lang,
      code: doc.code,
      includeHtml: true,
    });
    assert.equal(result.ok, true);
    assert.ok(result.elapsedNs > 0);
    assert.ok(result.html.length > 0);

    const reference = await shiki.createHighlighter({
      langs: [doc.lang],
      themes: [theme],
      engine: shiki.createOnigurumaEngine(import("shiki/wasm")),
    });
    try {
      const agreement = compareHighlightedHtml(
        reference.codeToHtml(doc.code, { lang: doc.lang, theme }),
        result.html,
        doc.code,
      );
      assert.equal(agreement.agrees, true);
      assert.equal(agreement.removedFinalNewlineSentinel, true);
    } finally {
      reference.dispose();
    }

    await worker.close();
    worker = undefined;
    const coldElapsedMs = renderPhikiCold(nodeRoot, prepared, [doc]);
    assert.ok(Number.isFinite(coldElapsedMs) && coldElapsedMs > 0);
  } finally {
    if (worker) await worker.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
