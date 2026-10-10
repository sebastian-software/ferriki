import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import Prism from "prismjs";
import loadLanguages from "prismjs/components/index.js";
import { createHighlighter as createFerrikiHighlighter } from "../ferriki/index.mjs";
import * as shiki from "shiki";
import "./test-asset-env.mjs";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const nodeRoot = dirname(dirname(scriptPath));
const repoRoot = dirname(nodeRoot);
const resultRoot = join(nodeRoot, "benchmarks/curated/results/prism-investigation");
const manifestPath = join(resultRoot, "fixtures.json");
const outputPath = process.argv[2]
  ? join(repoRoot, process.argv[2])
  : join(resultRoot, "quality.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const digestFile = (path) => sha256(readFileSync(path));

function collectNodes(node, predicate, output = []) {
  if (predicate(node)) output.push(node);
  for (const child of node.children ?? []) collectNodes(child, predicate, output);
  return output;
}

function classes(node) {
  const value = node.properties?.className ?? node.properties?.class ?? [];
  return Array.isArray(value) ? value : String(value).split(/\s+/u).filter(Boolean);
}

function prismGrammarClosure(names, components) {
  const result = new Set();
  const visit = (name) => {
    if (result.has(name)) return;
    const entry = components.languages[name];
    assert.ok(entry, `No Prism ${name} component in pinned package`);
    result.add(name);
    const dependencies = Array.isArray(entry.require)
      ? entry.require
      : entry.require
        ? [entry.require]
        : [];
    dependencies.forEach(visit);
  };
  names.filter(Boolean).forEach(visit);
  return [...result].sort();
}

function assertSourcePreserved(id, html, code) {
  const actual = toString(fromHtml(html, { fragment: true }));
  assert.equal(actual, code, `${id}: rendered HTML changed source text`);
  return true;
}

function typeScriptParseResult(entry, code) {
  if (!entry.syntaxCheck) return null;
  const ts = require("typescript");
  const scriptKind = entry.syntaxCheck === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(entry.file, code, ts.ScriptTarget.Latest, true, scriptKind);
  return {
    parserVersion: ts.version,
    scriptKind: entry.syntaxCheck,
    diagnostics: source.parseDiagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      start: diagnostic.start ?? null,
      length: diagnostic.length ?? null,
    })),
  };
}

const prismPackage = readJson(join(nodeRoot, "node_modules/prismjs/package.json"));
const componentsPath = join(nodeRoot, "node_modules/prismjs/components.json");
const components = readJson(componentsPath);
const prismNames = [...new Set(manifest.cases.map((entry) => entry.prism).filter(Boolean))];
const prismDependencies = prismGrammarClosure(
  [...prismNames, ...manifest.cases.flatMap((entry) => entry.prismDependencies ?? [])],
  components,
);
loadLanguages(prismDependencies);

const allTextmateLanguages = [
  ...new Set(manifest.cases.flatMap((entry) => [entry.language, ...entry.embedded])),
];
const wasmHighlighter = await shiki.createHighlighter({
  langs: allTextmateLanguages,
  themes: [manifest.theme],
  engine: shiki.createOnigurumaEngine(import("shiki/wasm")),
  assets: { remote: false },
});
const jsHighlighter = await shiki.createHighlighter({
  langs: allTextmateLanguages,
  themes: [manifest.theme],
  engine: shiki.createJavaScriptRegexEngine(),
  assets: { remote: false },
});
const ferrikiHighlighter = await createFerrikiHighlighter({
  langs: allTextmateLanguages,
  themes: [manifest.theme],
  assets: { remote: false },
});

const cases = [];
try {
  for (const entry of manifest.cases) {
    const fixturePath = join(resultRoot, entry.file);
    const code = readFileSync(fixturePath, "utf8");
    const wasmHtml = wasmHighlighter.codeToHtml(code, { lang: entry.language, theme: manifest.theme });
    const jsHtml = jsHighlighter.codeToHtml(code, { lang: entry.language, theme: manifest.theme });
    const ferrikiHtml = ferrikiHighlighter.codeToHtml(code, {
      lang: entry.language,
      theme: manifest.theme,
    });
    const ferrikiTokens = [];
    const classOutput = ferrikiHighlighter.codeToHtmlWithCss(code, {
      lang: entry.language,
      theme: manifest.theme,
      styleMode: "classes",
      transformers: [
        {
          tokens(lines) {
            for (const line of lines) {
              for (const token of line) {
                ferrikiTokens.push({
                  content: token.content,
                  offset: token.offset,
                  scopes: [...(token.scopeNames ?? [])],
                  color: token.color ?? null,
                  fontStyle: token.fontStyle ?? null,
                });
              }
            }
            return lines;
          },
        },
      ],
    });

    assertSourcePreserved(entry.id, wasmHtml, code);
    assertSourcePreserved(entry.id, jsHtml, code);
    assertSourcePreserved(entry.id, ferrikiHtml, code);
    assertSourcePreserved(`${entry.id} class mode`, classOutput.html, code);

    const prism = entry.prism
      ? (() => {
          const grammar = Prism.languages[entry.prism];
          assert.ok(grammar, `Prism ${entry.prism} grammar was not loaded`);
          const html = Prism.highlight(code, grammar, entry.prism);
          assertSourcePreserved(`${entry.id} Prism`, html, code);
          const tree = fromHtml(html, { fragment: true });
          const tokenSpans = collectNodes(
            tree,
            (node) => node.type === "element" && classes(node).includes("token"),
          ).map((node) => ({ text: toString(node), classes: classes(node) }));
          return {
            status: "measured",
            language: entry.prism,
            sourcePreserved: true,
            htmlSha256: sha256(html),
            html,
            tokenSpans,
          };
        })()
      : {
          status: "unsupported",
          reason: entry.prismUnsupported,
        };

    const source = readFileSync(fixturePath);
    const tsParse = typeScriptParseResult(entry, code);
    if (tsParse) assert.equal(tsParse.diagnostics.length, 0, `${entry.id}: TypeScript syntax parse failed`);
    const grammarTraceTree = fromHtml(classOutput.html, { fragment: true });
    const exactScopes = collectNodes(
      grammarTraceTree,
      (node) => node.type === "element" && classes(node).some((name) => name.startsWith("exact-")),
    ).map((node) => ({ text: toString(node), classes: classes(node) }));

    cases.push({
      id: entry.id,
      file: entry.file,
      language: entry.language,
      embedded: entry.embedded,
      question: entry.question,
      source: code,
      sourceBytes: source.length,
      sourceSha256: sha256(source),
      syntax: tsParse,
      output: {
        ferrikiInline: {
          sourcePreserved: true,
          exactShikiWasmHtml: ferrikiHtml === wasmHtml,
          htmlSha256: sha256(ferrikiHtml),
          html: ferrikiHtml,
        },
        ferrikiClasses: {
          sourcePreserved: true,
          exactShikiWasmHtml: null,
          htmlSha256: sha256(classOutput.html),
          cssSha256: sha256(classOutput.css),
          html: classOutput.html,
          css: classOutput.css,
          tokens: ferrikiTokens,
          exactScopeSpans: exactScopes,
        },
        shikiWasm: {
          sourcePreserved: true,
          htmlSha256: sha256(wasmHtml),
          html: wasmHtml,
        },
        shikiJs: {
          sourcePreserved: true,
          exactShikiWasmHtml: jsHtml === wasmHtml,
          htmlSha256: sha256(jsHtml),
          html: jsHtml,
        },
        prism,
      },
    });
  }
} finally {
  ferrikiHighlighter.dispose();
  jsHighlighter.dispose();
  wasmHighlighter.dispose();
}

const shikiSource = readJson(join(repoRoot, "node/compat/upstream/shiki/.source.json"));
const textmateSource = readJson(join(repoRoot, "node/compat/upstream/vscode-textmate/.source.json"));
const assetManifestPath = join(nodeRoot, "ferriki/assets/shiki/release-manifest.json");
const assetManifest = readJson(assetManifestPath);
const tmGrammarsPath = join(nodeRoot, "node_modules/tm-grammars/package.json");
const tmGrammarsPackage = readJson(tmGrammarsPath);
const grammarAssets = Object.fromEntries(
  [...new Set(allTextmateLanguages)]
    .map((id) => `languages/${id}.fkgram`)
    .concat(`themes/${manifest.theme}.fktheme`)
    .sort()
    .map((path) => {
      const entry = assetManifest.assets[path];
      assert.ok(entry, `Pinned release manifest is missing ${path}`);
      return [path, entry];
    }),
);
const output = {
  schema: 1,
  capturedAt: new Date().toISOString(),
  revision: {
    commit: git("rev-parse", "HEAD"),
    status: git("status", "--porcelain"),
  },
  runtime: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model ?? null,
  },
  versions: {
    ferriki: readJson(join(nodeRoot, "ferriki/package.json")).version,
    shiki: readJson(join(nodeRoot, "compat/upstream/shiki/packages/shiki/package.json")).version,
    prismjs: prismPackage.version,
    typescript: require("typescript").version,
  },
  sources: {
    shiki: shikiSource,
    vscodeTextmate: textmateSource,
    prism: {
      package: "PrismJS/prism",
      version: prismPackage.version,
      componentManifestSha256: digestFile(componentsPath),
      loadedComponents: prismDependencies.map((name) => {
        const path = join(nodeRoot, `node_modules/prismjs/components/prism-${name}.js`);
        return {
          name,
          file: `components/prism-${name}.js`,
          sha256: digestFile(path),
        };
      }),
    },
    tmGrammars: {
      package: tmGrammarsPackage.name,
      version: tmGrammarsPackage.version,
      repository: tmGrammarsPackage.repository.url,
      homepage: tmGrammarsPackage.homepage,
      packageJsonSha256: digestFile(tmGrammarsPath),
    },
    ferrikiAssetsSha256: digestFile(assetManifestPath),
    grammarAssets,
    pnpmLockSha256: digestFile(join(nodeRoot, "pnpm-lock.yaml")),
    harnessSha256: digestFile(scriptPath),
    fixtureManifestSha256: digestFile(manifestPath),
  },
  theme: manifest.theme,
  method: {
    prism: "Prism.highlight returns fragment HTML using the loaded component grammar; no browser CSS is applied.",
    textmate: "Ferriki and Shiki return codeToHtml HTML using the same pinned grammar assets and github-dark theme.",
    classMode: "Ferriki codeToHtmlWithCss returns HTML plus the CSS needed to resolve the same TextMate theme through generated classes.",
    correctness: "HTML text content is parsed and compared with each exact source. TypeScript and TSX fixtures also pass the pinned TypeScript parser with zero syntax diagnostics.",
  },
  cases,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);
