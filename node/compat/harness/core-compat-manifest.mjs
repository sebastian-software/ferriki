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
    path: "compat/upstream/shiki/packages/core/test/tokens.test.ts",
    reason:
      "remaining upstream token snapshots and native projection edge cases are tracked in the Ferriki token contract",
    issue: 47,
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
      "the upstream bundle fixture exercises Shiki-only theme plumbing; Ferriki colorReplacements are validated by the native option contract",
    issue: 48,
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
    path: "compat/upstream/shiki/packages/shiki/test/grammar-state.test.ts",
    reason:
      "remaining upstream grammar-state snapshots and native stack parity are tracked in the Ferriki grammar-state contract",
    issue: 47,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/hast.test.ts",
    reason:
      "the upstream HAST fixture combines adapter-owned metadata with engine behavior; Ferriki HAST, decoration, and multi-theme contracts are covered by dedicated checks",
    issue: 45,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/shorthands-markdown.test.ts",
    reason:
      "Markdown shorthand expansion belongs to an optional adapter, not the Ferriki core product boundary",
    issue: 42,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/shorthands.test.ts",
    reason:
      "the upstream shorthand fixture asserts Shiki-specific adapter wording; Ferriki usage errors and native recovery are covered by the error contract",
    issue: 50,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/theme-none.test.ts",
    reason:
      "Ferriki theme-none and dual-theme behavior is covered by the dedicated multi-theme contract rather than the upstream adapter fixture",
    issue: 43,
  },
  {
    path: "compat/upstream/shiki/packages/shiki/test/themes.test.ts",
    reason:
      "Ferriki multi-theme and defaultColor behavior is covered by the dedicated native contract with deterministic output assertions",
    issue: 43,
  },
];
