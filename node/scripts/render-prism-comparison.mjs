import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import Prism from "prismjs";
import loadLanguages from "prismjs/components/index.js";
import * as shiki from "shiki";
import { createHighlighter } from "../ferriki/index.mjs";
import "./test-asset-env.mjs";

const inputUrl = new URL("../../homepage/scripts/prism-inputs.json", import.meta.url);
const outputUrl = new URL("../../homepage/app/data/prism-comparison.json", import.meta.url);
const inputs = JSON.parse(readFileSync(inputUrl, "utf8"));
const theme = "github-dark-high-contrast";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (url) => JSON.parse(readFileSync(url, "utf8"));
const componentsUrl = new URL("../node_modules/prismjs/components.json", import.meta.url);
const components = json(componentsUrl);
loadLanguages(["typescript", "tsx", "cpp", "css", "go", "rust", "markup", "javascript"]);
const langs = [...new Set(inputs.flatMap((entry) => [entry.lang, ...entry.embedded]))];
const highlighter = await createHighlighter({ langs, themes: [theme], assets: { remote: false } });
const reference = await shiki.createHighlighter({
  langs,
  themes: [theme],
  engine: shiki.createOnigurumaEngine(import("shiki/wasm")),
  assets: { remote: false },
});
const require = createRequire(new URL("../ferriki/native.mjs", import.meta.url));
const loadedAddon = Object.keys(require.cache).find((file) => file.endsWith(".node"));
assert.ok(loadedAddon, "The comparison must render with the native addon");
const build = json(new URL("../ferriki/.benchmark-build.json", import.meta.url));
assert.equal(sha256(readFileSync(loadedAddon)), build.binarySha256, "Native build receipt drift");

function prismLeaves(stream) {
  const leaves = [];
  let offset = 0;
  function visit(value, names = []) {
    if (typeof value === "string") {
      leaves.push({ content: value, offset, names });
      offset += value.length;
    } else if (Array.isArray(value)) {
      value.forEach((child) => visit(child, names));
    } else {
      visit(value.content, [...names, value.type, ...[value.alias ?? []].flat()]);
    }
  }
  visit(stream);
  return leaves;
}

function focusRows(input, ferrikiTokens, prismTokens) {
  return input.focus.map((target) => {
    let offset = -1;
    for (let count = 0; count < target.occurrence; count++) {
      offset = input.source.indexOf(target.text, offset + 1);
      assert.ok(offset >= 0, `${input.id}: missing focus ${target.text}`);
    }
    const covers = (token) =>
      token.offset <= offset && offset < token.offset + token.content.length;
    const ferriki = ferrikiTokens.find(covers);
    const prism = prismTokens.find(covers);
    assert.ok(ferriki && prism, `${input.id}: missing captured token`);
    return {
      label: target.label,
      text: target.text,
      offset,
      ferriki: ferriki.scopes,
      prism: prism.names,
    };
  });
}

const samples = [];
try {
  for (const input of inputs) {
    if (["typescript", "tsx"].includes(input.lang)) {
      const ts = require("typescript");
      const source = ts.createSourceFile(
        input.lang === "tsx" ? "example.tsx" : "example.ts",
        input.source,
        ts.ScriptTarget.Latest,
        true,
        input.lang === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      assert.equal(source.parseDiagnostics.length, 0, `${input.id}: invalid TypeScript syntax`);
    }
    const ferrikiHtml = highlighter.codeToHtml(input.source, { lang: input.lang, theme });
    assert.equal(toString(fromHtml(ferrikiHtml, { fragment: true })), input.source);
    assert.equal(ferrikiHtml, reference.codeToHtml(input.source, { lang: input.lang, theme }));
    const tokens = [];
    highlighter.codeToHtmlWithCss(input.source, {
      lang: input.lang,
      theme,
      styleMode: "classes",
      transformers: [
        {
          tokens(lines) {
            for (const line of lines)
              for (const token of line) {
                tokens.push({
                  content: token.content,
                  offset: token.offset,
                  scopes: [...(token.scopeNames ?? [])],
                });
              }
            return lines;
          },
        },
      ],
    });
    let prismHtml = null;
    let classifications = [];
    if (input.prism) {
      const grammar = Prism.languages[input.prism];
      assert.ok(grammar, `${input.id}: no Prism grammar loaded`);
      prismHtml = Prism.highlight(input.source, grammar, input.prism);
      assert.equal(toString(fromHtml(prismHtml, { fragment: true })), input.source);
      classifications = focusRows(
        input,
        tokens,
        prismLeaves(Prism.tokenize(input.source, grammar)),
      );
    } else {
      assert.equal(
        components.languages[input.lang],
        undefined,
        `${input.lang}: Prism support changed`,
      );
    }
    samples.push({
      id: input.id,
      label: input.label,
      lang: input.lang,
      source: input.source,
      sourceSha256: sha256(input.source),
      ferrikiHtml,
      prismHtml,
      classifications,
    });
  }
} finally {
  highlighter.dispose();
  reference.dispose();
}
const evidence = {
  schema: 1,
  theme,
  fixtureSha256: sha256(readFileSync(inputUrl)),
  versions: {
    ferriki: json(new URL("../ferriki/package.json", import.meta.url)).version,
    prism: json(new URL("../node_modules/prismjs/package.json", import.meta.url)).version,
  },
  provenance: {
    addonSha256: build.binarySha256,
    rustSourceSha256: build.rustSourceSha256,
    assetsSha256: sha256(
      readFileSync(new URL("../ferriki/assets/shiki/release-manifest.json", import.meta.url)),
    ),
    prismComponentsSha256: sha256(readFileSync(componentsUrl)),
  },
  samples,
};
if (process.argv.includes("--check")) {
  const committed = json(outputUrl);
  assert.equal(committed.theme, theme);
  assert.equal(committed.fixtureSha256, evidence.fixtureSha256);
  assert.deepEqual(committed.samples, samples, "Comparison output changed; run prism-sample:write");
  console.log(
    "Verified native/Prism samples, source preservation, TextMate scopes, and Shiki HTML parity.",
  );
} else {
  writeFileSync(outputUrl, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log("Wrote the comparison from actual unmodified highlighter outputs.");
}
