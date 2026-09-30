import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export function loadCorpus(id = "tiobe") {
  assert.ok(["tiobe", "curated"].includes(id), "Invalid --corpus: choose tiobe or curated");
  return JSON.parse(
    readFileSync(new URL(`../benchmarks/${id}/manifest.json`, import.meta.url), "utf8"),
  );
}
export const manifest = loadCorpus();
export const engines = ["ferriki", "shiki-wasm", "shiki-js", "prism"];
export const theme = "github-dark";
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const plain = (value) => JSON.parse(JSON.stringify(value));
export function readReport(path) {
  const bytes = readFileSync(path);
  return JSON.parse((path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}

export function loadCases(language, sizes, corpus = "tiobe") {
  if (!language.file) return [];
  const source = readFileSync(
    new URL(`../benchmarks/${corpus}/fixtures/${language.file}`, import.meta.url),
    "utf8",
  );
  return sizes.map((size) => {
    const copies = size === "large" ? 16 : 1;
    const code = source.repeat(copies);
    return {
      size,
      copies,
      code,
      bytes: Buffer.byteLength(code),
      lines: code.split("\n").length,
      sha256: sha256(code),
    };
  });
}

export function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
}

export function statistics(samplesMs, bytes) {
  const medianMs = quantile(samplesMs, 0.5);
  return {
    samplesMs,
    medianMs,
    p95Ms: quantile(samplesMs, 0.95),
    minMs: samplesMs.reduce((a, b) => Math.min(a, b), Infinity),
    maxMs: samplesMs.reduce((a, b) => Math.max(a, b), -Infinity),
    mibPerSecond: bytes / 2 ** 20 / (medianMs / 1000),
  };
}

export function validateOutput(id, code, tokens, html, reference) {
  const tokenText =
    id === "prism"
      ? flattenPrism(tokens)
      : tokens.map((line) => line.map((token) => token.content).join("")).join("\n");
  assert.equal(tokenText, code, `${id}: tokenization changed the source`);
  assert.equal(
    toString(fromHtml(html, { fragment: true })),
    code,
    `${id}: HTML changed the source or failed to escape it`,
  );
  assert.match(html, /<span\b/, `${id}: no highlighted spans (plaintext fallback)`);
  if (id === "prism") {
    assert.ok(
      tokens.some((token) => typeof token !== "string"),
      "Prism returned only plaintext",
    );
  } else {
    assert.ok(
      new Set(tokens.flat().map((token) => token.color)).size > 1,
      `${id}: only one token color (plaintext fallback)`,
    );
  }
  return {
    sourcePreserved: true,
    highlighted: true,
    referenceParity:
      id === "prism"
        ? null
        : {
            tokens: isDeepStrictEqual(plain(tokens), reference.tokens),
            html: html === reference.html,
          },
    tokensSha256: sha256(JSON.stringify(plain(tokens))),
    htmlSha256: sha256(html),
  };
}

function flattenPrism(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenPrism).join("");
  return flattenPrism(value.content);
}

export async function createEngine(id, language) {
  if (id === "prism") {
    const { default: Prism } = await import("prismjs");
    const { default: loadLanguages } = await import("prismjs/components/index.js");
    loadLanguages([language.prism]);
    const grammar = Prism.languages[language.prism];
    if (!grammar) throw new Error(`Prism has no ${language.prism} grammar`);
    return {
      html: (code) => Prism.highlight(code, grammar, language.prism),
      tokens: (code) => Prism.tokenize(code, grammar),
      dispose() {},
    };
  }
  const module = id === "ferriki" ? await import("../ferriki/index.mjs") : await import("shiki");
  const engine =
    id === "ferriki"
      ? undefined
      : id === "shiki-wasm"
        ? module.createOnigurumaEngine(import("shiki/wasm"))
        : module.createJavaScriptRegexEngine();
  const highlighter = await module.createHighlighter({
    langs: [language.textmate, ...(language.embedded ?? [])],
    themes: [theme],
    engine,
    assets: { remote: false },
  });
  const options = { lang: language.textmate, theme };
  return {
    html: (code) => highlighter.codeToHtml(code, options),
    tokens: (code) => highlighter.codeToTokensBase(code, options),
    dispose: () => highlighter.dispose(),
  };
}

export function compareReports(baseline, candidate) {
  assert.equal(baseline.schema, 1);
  assert.equal(candidate.schema, 1);
  assert.ok(
    baseline.nativeBuild.rustSourceSha256 && candidate.nativeBuild.rustSourceSha256,
    "Rebuild from a Git checkout to compare source revisions",
  );
  for (const key of [
    "corpus",
    "method",
    "versions",
    "machine",
    "assetManifestSha256",
    "harnessSha256",
  ]) {
    assert.deepEqual(candidate[key], baseline[key], `Cannot compare reports with different ${key}`);
  }
  assert.equal(
    candidate.nativeBuild.ferriki.commit,
    baseline.nativeBuild.ferriki.commit,
    "Ferriki must stay on the same commit when isolating Ferroni",
  );
  for (const key of [
    "rustc",
    "rustSourceSha256",
    "rustflags",
    "encodedRustflags",
    "targetRustflags",
    "cargoProfileEnv",
  ]) {
    assert.deepEqual(
      candidate.nativeBuild[key],
      baseline.nativeBuild[key],
      `Different native build ${key}`,
    );
  }
  const before = new Map(baseline.languages.map((row) => [row.rank, row]));
  assert.deepEqual(
    candidate.nativeBuild.ferroni.features,
    baseline.nativeBuild.ferroni.features,
    "Ferroni features differ",
  );
  assert.deepEqual(
    candidate.languages.map((row) => row.rank),
    baseline.languages.map((row) => row.rank),
  );
  const comparisons = [];
  const excluded = [];
  for (const language of candidate.languages) {
    const previous = before.get(language.rank);
    if (!language.file) {
      excluded.push({ language: language.name, reason: language.unsupported });
      continue;
    }
    for (const size of candidate.method.sizes) {
      const entry = language.cases?.find((item) => item.size === size);
      const old = previous.cases?.find((item) => item.size === size);
      if (!entry || !old) {
        excluded.push({
          language: language.name,
          size,
          reason: "Language failed or timed out in at least one run",
        });
        continue;
      }
      assert.equal(entry.sha256, old.sha256, "Source changed between runs");
      const a = old.results.ferriki;
      const b = entry.results.ferriki;
      const exact = (result) =>
        result?.status === "ok" &&
        result.validation.referenceParity.tokens &&
        result.validation.referenceParity.html;
      if (
        !exact(a) ||
        !exact(b) ||
        a.validation.tokensSha256 !== b.validation.tokensSha256 ||
        a.validation.htmlSha256 !== b.validation.htmlSha256
      ) {
        excluded.push({
          language: language.name,
          size: entry.size,
          reason: "Missing timing or changed/non-parity output",
        });
        continue;
      }
      for (const api of ["html", "tokens"]) {
        const baselineMs = a[api].medianMs;
        const candidateMs = b[api].medianMs;
        comparisons.push({
          language: language.name,
          size: entry.size,
          api,
          baselineMs,
          candidateMs,
          changePercent: 100 * (candidateMs / baselineMs - 1),
        });
      }
    }
  }
  return {
    baselineFerroni: baseline.nativeBuild.ferroni,
    candidateFerroni: candidate.nativeBuild.ferroni,
    comparisons: comparisons.sort((a, b) => b.changePercent - a.changePercent),
    excluded,
  };
}
