export const coreCompatSupportedTests = [
  'compat/upstream/shiki/packages/core/test/core-sync.test.ts',
  'compat/upstream/shiki/packages/core/test/core.test.ts',
  'compat/upstream/shiki/packages/core/test/get-singleton.test.ts',
  'compat/upstream/shiki/packages/shiki/test/alias.test.ts',
  'compat/upstream/shiki/packages/shiki/test/astro.test.ts',
  'compat/upstream/shiki/packages/shiki/test/get-highlighter.test.ts',
  'compat/upstream/shiki/packages/shiki/test/general.test.ts',
  'compat/upstream/shiki/packages/shiki/test/injections.test.ts',
]

export const coreCompatDeferredTests = [
  {
    path: 'compat/upstream/shiki/packages/core/test/css-variables.test.ts',
    reason: 'custom theme registration and CSS variable patching are part of the public facade contract',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/core/test/tokens.test.ts',
    reason: 'explanations, grammar state, and multi-theme token projections are not implemented yet',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/core/test/transformers.test.ts',
    reason: 'transformer execution is intentionally deferred to the Node facade contract',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/shiki/test/ansi.test.ts',
    reason: 'ANSI parsing is not part of the current Ferriki facade',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/shiki/test/color-replacement.test.ts',
    reason: 'color replacement options are not implemented yet',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/shiki/test/css-variables.test.ts',
    reason: 'CSS variable theme helpers are not implemented yet',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/shiki/test/decorations.test.ts',
    reason: 'decoration and transformer execution is not implemented yet',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/shiki/test/dist.test.ts',
    reason: 'upstream distribution-file assertions do not describe the Ferriki package boundary',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/shiki/test/grammar-state.test.ts',
    reason: 'grammar-state continuation is not implemented yet',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/shiki/test/hast.test.ts',
    reason: 'HAST metadata, decorations, and multi-theme rendering are not implemented yet',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/shiki/test/shorthands-markdown.test.ts',
    reason: 'lazy embedded-language shorthand behavior is not implemented yet',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/shiki/test/shorthands.test.ts',
    reason: 'facade error wording and shorthand behavior are not stable yet',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/shiki/test/theme-none.test.ts',
    reason: 'none and dual-theme rendering are not implemented yet',
    issue: 31,
  },
  {
    path: 'compat/upstream/shiki/packages/shiki/test/themes.test.ts',
    reason: 'dual-theme, multi-theme, and defaultColor behavior are not implemented yet',
    issue: 31,
  },
]
