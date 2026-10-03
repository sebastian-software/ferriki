import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as shiki from "shiki";
import {
  checkPhikiPrerequisites,
  createPhikiSetup,
  JsonLineWorker,
  renderPhikiCold,
  startPhikiWorker,
} from "./phiki-benchmark.mjs";
import { compareHighlightedHtml } from "./phiki-html-agreement.mjs";

const nodeRoot = fileURLToPath(new URL("..", import.meta.url));
const theme = "github-dark";

function simulatedWorker(script) {
  return new JsonLineWorker(
    spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] }),
  );
}

function epipeWorker() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.end = () => {};
  child.stdin.write = (_value, callback) => {
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    queueMicrotask(() => {
      child.stdin.emit("error", error);
      callback?.(error);
    });
    return false;
  };
  child.kill = () => {
    child.signalCode = "SIGTERM";
    child.stderr.end("simulated early stdin close");
    child.stdout.end();
    queueMicrotask(() => child.emit("close", null, child.signalCode));
    return true;
  };

  const worker = new JsonLineWorker(child);
  child.stdout.write('{"ready":true,"runtime":{}}\n');
  return worker;
}

function acknowledgedEpipeWorker(exitCode) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.end = () => {
    child.exitCode = exitCode;
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", exitCode, null));
  };
  child.stdin.write = (value, callback) => {
    if (JSON.parse(value).op === "shutdown") {
      child.stdout.write('{"shutdown":true}\n');
      queueMicrotask(() => {
        const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        child.stdin.emit("error", error);
        callback?.(error);
      });
    }
    return true;
  };
  child.kill = () => {
    child.signalCode = "SIGTERM";
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", null, child.signalCode));
    return true;
  };

  const worker = new JsonLineWorker(child);
  child.stdout.write('{"ready":true,"runtime":{}}\n');
  return worker;
}

test("PHP worker close is acknowledged and idempotent", async () => {
  const worker = simulatedWorker(`
    process.stdout.write('{"ready":true,"runtime":{}}\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      if (JSON.parse(line).op === 'shutdown') process.stdout.write('{"shutdown":true}\\n');
    });
  `);

  assert.equal((await worker.receive()).ready, true);
  const closing = worker.close();
  assert.equal(worker.close(), closing);
  await closing;
});

test("PHP worker shutdown EPIPE rejects with diagnostics instead of an uncaught error", async () => {
  const worker = epipeWorker();
  assert.equal((await worker.receive()).ready, true);
  await assert.rejects(worker.close(), /PHP worker stdin failed \(EPIPE\)/);
  await assert.rejects(worker.close(), /PHP worker stdin failed \(EPIPE\)/);
});

test("PHP worker accepts EPIPE only after acknowledged shutdown and zero-status exit", async () => {
  const worker = acknowledgedEpipeWorker(0);
  assert.equal((await worker.receive()).ready, true);
  await worker.close();
  assert.equal(worker.child.exitCode, 0);
});

test("PHP worker does not hide a nonzero exit after shutdown acknowledgement", async () => {
  const worker = acknowledgedEpipeWorker(17);
  assert.equal((await worker.receive()).ready, true);
  await assert.rejects(worker.close(), /status 17/);
});

test("PHP worker malformed JSON is a terminal failure for pending and future requests", async () => {
  const worker = simulatedWorker(`
    process.stdout.write('{"ready":true,"runtime":{}}\\n');
    require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
      process.stdout.write('not-json\\n');
    });
  `);

  assert.equal((await worker.receive()).ready, true);
  await assert.rejects(worker.request({ op: "render", code: "{}", lang: "json" }), /invalid JSON/);
  await assert.rejects(worker.receive(), /invalid JSON/);
  await worker.exit;
});

test("PHP worker rejects a shutdown response without an acknowledgement", async () => {
  const worker = simulatedWorker(`
    process.stdout.write('{"ready":true,"runtime":{}}\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      if (JSON.parse(line).op === 'shutdown') process.stdout.write('{"shutdown":false}\\n');
    });
  `);

  assert.equal((await worker.receive()).ready, true);
  await assert.rejects(worker.close(), /did not acknowledge shutdown/);
});

test("PHP worker premature exit rejects pending renders with exit status and stderr", async () => {
  const worker = simulatedWorker(`
    process.stdout.write('{"ready":true,"runtime":{}}\\n');
    require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
      process.stderr.write('simulated render crash\\n');
      process.exit(23);
    });
  `);

  assert.equal((await worker.receive()).ready, true);
  await assert.rejects(worker.request({ op: "render", code: "{}", lang: "json" }), (error) => {
    assert.match(error.message, /status 23/);
    assert.match(error.message, /simulated render crash/);
    return true;
  });
  await worker.exit;
});

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
