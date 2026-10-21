import assert from "node:assert/strict";
import { createHighlighter, getLastGrammarState, ShikiError } from "../ferriki/index.mjs";
import "./test-asset-env.mjs";

const highlighter = await createHighlighter({
  langs: ["javascript", "typescript", "markdown"],
  themes: ["nord", "vitesse-light"],
});

try {
  const options = { lang: "javascript", theme: "nord" };
  const state = highlighter.getLastGrammarState('const value = "', options);
  const roundTripped = JSON.parse(JSON.stringify(state));
  assert.deepEqual(roundTripped, state);
  assert.equal(state.lang, "javascript");
  assert.equal(state.theme, "nord");
  assert.equal(state.version, 1);
  assert.equal(state.stateFormat, "textmate-stack-v1");
  assert.equal(typeof state.source, "string");
  assert.notEqual(state.source, 'const value = "');
  assert(!state.source.includes('const value = "'));
  assert(Buffer.byteLength(state.source) < 1024);

  const fragment = 'text"';
  const natural = highlighter.codeToHtml(fragment, options);
  const continued = highlighter.codeToHtml(fragment, { ...options, grammarState: roundTripped });
  assert.notEqual(continued, natural);
  assert.match(continued, /text/);
  assert.equal(
    continued,
    highlighter.codeToHtml(fragment, { ...options, grammarState: roundTripped }),
  );

  const legacyState = {
    version: 1,
    lang: roundTripped.lang,
    theme: roundTripped.theme,
    themes: roundTripped.themes,
    scopes: roundTripped.scopes,
    source: 'const value = "',
  };
  assert.match(highlighter.codeToHtml(fragment, { ...options, grammarState: legacyState }), /text/);
  assert.equal(
    continued,
    highlighter.codeToHtml(fragment, { ...options, grammarState: legacyState }),
  );
  const stateMarker = "\0ferriki-grammar-state-v1\0";
  const markerLikeLegacyState = {
    ...legacyState,
    source: `${stateMarker}${JSON.stringify({
      version: 1,
      grammarFingerprint: "legacy-source",
      rootScope: "source.js",
      frames: [],
    })}`,
  };
  assert.equal(
    highlighter.codeToHtml(fragment, {
      ...options,
      grammarState: markerLikeLegacyState,
    }),
    highlighter.codeToHtml(fragment, options),
  );
  let continuedSpanCalled = false;
  const transformedContinuation = highlighter.codeToHtml(fragment, {
    ...options,
    grammarState: roundTripped,
    decorations: [{ start: 0, end: 4, properties: { "data-continuation": "decorated" } }],
    transformers: [
      {
        span(node, _line, _column, _lineNode, token) {
          if (token.content.includes("text")) {
            continuedSpanCalled = true;
            this.addClassToHast(node, "continued-transform");
          }
        },
      },
    ],
  });
  assert(continuedSpanCalled);
  assert.match(transformedContinuation, /data-continuation="decorated"/);
  assert.match(transformedContinuation, /continued-transform/);

  assert.throws(
    () => highlighter.getLastGrammarState({ type: "root", children: [] }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  assert.throws(
    () => getLastGrammarState({ type: "root", children: [] }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  assert.throws(
    () => highlighter.getLastGrammarState("x", { lang: "text", theme: "nord" }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  assert.throws(
    () =>
      highlighter.codeToHtml("x", {
        lang: "typescript",
        theme: "nord",
        grammarState: state,
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  const invalidSnapshot = JSON.parse(state.source.slice(state.source.indexOf("{")));
  invalidSnapshot.grammarFingerprint = "wrong-grammar";
  assert.throws(
    () =>
      highlighter.codeToHtml("x", {
        ...options,
        grammarState: {
          ...state,
          source: `${state.source.slice(0, state.source.indexOf("{"))}${JSON.stringify(invalidSnapshot)}`,
        },
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  const invalidRuleIdSnapshot = JSON.parse(state.source.slice(state.source.indexOf("{")));
  invalidRuleIdSnapshot.frames[1].ruleId = 4294967295;
  assert.throws(
    () =>
      highlighter.codeToHtml("x", {
        ...options,
        grammarState: {
          ...state,
          source: `${state.source.slice(0, state.source.indexOf("{"))}${JSON.stringify(invalidRuleIdSnapshot)}`,
        },
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  const oversizedCompactState = {
    ...state,
    source: `${state.source.slice(0, state.source.indexOf("{"))}${" ".repeat(1_048_577)}`,
  };
  assert.throws(
    () => highlighter.codeToHtml("x", { ...options, grammarState: oversizedCompactState }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
  assert.throws(
    () =>
      highlighter.codeToHtml("x", {
        ...options,
        grammarState: { lang: "javascript", themes: ["nord"] },
      }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );

  const themes = { light: "vitesse-light", dark: "nord" };
  const multiThemeState = highlighter.getLastGrammarState("const value =", {
    lang: "javascript",
    themes,
    defaultColor: false,
  });
  assert.deepEqual(multiThemeState.themes, ["vitesse-light", "nord"]);
  const multiThemeHtml = highlighter.codeToHtml(" 1", {
    lang: "javascript",
    themes,
    defaultColor: false,
    grammarState: multiThemeState,
  });
  assert.match(multiThemeHtml, /--shiki-light:/);
  assert.match(multiThemeHtml, /--shiki-dark:/);

  const markdownOptions = { lang: "markdown", theme: "nord" };
  const embeddedState = JSON.parse(
    JSON.stringify(highlighter.getLastGrammarState('```js\nconst value = "', markdownOptions)),
  );
  const freshHighlighter = await createHighlighter({
    langs: ["javascript", "typescript", "markdown"],
    themes: ["nord", "vitesse-light"],
  });
  try {
    const continuationScopes = [];
    const embeddedHtml = freshHighlighter.codeToHtml('continued";\n```\n', {
      ...markdownOptions,
      grammarState: embeddedState,
      includeExplanation: "scopeName",
      transformers: [
        {
          span(_node, _line, _column, _lineNode, token) {
            if (token.content.includes("continued")) continuationScopes.push(token.scopeNames);
          },
        },
      ],
    });
    const legacyEmbeddedState = {
      ...embeddedState,
      stateFormat: undefined,
      source: '```js\nconst value = "',
    };
    assert.equal(
      embeddedHtml,
      freshHighlighter.codeToHtml('continued";\n```\n', {
        ...markdownOptions,
        grammarState: legacyEmbeddedState,
        includeExplanation: "scopeName",
      }),
    );
    assert.match(embeddedHtml, /continued/);
    assert(
      continuationScopes.some((scopes) => scopes?.some((scope) => scope.startsWith("string."))),
    );
  } finally {
    freshHighlighter.dispose();
  }

  let scopedToken;
  const scopedHtml = highlighter.codeToHtml("const value = 1", {
    ...options,
    includeExplanation: "scopeName",
    transformers: [
      {
        tokens(lines) {
          scopedToken = lines.flat().find((token) => token.content.startsWith("const"));
          return lines;
        },
      },
    ],
  });
  assert.match(scopedHtml, /const/);
  assert(scopedToken.scopeNames.includes("source.js"));

  let typedToken;
  highlighter.codeToHtml("const value = 1", {
    ...options,
    includeExplanation: "tokenType",
    transformers: [
      {
        span(_node, _line, _column, _lineNode, token) {
          typedToken ||= token;
        },
      },
    ],
  });
  assert.equal(typeof typedToken.type, "number");

  let offsetTokens;
  const offsetHtml = highlighter.codeToHtml("😀 const a = 1\r\nconst b = 2", {
    ...options,
    mergeWhitespaces: false,
    mergeSameStyleTokens: false,
    transformers: [
      {
        tokens(lines) {
          offsetTokens = lines.flat();
          return lines;
        },
      },
    ],
  });
  assert.match(offsetHtml, /😀/);
  const constTokens = offsetTokens.filter((token) => token.content === "const");
  assert.equal(constTokens[0].offset, 3);
  assert.equal(constTokens[1].offset, 16);
  for (const token of offsetTokens)
    assert.equal(
      "😀 const a = 1\r\nconst b = 2".slice(token.offset, token.offset + token.content.length),
      token.content,
    );
} finally {
  highlighter.dispose();
}

console.log("Ferriki HTML grammar-state continuation and callback token metadata verified");
