export const coreCompatSupportedTests = [
  "compat/upstream/shiki/packages/core/test/core-sync.test.ts",
  "compat/upstream/shiki/packages/core/test/core.test.ts",
  "compat/upstream/shiki/packages/core/test/get-singleton.test.ts",
  "compat/upstream/shiki/packages/shiki/test/alias.test.ts",
  "compat/upstream/shiki/packages/shiki/test/astro.test.ts",
  "compat/upstream/shiki/packages/shiki/test/bundle.test.ts",
  "compat/upstream/shiki/packages/shiki/test/get-highlighter.test.ts",
  "compat/upstream/shiki/packages/shiki/test/general.test.ts",
  "compat/upstream/shiki/packages/shiki/test/injections.test.ts",
];

export const coreCompatDeferredTests = [
  {
    path: "compat/upstream/shiki/packages/core/test/css-variables.test.ts",
    reason:
      "Shiki engine CSS-variable patching is outside the accepted native boundary; Ferriki registration and multi-theme contracts are covered by dedicated checks",
    issue: 48,
  },
  {
    path: "compat/upstream/shiki/packages/core/test/transformers.test.ts",
    reason:
      "upstream engine transformer fixtures are outside the native boundary; the JS facade contract is covered by check-ferriki-transformers",
    issue: 45,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/ansi.test.ts",
    reason:
      "ANSI escape parsing is an explicit non-goal; Ferriki rejects terminal escape sequences before native execution",
    issue: 48,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/color-replacement.test.ts",
    reason:
      "colorReplacements is an accepted non-goal; Ferriki rejects the option with ERR_UNSUPPORTED",
    issue: 190,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/shorthands.test.ts",
    testName: "should allow subsequent valid calls after first invalid language",
    reason:
      "the fixture expects Shiki's invalid-language wording; Ferriki's recovery behavior is covered by its native error contract",
    issue: 50,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/css-variables.test.ts",
    reason:
      "the upstream helper fixture is outside the accepted native boundary; Ferriki CSS variables are covered by the multi-theme and registration contracts",
    issue: 48,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/decorations.test.ts",
    reason: "upstream bundle decorations are exercised through the Ferriki JS facade contract",
    issue: 45,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/dist.test.ts",
    reason:
      "upstream distribution-file assertions do not describe the Ferriki package boundary; packed Ferriki artifacts have a separate consumer gate",
    issue: 42,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/shorthands-markdown.test.ts",
    reason:
      "Markdown shorthand expansion belongs to an optional adapter, not the Ferriki core product boundary",
    issue: 42,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/theme-none.test.ts",
    reason:
      "Ferriki theme-none and dual-theme behavior is covered by the dedicated multi-theme contract rather than the upstream adapter fixture",
    issue: 43,
  },
];

export const coreCompatSupportedHtmlTests = [
  {
    path: "compat/upstream/shiki/packages/shiki/test/hast.test.ts",
    testNamePattern:
      "^(hasfocus support|render whitespace|merge same style (merges adjacent tokens with same style|merges adjacent tokens with dual themes|merges adjacent tokens with the same dual themes|does not merge tokens with decorations))$",
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/shorthands.test.ts",
    testNamePattern: "^should codeToHtml$",
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/themes.test.ts",
    testNamePattern:
      "^(codeToHtml (dual themes|multiple themes|multiple themes without default|should support font style|should not have empty style)|errors (throws on empty theme|throws on missing default color|not throws when .* set to false))$",
  },
];

export const coreCompatExcludedTests = [
  {
    path: "compat/upstream/shiki/packages/core/test/tokens.test.ts",
    reason:
      "the file tests the standalone Node token result contract removed in #207; Rust token APIs remain supported",
    issue: 207,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/grammar-state.test.ts",
    reason:
      "the suite's state assertions depend on removed standalone token/HAST results or HAST-to-state overloads; code-input state and HTML continuation are covered by native checks",
    issue: 207,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/hast.test.ts",
    testNames: ["should works", "should structure inline", "merge same style supports data"],
    reason:
      "these fixtures require the removed standalone HAST result API; the same file's HTML, whitespace, merging, and decoration cases run separately",
    issue: 207,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/shorthands.test.ts",
    testNames: ["should codeToTokensBase"],
    reason:
      "this fixture requires the removed codeToTokensBase shorthand; the same file's HTML shorthand and recovery cases run separately",
    issue: 207,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/themes.test.ts",
    testNames: [
      "alignThemesTokenization two themes",
      "alignThemesTokenization three themes",
      "codeToTokensWithThemes generates",
    ],
    reason:
      "these fixtures assert standalone token output; the same file's multi-theme HTML and usage-error cases run separately",
    issue: 207,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/general.test.ts",
    testNames: ["should have correct offset"],
    reason:
      "the upstream offset fixture reads token results; UTF-16 offsets remain covered through HTML transformer callbacks",
    issue: 207,
  },
];
