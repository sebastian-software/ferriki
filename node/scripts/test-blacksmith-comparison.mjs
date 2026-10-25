import assert from "node:assert/strict";
import { test } from "node:test";
import { regexModes, usesStandardGrammar } from "./regex-benchmark-modes.mjs";
import { renderSummary, validateReport } from "./run-blacksmith-comparison.mjs";
import { comparisonCorpus } from "./shiki-comparison-corpus.mjs";
import { engines, loadCorpus, yamlJavaScriptUnsupported } from "./tiobe-benchmark.mjs";

function corpusReport(corpus) {
  return {
    corpus: { id: corpus },
    method: { regexPrefilter: true, minRounds: 2 },
    languages: loadCorpus(corpus).languages.map((language) => ({
      ...language,
      status: language.file ? "measured" : "unsupported",
      ...(language.file
        ? {
            cases: ["example", "large"].map((size) => ({
              size,
              results: Object.fromEntries(
                engines.map((id) => [
                  id,
                  id === "prism" && !language.prism
                    ? { status: "unsupported" }
                    : {
                        status: "ok",
                        validation: {
                          sourcePreserved: true,
                          ...(id === "prism" ? {} : { referenceParity: { html: true } }),
                        },
                        html: { samplesMs: [1, 2], medianMs: 1.5 },
                      },
                ]),
              ),
            })),
          }
        : {}),
    })),
  };
}

test("both complete corpora pass, including explicit unsupported grammars", () => {
  for (const corpus of ["curated", "tiobe"]) validateReport(corpusReport(corpus), corpus, true);
});

test("mode reports require all four native contenders and independently checked archive use", () => {
  const report = corpusReport("curated");
  report.schema = 2;
  report.method = { minRounds: 2, regexModes };
  for (const language of report.languages) {
    language.regexDiagnostics = Object.fromEntries(
      Object.entries(regexModes).map(([id, mode]) => [
        id,
        {
          mode,
          staticScanners: 1,
          dynamicScanners: 0,
          offScanners: Number(mode === "off"),
          autoScanners: Number(mode === "auto"),
          eagerScanners: Number(["eager", "prepared"].includes(mode)),
          assemblyFallbacks: 0,
          invalidPreparedGroups: 0,
          preparedArchives: Number(mode === "prepared"),
          loadedPreparedGroups: Number(mode === "prepared"),
          requiresPrepared: mode === "prepared" && usesStandardGrammar(language),
        },
      ]),
    );
    for (const entry of language.cases ?? [])
      for (const id of Object.keys(regexModes))
        entry.results[id] = structuredClone(entry.results.ferriki);
  }
  validateReport(report, "curated", true);
  assert.match(
    renderSummary({ "curated-modes": report }, { profile: "test", regexModes }),
    /source Auto \(lazy DFA\)/,
  );
  for (const mutate of [
    (value) => {
      delete value.languages[0].cases[0].results["ferriki-eager"];
    },
    (value) => {
      value.method.regexModes.ferriki = "prepared";
    },
    (value) => {
      value.languages[0].regexDiagnostics.ferriki.preparedArchives = 1;
    },
    (value) => {
      value.languages[0].regexDiagnostics.ferriki.autoScanners = 0;
      value.languages[0].regexDiagnostics.ferriki.offScanners = 1;
    },
    (value) => {
      const snapshot = value.languages[0].regexDiagnostics["ferriki-precompiled"];
      snapshot.requiresPrepared = false;
      snapshot.loadedPreparedGroups = 0;
    },
  ]) {
    const invalid = structuredClone(report);
    mutate(invalid);
    assert.throws(() => validateReport(invalid, "curated", true));
  }
});

test("only the known YAML JavaScript converter limit may omit corpus timings", () => {
  const report = corpusReport("curated");
  const yaml = report.languages.find((language) => language.textmate === "yaml");
  for (const entry of yaml.cases)
    entry.results["shiki-js"] = {
      status: "unsupported",
      reason: yamlJavaScriptUnsupported,
    };
  validateReport(report, "curated", true);
  yaml.cases[0].results["shiki-js"].reason = "Unexpected rendering failure";
  assert.throws(() => validateReport(report, "curated", true));
  yaml.cases[0].results["shiki-js"].reason = yamlJavaScriptUnsupported;
  yaml.cases[0].results.ferriki = { status: "unsupported", reason: yamlJavaScriptUnsupported };
  assert.throws(() => validateReport(report, "curated", true));
});

test("partial, timed-out, mismatching or invalid reports cannot produce a green job", () => {
  for (const mutate of [
    (report) => {
      report.method.regexPrefilter = false;
    },
    (report) => {
      report.languages.pop();
    },
    (report) => {
      report.languages[0].status = "timeout";
    },
    (report) => {
      report.languages[0].cases.pop();
    },
    (report) => {
      report.languages[0].cases[0].results.ferriki.validation.sourcePreserved = false;
    },
    (report) => {
      report.languages[0].cases[0].results.ferriki.validation.referenceParity.html = false;
    },
    (report) => {
      report.languages[0].cases[0].results.ferriki.html.samplesMs = [];
    },
    (report) => {
      report.languages[0].cases[0].results.ferriki.html.samplesMs[0] = Number.NaN;
    },
  ]) {
    const report = corpusReport("curated");
    mutate(report);
    assert.throws(() => validateReport(report, "curated", true));
  }
});

test("repository reports require raw cold and warm samples and complete HTML agreement", () => {
  const ids = engines.filter((id) => id !== "prism");
  const samples = Object.fromEntries(ids.map((id) => [id, [1, 2]]));
  const report = {
    method: { regexPrefilter: true, minSamples: 2, coldRuns: 2 },
    warm: {
      codeToHtml: comparisonCorpus.map(([, path]) => ({
        path,
        sha256: "a".repeat(64),
        samplesMs: structuredClone(samples),
      })),
    },
    agreement: Object.fromEntries(ids.map((id) => [id, { documents: comparisonCorpus.length }])),
    cold: Object.fromEntries(ids.map((id) => [id, { samplesMs: [1, 2] }])),
  };
  validateReport(report, "comparison", true);
  const mismatch = structuredClone(report);
  mismatch.agreement.ferriki.documents--;
  assert.throws(() => validateReport(mismatch, "comparison", true), /HTML mismatch/);
  const unsupported = structuredClone(report);
  const yaml = unsupported.warm.codeToHtml.find((row) => row.path.endsWith("ci.yml"));
  yaml.unsupported = { "shiki-js": yamlJavaScriptUnsupported };
  delete yaml.samplesMs["shiki-js"];
  unsupported.agreement["shiki-js"].documents--;
  unsupported.cold["shiki-js"] = { status: "unsupported", paths: [yaml.path] };
  validateReport(unsupported, "comparison", true);
  yaml.unsupported.ferriki = yamlJavaScriptUnsupported;
  assert.throws(() => validateReport(unsupported, "comparison", true));
  report.cold.ferriki.samplesMs = [];
  assert.throws(() => validateReport(report, "comparison", true), /Missing raw/);
});

test("summary exposes JSON/Astro mode differences and incomplete reports", () => {
  const on = corpusReport("curated");
  const off = structuredClone(on);
  for (const row of off.languages)
    for (const entry of row.cases ?? []) entry.results.ferriki.html.medianMs = 3;
  const summary = renderSummary({ "curated-on": on, "curated-off": off }, { profile: "test" }, [
    "missing report",
  ]);
  assert.match(summary, /JSON \| example \| 1\.500 \| 3\.000 \| 100\.00%/);
  assert.match(summary, /Astro \| large/);
  assert.match(summary, /Validation failed/);
  assert.match(summary, /missing report/);
});
