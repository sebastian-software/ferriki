import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { coldSamples } from "./benchmark-schedule.mjs";
import { checkCurrentComparators } from "./check-benchmark-versions.mjs";
import { mergeShards, readShard } from "./merge-blacksmith-comparison.mjs";
import { regexModes, usesStandardGrammar } from "./regex-benchmark-modes.mjs";
import { comparisonCorpora } from "./run-blacksmith-comparison.mjs";

const archive = new URL(
  "../../docs/benchmarks/blacksmith/2026-10-10/linux-x86-64/",
  import.meta.url,
);
const originalContext = JSON.parse(readFileSync(new URL("context.json", archive), "utf8"));
const originals = Object.fromEntries(
  comparisonCorpora.flatMap((corpus) =>
    ["on", "off"].map((mode) => {
      const name = `${corpus}-${mode}.json`;
      return [name, gunzipSync(readFileSync(new URL(`${name}.gz`, archive)))];
    }),
  ),
);

function fixtures(directory, mutate = () => {}) {
  return comparisonCorpora.map((corpus) => {
    const path = join(directory, corpus);
    mkdirSync(join(path, "logs"), { recursive: true });
    const context = { ...structuredClone(originalContext), corpora: [corpus] };
    const files = new Map([
      ["validation.json", Buffer.from('{"ok":true,"errors":[]}')],
      ...["on", "off"].flatMap((mode) => [
        [`${corpus}-${mode}.json`, originals[`${corpus}-${mode}.json`]],
        [`logs/${corpus}-${mode}.log`, Buffer.from(`${corpus}-${mode} retained log\n`)],
      ]),
    ]);
    mutate(corpus, context, files);
    files.set("context.json", Buffer.from(JSON.stringify(context)));
    for (const [name, bytes] of files) writeFileSync(join(path, name), bytes);
    writeFileSync(
      join(path, "SHA256SUMS"),
      [...files]
        .map(([name, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`)
        .join(""),
    );
    return path;
  });
}

function temporary(run) {
  const directory = mkdtempSync(join(os.tmpdir(), "ferriki-shards-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("cold rounds keep fresh calls serial, balanced and attached to their engine", () => {
  const calls = [];
  const samples = coldSamples(["native", "wasm", "js"], 3, (id) => {
    calls.push(id);
    return `${id}-${calls.length}`;
  });
  assert.deepEqual(calls, ["native", "wasm", "js", "wasm", "js", "native", "js", "native", "wasm"]);
  assert.deepEqual(samples.native, ["native-1", "native-6", "native-8"]);
  assert.equal(samples.wasm.length, 3);
  assert.throws(
    () =>
      coldSamples(["native", "wasm"], 3, () => {
        throw new Error("failed child");
      }),
    /failed child/,
  );
});

test("current-release guard rejects stale pins, registry errors and non-stable tags", async () => {
  const installed = { shiki: "4.5.0", prismjs: "1.30.0" };
  const registry = async (url) => ({
    ok: true,
    json: async () => ({ version: url.includes("/shiki/") ? "4.5.0" : "1.30.0" }),
  });
  assert.deepEqual(await checkCurrentComparators(installed, registry), installed);
  await assert.rejects(
    checkCurrentComparators({ ...installed, shiki: "4.4.3" }, registry),
    /outdated/,
  );
  await assert.rejects(
    checkCurrentComparators(installed, async () => ({ ok: false, status: 503 })),
    /HTTP 503/,
  );
  await assert.rejects(
    checkCurrentComparators(installed, async () => ({
      ok: true,
      json: async () => ({ version: "5.0.0-beta.1" }),
    })),
    /stable/,
  );
});

test("corpus merge retains every original report and the VM's own context", () =>
  temporary((directory) => {
    const sources = fixtures(directory);
    const output = join(directory, "merged");
    const { context, reports } = mergeShards(output, sources);
    assert.equal(Object.keys(reports).length, 6);
    assert.deepEqual(context.corpora, comparisonCorpora);
    for (const corpus of comparisonCorpora) {
      assert.deepEqual(
        readFileSync(join(output, "contexts", `${corpus}.json`)),
        readFileSync(join(directory, corpus, "context.json")),
      );
      for (const mode of ["on", "off"])
        assert.deepEqual(
          readFileSync(join(output, `${corpus}-${mode}.json`)),
          originals[`${corpus}-${mode}.json`],
        );
    }
    assert.match(readFileSync(join(output, "SHA256SUMS"), "utf8"), /contexts\/curated.json/);
    assert.equal(JSON.parse(readFileSync(join(output, "validation.json"))).ok, true);
    assert.throws(() => mergeShards(join(directory, "missing"), sources.slice(1)), /all three/);
    assert.throws(
      () => mergeShards(join(directory, "duplicate"), [sources[0], sources[0], sources[2]]),
      /Duplicate/,
    );
    writeFileSync(join(sources[0], "comparison-on.json"), "edited");
    assert.throws(() => mergeShards(join(directory, "edited"), sources), /Artifact changed/);
  }));

test("mode shards retain distinct corpus hardware without combining timings across VMs", () =>
  temporary((directory) => {
    const diagnostics = (mode, requiresPrepared = mode === "prepared") => ({
      mode,
      staticScanners: 1,
      dynamicScanners: 0,
      offScanners: Number(mode === "off"),
      autoScanners: Number(mode === "auto"),
      eagerScanners: Number(["eager", "prepared"].includes(mode)),
      assemblyFallbacks: 0,
      invalidPreparedGroups: 0,
      preparedArchives: Number(requiresPrepared),
      loadedPreparedGroups: Number(requiresPrepared),
      requiresPrepared,
    });
    const sources = fixtures(directory, (corpus, context, files) => {
      context.regexModes = regexModes;
      context.cpu = `CPU for ${corpus}`;
      const report = JSON.parse(files.get(`${corpus}-on.json`));
      report.schema = 2;
      delete report.method.regexPrefilter;
      report.method.regexModes = regexModes;
      if (corpus === "comparison") {
        for (const id of Object.keys(regexModes)) {
          report.cold[id] = structuredClone(report.cold.ferriki);
          report.agreement[id] = structuredClone(report.agreement.ferriki);
          report.warmTotalMs.codeToHtml[id] = report.warmTotalMs.codeToHtml.ferriki;
          for (const row of report.warm.codeToHtml) row.samplesMs[id] = [...row.samplesMs.ferriki];
        }
        report.regexDiagnostics = Object.fromEntries(
          Object.entries(regexModes).map(([id, mode]) => [id, diagnostics(mode)]),
        );
        report.coldRegexDiagnostics = Object.fromEntries(
          Object.entries(regexModes).map(([id, mode]) => [
            id,
            Array.from({ length: report.method.coldRuns }, () => diagnostics(mode)),
          ]),
        );
      } else
        for (const language of report.languages) {
          if (!language.file) continue;
          language.regexDiagnostics = Object.fromEntries(
            Object.entries(regexModes).map(([id, mode]) => [
              id,
              diagnostics(mode, mode === "prepared" && usesStandardGrammar(language)),
            ]),
          );
          for (const entry of language.cases)
            for (const id of Object.keys(regexModes))
              entry.results[id] = structuredClone(entry.results.ferriki);
        }
      for (const mode of ["on", "off"]) {
        files.delete(`${corpus}-${mode}.json`);
        files.delete(`logs/${corpus}-${mode}.log`);
      }
      files.set(`${corpus}-modes.json`, Buffer.from(JSON.stringify(report)));
      files.set(`logs/${corpus}-modes.log`, Buffer.from("mode capture log\n"));
    });
    const { context, reports } = mergeShards(join(directory, "modes"), sources);
    assert.equal(Object.keys(reports).length, 3);
    assert.equal(context.corpusContexts.curated.cpu, "CPU for curated");
    assert.match(
      readFileSync(join(directory, "modes", "summary.md"), "utf8"),
      /curated: CPU for curated/,
    );
  }));

test("merge rejects mismatched builds, failed shards and output changes even with valid checksums", () => {
  for (const mutate of [
    (_corpus, context) => {
      context.commit = "f".repeat(40);
    },
    (_corpus, context) => {
      context.rustc = "different compiler";
    },
    (_corpus, context) => {
      context.cpu = "different CPU";
    },
    (_corpus, context) => {
      context.nativeBuild.rustflags = "-C target-cpu=native";
    },
    (_corpus, context) => {
      context.status = " M source.rs";
    },
    (_corpus, _context, files) => {
      files.set("validation.json", Buffer.from('{"ok":false}'));
    },
    (corpus, _context, files) => {
      const report = JSON.parse(files.get(`${corpus}-on.json`));
      report.languages[0].cases[0].results.ferriki.validation.referenceParity.html = false;
      files.set(`${corpus}-on.json`, Buffer.from(JSON.stringify(report)));
    },
  ])
    temporary((directory) => {
      const sources = fixtures(directory, (corpus, context, files) => {
        if (corpus === "curated") mutate(corpus, context, files);
      });
      assert.throws(() => mergeShards(join(directory, "invalid"), sources));
    });
});

test("each corpus keeps its own binary receipt when identical inputs produce different binaries", () =>
  temporary((directory) => {
    const binarySha256 = "b".repeat(64);
    const sources = fixtures(directory, (corpus, context, files) => {
      if (corpus !== "curated") return;
      context.nativeBuild.binarySha256 = binarySha256;
      for (const mode of ["on", "off"]) {
        const name = `${corpus}-${mode}.json`;
        const report = JSON.parse(files.get(name));
        report.nativeBuild.binarySha256 = binarySha256;
        files.set(name, Buffer.from(JSON.stringify(report)));
      }
    });
    const { context, reports } = mergeShards(join(directory, "merged"), sources);
    assert.equal(context.corpusContexts.curated.nativeBuild.binarySha256, binarySha256);
    assert.equal(reports["curated-on"].nativeBuild.binarySha256, binarySha256);
    assert.notEqual(context.nativeBuild.binarySha256, binarySha256);
  }));

test("archived compressed shards preserve original checksums and reject edited bytes", () =>
  temporary((directory) => {
    const [path] = fixtures(directory);
    const original = readShard(path);
    writeFileSync(join(path, "ORIGINAL_SHA256SUMS"), readFileSync(join(path, "SHA256SUMS")));
    rmSync(join(path, "SHA256SUMS"));
    for (const [name, bytes] of original.original) {
      writeFileSync(join(path, `${name}.gz`), gzipSync(bytes));
      rmSync(join(path, name));
    }
    assert.deepEqual(readShard(path), original);
    writeFileSync(join(path, "comparison-on.json.gz"), gzipSync(Buffer.from("edited")));
    assert.throws(() => readShard(path), /Artifact changed/);
  }));
