import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import "./test-asset-env.mjs";

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

export function validateOutput(id, code, html, reference) {
  const tree = fromHtml(html, { fragment: true });
  assert.equal(toString(tree), code, `${id}: HTML changed the source or failed to escape it`);
  assert.match(html, /<span\b/, `${id}: no highlighted spans (plaintext fallback)`);
  assert.ok(
    collectHighlightSignatures(tree).size > 1,
    `${id}: no distinct syntax colors or token classes (plaintext fallback)`,
  );
  return {
    sourcePreserved: true,
    highlighted: true,
    referenceParity: id === "prism" ? null : { html: html === reference.html },
    htmlSha256: sha256(html),
  };
}

function collectHighlightSignatures(root) {
  const signatures = new Set();
  const styledProperties = new Set([
    "color",
    "background-color",
    "font-style",
    "font-weight",
    "text-decoration",
  ]);
  const visit = (node) => {
    if (node.type === "element" && node.tagName === "span") {
      const style = node.properties?.style;
      if (typeof style === "string") {
        const declarations = style
          .split(";")
          .map((declaration) => declaration.trim())
          .filter((declaration) => {
            const separator = declaration.indexOf(":");
            return separator > 0 && styledProperties.has(declaration.slice(0, separator).trim());
          })
          .sort();
        if (declarations.length > 0) signatures.add(`style:${declarations.join(";")}`);
      }

      const classNames = node.properties?.className;
      const classes = Array.isArray(classNames)
        ? classNames
        : typeof classNames === "string"
          ? classNames.split(/\s+/)
          : [];
      if (classes.includes("token")) {
        const tokenClasses = classes.filter((className) => className !== "token").sort();
        if (tokenClasses.length > 0) signatures.add(`class:${tokenClasses.join(" ")}`);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return signatures;
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
    dispose: () => highlighter.dispose(),
  };
}

export function compareReports(baseline, candidate, { isolation = "ferroni" } = {}) {
  assert.ok(["ferroni", "ferriki"].includes(isolation), "Invalid comparison isolation");
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
  if (isolation === "ferroni") {
    assert.equal(
      candidate.nativeBuild.ferriki.commit,
      baseline.nativeBuild.ferriki.commit,
      "Ferriki must stay on the same commit when isolating Ferroni",
    );
    assert.equal(
      candidate.nativeBuild.rustSourceSha256,
      baseline.nativeBuild.rustSourceSha256,
      "Ferriki Rust source must stay unchanged when isolating Ferroni",
    );
  } else {
    assert.deepEqual(
      candidate.nativeBuild.ferroni,
      baseline.nativeBuild.ferroni,
      "Ferroni must stay unchanged when isolating Ferriki",
    );
    assert.equal(candidate.revision.commit, baseline.revision.commit, "Benchmark facade changed");
  }
  for (const key of [
    "rustc",
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
      const exact = (result) => result?.status === "ok" && result.validation.referenceParity.html;
      if (!exact(a) || !exact(b) || a.validation.htmlSha256 !== b.validation.htmlSha256) {
        excluded.push({
          language: language.name,
          size: entry.size,
          reason: "Missing timing or changed/non-parity output",
        });
        continue;
      }
      const baselineMs = a.html.medianMs;
      const candidateMs = b.html.medianMs;
      comparisons.push({
        language: language.name,
        size: entry.size,
        api: "html",
        baselineMs,
        candidateMs,
        changePercent: 100 * (candidateMs / baselineMs - 1),
      });
    }
  }
  return {
    baselineFerroni: baseline.nativeBuild.ferroni,
    candidateFerroni: candidate.nativeBuild.ferroni,
    comparisons: comparisons.sort((a, b) => b.changePercent - a.changePercent),
    excluded,
  };
}
