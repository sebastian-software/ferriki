# Native-Only Migration Plan

Execution plan for [ADR 0009](../adr/0009-native-only-runtime.md): remove
the bundled JS engine and make the Rust core the only runtime, with a thin
JS facade on top. Based on a full audit of the backend wiring in
`node/ferriki/dist/index.mjs` (the parity adapter) and the `#[napi]`
surface of `crates/ferriki-core` (line references are against the state at
the time of the audit; the bundle is `dist/index.mjs`).

## Finding 0 — the compat lane barely tests the native path

Before any migration work: the vitest alias in `node/vitest.config.ts`
only redirects the exact specifier `shiki` to the ferriki package. Of the
18 files in the mirrored `shiki/test`, only five import bare `'shiki'`
(`alias`, `astro`, `get-highlighter`, `hast`, `injections` — the last of
which then calls the JS-only `createHighlighterCore`); the rest import
`'../src'` (9 files), `'shiki/bundle/full'` (2), or `'shiki/core'` (1) —
i.e. they test upstream JS against upstream JS, regardless of
`FERRIKI_BACKEND`. The whole of `core/test` does the same. The alias fix
therefore needs to cover the subpath specifiers and decide how to handle
the `'../src'` imports, not just the bare specifier.
"The core lane passes" therefore does not mean "the Rust backend passes".

**First step of the migration: extend the aliasing so the compat lane
actually exercises ferriki.** This will convert several gaps below from
"unknown" to "visible failing test", which is exactly what we want.

## Current coupling (why the JS engine is not just a fallback)

- `createHighlighterWithBackend` always constructs the full JS bundled
  highlighter, even with `backend=rust`, and wraps it in a Proxy-based
  parity adapter. Both engines' assets are resident in memory (9.6 MB JS
  chunks + 8.2 MB native catalogs).
- The adapter intercepts only eight member names; everything else falls
  through to JS (`codeToTokensBase`, `codeToTokensWithThemes`,
  `getLastGrammarState`, `setTheme`, all getters, `guessEmbeddedLanguages`).
- User-supplied grammars reach the native core only by reading the private
  `_grammar` field of the JS registry; themes are normalized by the JS
  layer before being handed down.
- The native side parses only: `lang`, `theme`, `themes.light/dark`,
  `colorReplacements`, `mergeWhitespaces`, `mergeSameStyleTokens`,
  `structure`, `tabindex`, `rootStyle`, `meta`, `data`, `_rustState`,
  `grammarContextCode`, `standardAssetRoot`. Everything else is dropped.

Routing today (backend=rust): single-theme `codeToHtml`/`codeToTokens`/
`codeToHast` without transformers run fully native; themes-map mode
tokenizes natively N times (2N for `codeToTokens`) and renders in JS;
`theme: 'none'`, transformers/decorations, and everything not intercepted
run entirely in JS; `lang: 'ansi'` hard-fails natively with no fallback.

## Bugs found that exist today, independent of the migration

- `grammarState` without `_rustState` (e.g. produced by the always-JS
  `codeToTokensBase`) is silently deleted before native calls — wrong
  output instead of the upstream `ShikiError`.
- JS-side validation errors thrown inside the adapter's try-block are
  rewrapped as `[ferriki] Native <method> failed: ...`, losing the
  `ShikiError` class and confusing the message origin.
- Alias tables: `ensure_standard_grammar_loaded_inner` and
  `register_grammar` each clear the other's alias entries; user aliases
  survive only by call-order accident.
- `native.dispose()` is a no-op; per-highlighter compiled-grammar and
  catalog caches are unbounded and never evicted.
- `create_highlighter` swallows catalog-load failures (`.ok()`), so a bad
  `standardAssetRoot` surfaces later as a misleading language-support
  error.
- ~150 lines of finished dual-theme Rust (`parse_dual_themes`, the
  `--shiki-dark` HTML profile, dark-palette merges in `render.rs`) are
  unreachable: the adapter strips `themes` before every native call.
  Revive as the base for native themes-map support — or delete; not both.

## Gap catalog

Effort: S ≈ ≤~150 LOC mostly mechanical; M ≈ new subsystem with compat
surface; L ≈ architectural decision required.

| # | Gap | Effort |
|---|---|---|
| G1 | `theme: 'none'` native (Rust support exists; remove adapter bypasses) | S |
| G2 | `getLoadedThemes/Languages` + alias accessors (grammar twin exists) | S |
| G3 | `langAlias` option (currently dropped) | S |
| G4 | `tokenizeMaxLineLength` / `tokenizeTimeLimit` | S |
| G5 | Error parity (stop rewrapping; validate outside the try; keep `ShikiError`) | S |
| G6 | Bundled catalog enumeration accessors (manifests already loaded) | S |
| G7 | Actionable diagnostics for missing/broken asset catalogs | S |
| G8 | Native raw-theme registration (normalizer exists in ferriki-asset-gen; lift into core; `include` chains, per-rule `background`, `colors` map) | M |
| G9 | `codeToTokensBase` native (re-projection of styled-tokens JSON + `bgColor` + state validation) | M |
| G10 | Native themes-map pipeline: arbitrary N themes, `defaultColor` incl. `false`/`light-dark()`, `cssVariablePrefix`, token alignment (removes the 2N re-tokenization; build on the dead dual-theme Rust) | M |
| G11 | `ansi` language support (depends on G8 for `terminal.ansi*` colors) | M |
| G12 | Native `GrammarState` object + validation + tokens association | M |
| G13 | `getLastGrammarState` native (cheap once G12 exists) | M |
| G14 | Transformer/decoration path: native `codeToHast` → JS hast pass → JS `hastToHtml` (per ADR 0008), incl. working transformer-context callbacks | M |
| G15 | `registerGrammar` from plain `LanguageRegistration` (no JS-registry `_grammar` peeking) | M |
| G16 | `guessEmbeddedLanguages` (JS heuristic, runs on every shorthand) | M |
| G17 | Decide sync-vs-async native execution (`RefCell` → `!Send`; blocks the event loop today) before writing the new facade | M |
| G18 | `createHighlighterCore`/`createShikiInternal`/`ferriki/core`: route natively, keep as JS shim, or drop engine injection — the single biggest API decision | L |
| G19 | `includeExplanation` / token `explanation` / `bgColor` provenance through the tokenizer | L |
| G20 | Engine exports (`createOnigurumaEngine`, `createJavaScriptRegexEngine`, `loadWasm`): removal is a public API break; the mirrored suite imports them | L |

## Suggested sequence

1. **Fix the compat-lane aliasing** (Finding 0) — makes the true native
   pass rate visible; expect new failures, which become the work list.
2. Fix the standalone bugs above (silent `grammarState` drop, error
   rewrapping, alias clobbering, catalog diagnostics).
3. Land the S-gaps (G1–G7).
4. Decide G17 (sync/async) and G18/G20 (core factories, engine exports) —
   these shape the new facade's API.
5. M-gaps, roughly G10 (revive dual-theme Rust) → G8/G15 (registration
   without JS registry) → G9/G12/G13 (tokens/state) → G14 (hast path) →
   G11/G16.
6. Write the thin TS facade fresh (reframed #10), validated against the
   now-honest compat lane.
7. Cut-over: remove `dist/chunks`, the vendored bundle, and
   `FERRIKI_BACKEND=js` (#11); add the CI guard against reintroduction;
   real `dispose`/cache eviction; then per-platform sidecar packages.

Size effect of the cut-over: the tarball loses roughly half its unpacked
size (9.6 MB JS chunks + the vendored engine), and `backend=rust` stops
holding both engines' assets in memory.
