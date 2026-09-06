# Native-Only Migration Plan

> Historical audit and migration record. Evidence dates are retained below;
> current delivery status lives in the GitHub issues and the accepted 1.0 API
> contract. Do not use the teardown snapshot as a current package description.

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

## Decision gate — keep the tokenizer or re-port it

The honest pass rate produced by the aliasing fix (Finding 0) decides a
strategic question that stays open until then: whether `ferriki-core`'s
tokenizer is kept, or whether the core is re-ported from scratch.

Judge the failures by class, not by count. Gaps already cataloged below
(themes-map rendering, `ansi`, `codeToTokensBase`, transformer routing,
raw registration — the G-items) are expected failures and say nothing
about the tokenizer. What the gate measures is **tokenization
correctness**: do scopes, token boundaries, and theme resolution match
upstream on the cases the mirrored suite actually asserts?

Concrete gate criteria (measured on the tokenization-asserting cases of
the honestly-aliased core lane, after excluding tests that fail solely
due to cataloged G-gaps):

- **Keep** when the native pass rate is >= 90% and no failure class is
  structural — i.e. no systematic wrongness in begin/end nesting,
  while-rules, injections, or scope-stack handling; isolated failures are
  point-fixable.
- **Re-port** when the pass rate is below 90%, or any structural failure
  class shows up, regardless of the overall rate — those are
  architecture, not bugs.
- **In between**: one timeboxed point-fix iteration; if the rate does not
  converge above the threshold within it, re-port. Do not iterate twice.

Rationale for the two branches:

- **Keep `ferriki-core`** → the tokenizer is semantically sound; continue
  this plan as written. A re-port would discard working, now
  well-modularized code for no gain.
- **Re-port** → the incremental fork-era port carried
  over structural drift, and patching it case by case is the losing move.
  Then restart the core the way ferroni was built: a mechanical 1:1 port
  of **vscode-textmate** (the actual hard part — Shiki above it is thin
  orchestration) onto ferroni's vscode-oniguruma-compatible Scanner API,
  with vscode-textmate's own upstream test suite mirrored as the oracle,
  following the same pinned-mirror tooling this repo already has. The
  asset pipeline (`ferriki-asset-gen`, binary catalogs) and the Shiki
  compat mirror carry over unchanged; the current core stays available as
  a reference implementation until parity is reached.

Both paths end in the identical ADR 0009 target state — Rust core plus a
thin napi facade, no JS engine. The only variable is the provenance of
the tokenizer core, and that choice should be made from the measured pass
rate, not from sentiment about the fork era.

## Gate result (measured 2026-07-26)

The honest-alias mode exists (`FERRIKI_HONEST_ALIAS=1` in
`node/vitest.config.ts`, off by default) and the gate has been measured.
Raw result: 63/91 tests pass natively. Classification of the 28 failures
(each root-caused, with a `FERRIKI_BACKEND=js` control run to separate
facade artifacts from native defects): 14 cataloged G-gaps/facade bugs,
6 test-infrastructure artifacts of the aliasing itself, and **8
tokenization-structural failures**.

Gate metric: 63 of 71 tokenization-asserting cases = **88.7%**, below
the 90% threshold — and four distinct structural failure classes exist,
all on content the vendored JS engine renders correctly from identical
assets:

1. Theme resolution ignores ancestor scopes (rules matching
   `meta.function-call` or `string.quoted` via the scope stack resolve to
   the default color natively).
2. `fontStyle` inheritance is broken (NotSet semantics: a
   foreground-only specific rule drops the italic/bold a broader rule
   provides).
3. While-rule / capture scope-stack handling fails in markdown
   (mid-line `markup.quote` loss with token-boundary drift, heading `#`
   captures not split, begin-captures losing `entity.name.tag`).
4. Embedded-language delegation never enters `source.js` inside markdown
   fences or `source.css.scss` inside Vue `<style>` blocks, while
   html→js `<script>` embedding works — an inconsistency in the
   contentName/include machinery.

Classes 3 and 4 are squarely in the structural set the gate names;
classes 1 and 2 are systematic theme-resolver semantics. **Both re-port
conditions are met. Decision: re-port the core** as a mechanical 1:1
port of vscode-textmate onto ferroni's Scanner API, with the upstream
vscode-textmate suite mirrored as the oracle. The asset pipeline and the
Shiki compat mirror carry over; the current core remains as a reference
implementation until parity. The theme-resolver findings (classes 1–2)
double as a known-issues list for the interim native path.

## Teardown executed (2026-07-26)

Following the gate verdict, the transitional stack was removed in one
sweep rather than kept as scaffolding (there are no external consumers to
protect, and the upstream mirror — not the fork-era code — is the
behavioral reference):

- the vendored JS engine (`dist/` bundle + 297 chunks), the parity
  adapter, the Shiki subpath re-exports, and `FERRIKI_BACKEND` are gone;
  the npm package is an honest placeholder exposing `ferrikiVersion()`
- the fork-era tokenizer modules in `crates/ferriki-core` are gone;
  the crate retains the asset catalogs and the napi entry point
- the compat lanes are suspended in CI and return as #30 port milestones
  (run them with `FERRIKI_HONEST_ALIAS=1` from then on)
- last full pre-teardown state: commit `e9c01db` on main

This supersedes the sequence below where it assumed the JS engine stays
until after the re-port; the remaining G-items become acceptance criteria
for the #30/#31 rebuild instead of migration steps.

## Implementation update (2026-07-27)

Issue #30 is complete. The placeholder package and suspended compatibility
lane described in the teardown snapshot have been replaced by:

- a mechanical `ferriki-textmate` port of pinned vscode-textmate v9.3.2
- the native asset, rendering, N-API, and focused Node package integration
- an exact green vscode-textmate oracle
- a green, honestly aliased Shiki structural gate covering the four failure
  classes that triggered the re-port (v4.3.1, the baseline pinned at the time;
  the current baseline is `node/compat/upstream/shiki/.source.json`)

The remaining facade breadth in the sequence below belongs to issue #31.
ADR 0010 records the interpreter boundary and the final #30 validation result.

## Suggested sequence

1. **Done:** the compat-lane aliasing fix exists as the opt-in
   honest-alias mode, and the decision gate has been measured (see Gate
   result above); outcome: re-port.
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
