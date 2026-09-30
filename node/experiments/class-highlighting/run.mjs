/* eslint-disable antfu/no-top-level-await -- This executable experiment initializes reference engines before collecting evidence. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { createHighlighterCore } from "@shikijs/core";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import { createHighlighter } from "../../ferriki/index.mjs";
import { loadCorpus, syntheticGrammar, syntheticTheme, tasks } from "./corpus.mjs";
import {
  classifyCollisions,
  declaration,
  exactSelector,
  flatClasses,
  identity,
  models,
  pathId,
  renderTokens,
} from "./models.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = `${root}/node/.generated/class-highlighting`;
mkdirSync(output, { recursive: true });
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const upstream = `${root}/assets/upstream/textmate-grammars-themes`;
const grammars = readdirSync(`${upstream}/grammars`)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => json(`${upstream}/grammars/${file}`));
grammars.push(syntheticGrammar);
const byName = new Map(grammars.map((grammar) => [grammar.name, grammar]));
const byScope = new Map(grammars.map((grammar) => [grammar.scopeName, grammar]));
const themes = readdirSync(`${upstream}/themes`)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => json(`${upstream}/themes/${file}`));
themes.push(syntheticTheme);
const cases = loadCorpus(root).map((item) => ({ ...item, scope: byName.get(item.lang).scopeName }));

const requirePrimitive = createRequire(
  new URL("../../compat/upstream/shiki/packages/primitive/package.json", import.meta.url),
);
const { Registry, INITIAL } = await import(requirePrimitive.resolve("@shikijs/vscode-textmate"));
const engine = await createOnigurumaEngine(() => import("@shikijs/engine-oniguruma/wasm-inlined"));
const registry = new Registry({
  onigLib: { createOnigScanner: engine.createScanner, createOnigString: engine.createString },
  loadGrammar: (scope) => byScope.get(scope),
  getInjections: (scope) =>
    grammars
      .filter((grammar) => grammar.injectTo?.includes(scope))
      .map((grammar) => grammar.scopeName),
});
const rawResults = [];
for (const item of cases) {
  const grammar = await registry.loadGrammar(item.scope);
  let state = INITIAL;
  const lines = item.code.split("\n").map((line) => {
    const result = grammar.tokenizeLine(line, state);
    assert(!result.stoppedEarly, `Upstream tokenization stopped: ${item.id}`);
    state = result.ruleStack;
    return result.tokens
      .map((token) => ({
        start: token.startIndex,
        end: Math.min(token.endIndex, line.length),
        scopes: token.scopes,
      }))
      .filter((token) => token.start < token.end);
  });
  rawResults.push({ id: item.id, lines });
}
const rawNative = JSON.parse(
  execFileSync("cargo", ["run", "--offline", "--quiet", "--example", "class_highlighting_probe"], {
    cwd: root,
    input: JSON.stringify({ grammars, cases }),
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
    encoding: "utf8",
  }),
);
assert.deepEqual(
  rawNative,
  rawResults,
  "Native raw scope paths must match the upstream oracle before evaluating CSS models",
);
registry.dispose();

const paths = new Map();
for (const [index, item] of cases.entries()) {
  let offset = 0;
  item.tokens = [];
  const lines = item.code.split("\n");
  for (const [lineIndex, line] of lines.entries()) {
    for (const token of rawNative[index].lines[lineIndex]) {
      const id = pathId(token.scopes);
      if (paths.has(id))
        assert.deepEqual(paths.get(id).scopes, token.scopes, "Truncated path hash collision");
      else paths.set(id, { id, scopes: token.scopes });
      item.tokens.push({
        ...token,
        start: offset + token.start,
        end: offset + token.end,
        id,
        index: item.tokens.length,
        content: line.slice(token.start, token.end),
      });
    }
    if (lineIndex < lines.length - 1)
      item.tokens.at(-1)
        ? (item.tokens.at(-1).content += "\n")
        : item.tokens.push({
            scopes: [item.scope],
            id: pathId([item.scope]),
            index: item.tokens.length,
            start: offset,
            end: offset,
            content: "\n",
          });
    offset += line.length + 1;
  }
  // Blank lines get their own default-scope token and must not disappear.
  for (const token of item.tokens) {
    if (!paths.has(token.id)) paths.set(token.id, { id: token.id, scopes: token.scopes });
  }
  assert.equal(item.tokens.map((token) => token.content).join(""), item.code);
}

const langNames = [...new Set(cases.map((item) => item.lang))];
const shiki = await createHighlighterCore({ langs: grammars, themes, engine });
const native = await createHighlighter({
  langs: [...langNames.filter((lang) => lang !== "class-probe"), syntheticGrammar],
  themes,
});
const styles = {};
const defaults = {};
const nativeDifferences = [];
let nativeDifferenceCount = 0;
let comparedCharacters = 0;

function characterStyles(tokens) {
  const values = [];
  for (const token of tokens) {
    const style = { color: token.color.toLowerCase(), fontStyle: token.fontStyle || 0 };
    for (let offset = 0; offset < token.content.length; offset++) values.push(style);
  }
  return values;
}

try {
  for (const theme of themes) {
    styles[theme.name] = {};
    const normalized = shiki.getTheme(theme.name);
    defaults[theme.name] = { color: normalized.fg, background: normalized.bg };
    for (const item of cases) {
      const options = {
        lang: item.lang,
        theme: theme.name,
        mergeWhitespaces: false,
        mergeSameStyleTokens: false,
      };
      const reference = shiki.codeToTokens(item.code, options);
      const actual = native.codeToTokens(item.code, options);
      let globalOffset = 0;
      const allReference = new Map();
      for (const [index, line] of item.code.split("\n").entries()) {
        const expected = characterStyles(reference.tokens[index]);
        const received = characterStyles(actual.tokens[index]);
        assert.equal(expected.length, line.length, `Reference source preservation: ${item.id}`);
        assert.equal(received.length, line.length, `Native source preservation: ${item.id}`);
        for (let position = 0; position < line.length; position++) {
          allReference.set(globalOffset + position, expected[position]);
          comparedCharacters++;
          if (JSON.stringify(expected[position]) !== JSON.stringify(received[position])) {
            nativeDifferenceCount++;
            if (nativeDifferences.length < 20)
              nativeDifferences.push({
                theme: theme.name,
                case: item.id,
                position: globalOffset + position,
                expected: expected[position],
                actual: received[position],
              });
          }
        }
        globalOffset += line.length + 1;
      }
      for (const token of item.tokens) {
        const style = allReference.get(token.start) || {
          color: normalized.fg.toLowerCase(),
          fontStyle: 0,
        };
        for (let position = token.start; position < token.end; position++)
          assert.deepEqual(
            allReference.get(position),
            style,
            "A raw scope token must have a uniform reference style",
          );
        const previous = styles[theme.name][token.id];
        if (previous)
          assert.deepEqual(
            previous,
            style,
            "An identical scope path must have an identical theme style",
          );
        styles[theme.name][token.id] = style;
      }
    }
  }
} finally {
  shiki.dispose();
  native.dispose();
}

const pathList = [...paths.values()];
const modelResults = models.map((model) => {
  const collision = classifyCollisions(pathList, styles, model);
  const html = cases.map((item) => renderTokens(item.tokens, model)).join("\n");
  const scopeGroups = new Map();
  for (const path of pathList) {
    const key = identity(path.scopes, model);
    if (!scopeGroups.has(key)) scopeGroups.set(key, []);
    scopeGroups.get(key).push(path.id);
  }
  const cssSizes = Object.values(styles).map((table) => {
    const rules = new Map();
    for (const path of pathList) {
      const selector =
        model === "flat"
          ? `.token[class="${flatClasses(path.scopes).join(" ")}"]`
          : exactSelector(path.scopes, model);
      if (!rules.has(selector))
        rules.set(selector, `.model-${model} :where(${selector}){${declaration(table[path.id])}}`);
    }
    const css = [...rules.values()].join("\n");
    return { bytes: Buffer.byteLength(css), gzipBytes: gzipSync(css).length };
  });
  return {
    model,
    htmlBytes: Buffer.byteLength(html),
    gzipHtmlBytes: gzipSync(html).length,
    spans: (html.match(/<span /g) || []).length,
    scopeGroups: collision.groups,
    lostPathGroups: [...scopeGroups.values()].filter((ids) => ids.length > 1),
    themeConflicts: collision.conflicts,
    perThemeCssBytes: {
      min: Math.min(...cssSizes.map((size) => size.bytes)),
      max: Math.max(...cssSizes.map((size) => size.bytes)),
    },
    perThemeGzipCssBytes: {
      min: Math.min(...cssSizes.map((size) => size.gzipBytes)),
      max: Math.max(...cssSizes.map((size) => size.gzipBytes)),
    },
  };
});
const payload = { cases, paths: pathList, styles, defaults, tasks, modelResults };
for (const item of payload.cases)
  item.html = Object.fromEntries(models.map((model) => [model, renderTokens(item.tokens, model)]));
for (const path of payload.paths) {
  path.flatClasses = flatClasses(path.scopes);
  path.selectors = Object.fromEntries(
    models.map((model) => [
      model,
      model === "flat"
        ? `.token[class="${flatClasses(path.scopes).join(" ")}"]`
        : exactSelector(path.scopes, model),
    ]),
  );
}
writeFileSync(`${output}/data.json`, `${JSON.stringify(payload)}\n`);
const inventory = themes.map((theme) => {
  const selectors = (theme.tokenColors || theme.settings).flatMap((rule) =>
    (Array.isArray(rule.scope) ? rule.scope : [rule.scope])
      .filter((scope) => typeof scope === "string")
      .flatMap((scope) =>
        scope
          .split(",")
          .map((selector) => selector.trim())
          .filter(Boolean),
      ),
  );
  return {
    theme: theme.name,
    selectors: selectors.length,
    contextual: selectors.filter((selector) => /\s/.test(selector)).length,
  };
});
const summary = {
  corpus: {
    cases: cases.length,
    languages: langNames.length,
    themes: themes.length,
    paths: paths.size,
    tokens: cases.reduce((total, item) => total + item.tokens.length, 0),
    comparedCharacters,
    developmentCases: cases.filter((item) => item.split === "development").length,
    holdoutCases: cases.filter((item) => item.split === "holdout").length,
  },
  rawScopeParity: "passed",
  nativeStyleDifferenceCount: nativeDifferenceCount,
  nativeStyleDifferences: nativeDifferences,
  models: modelResults,
  inventory,
  versions: {
    shiki: json(`${root}/node/compat/upstream/shiki/.source.json`).ref,
    nativeTextmate: json(`${root}/node/compat/upstream/vscode-textmate/.source.json`).ref,
    jsTextmate: json(
      fileURLToPath(
        new URL(
          "../package.json",
          pathToFileURL(requirePrimitive.resolve("@shikijs/vscode-textmate")),
        ),
      ),
    ).version,
  },
};
writeFileSync(`${output}/analysis.json`, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify(
    {
      ...summary,
      inventory: undefined,
      models: modelResults.map(({ themeConflicts, lostPathGroups, ...model }) => ({
        ...model,
        themeConflicts: themeConflicts.length,
        lostPathGroups: lostPathGroups.length,
      })),
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`Browser corpus written to ${output}\n`);
