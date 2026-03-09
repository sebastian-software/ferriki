# Ferriki Phase 0 Migration Matrix

Goal: freeze the migration contract before restructuring the repository, so package deletion and test rewiring follow an explicit plan instead of happening ad hoc.

Date: 2026-03-06
Status: Drafted from current repo state

## Scope Assumptions

- End-state public products:
  - `crates/ferriki-core`
  - `npm/ferriki`
- `ferroni` is an external dependency of `crates/ferriki-core`, not a repository-owned product path.
- The vendored `packages/shiki-rust/vendor/ferroni` has been removed; consumers now target the official `ferroni` crate.
- Historical JavaScript/TypeScript tests remain valuable primarily as a compatibility corpus against the Node API, not as a reason to preserve the old package topology.
- The Ferriki v1 core claim is about the highlighting runtime and direct output APIs, not about every downstream JavaScript integration package in the old Shiki workspace.

### Scope refinement

Core product scope:

- highlighter lifecycle
- grammar and theme loading
- direct outputs such as HTML, tokens, and structured highlight results
- grammar state, decorations, and other behavior that belongs to the highlighting runtime itself

Optional compatibility lanes rather than core release blockers:

- `markdown-it`
- `rehype`
- `vitepress-twoslash`
- `monaco`
- `cli`
- other host-framework adapters that mainly wrap the core highlighter for an ecosystem

## Frozen API Contract For `ferriki`

This is the minimum Node-facing contract that must remain compatible during the migration:

- Highlighter lifecycle:
  - `createHighlighter`
  - `dispose`
  - `loadLanguage`
  - `loadLanguageSync`
  - `loadTheme`
  - `loadThemeSync`
- Highlighter operations:
  - `codeToHtml`
  - `codeToTokens`
  - `codeToTokensBase`
  - `codeToTokensWithThemes`
  - `codeToHast`
  - `getLastGrammarState`
- Registry and lookup behavior:
  - `getLanguage`
  - `getTheme`
  - `resolveLangAlias`
  - `getLoadedLanguages`
  - `getLoadedThemes`
- Convenience surface used by existing tests:
  - `codeToHtml` shorthand
  - singleton/high-level shorthands where they remain part of the top-level package contract

Out of contract for the target architecture:

- public JS regex engine constructors
- public Oniguruma/WASM loading APIs
- multi-package Shiki-branded export topology

## Test Disposition Matrix

Legend:

- `KEEP-1:1`: keep test logic essentially unchanged; only repoint imports and harness.
- `KEEP-REWIRE`: keep the test intent, but rewrite setup, package names, or snapshots.
- `PORT-RUST`: move the assertion into Rust crate/core tests.
- `PORT-NODE`: keep as a Node-facing product test, but relocate out of old package structure.
- `DROP`: remove because it only validates removed JS/WASM/runtime topology.

## A. Compatibility Suite Candidates

These tests exercise the public highlighting contract and should survive as close to 1:1 as practical.

Items that are primarily framework or ecosystem adapters should be treated as optional compatibility lanes unless Ferriki explicitly promotes them back into product scope.

| Path                                                                        | Disposition | Notes                                                                                                                          |
| --------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/markdown-it/test/index.test.ts`                                   | KEEP-1:1    | Optional adapter lane, not core product scope. Repoint `shiki` import to `ferriki` only if retained.                           |
| `packages/markdown-it/test/async.test.ts`                                   | KEEP-1:1    | Optional adapter lane, not core product scope.                                                                                 |
| `packages/rehype/test/core.test.ts`                                         | KEEP-1:1    | Optional adapter lane, not core product scope. Uses `createHighlighter` and `loadLanguage`.                                    |
| `packages/rehype/test/index.test.ts`                                        | KEEP-1:1    | Optional adapter lane, not core product scope.                                                                                 |
| `packages/twoslash/test/classic.test.ts`                                    | KEEP-1:1    | Top-level shorthand contract.                                                                                                  |
| `packages/twoslash/test/fixtures.test.ts`                                   | KEEP-1:1    | HAST/HTML output contract.                                                                                                     |
| `packages/twoslash/test/includes.test.ts`                                   | KEEP-1:1    | Multi-file + options coverage.                                                                                                 |
| `packages/twoslash/test/markdown-it.test.ts`                                | KEEP-1:1    | Downstream integration coverage.                                                                                               |
| `packages/twoslash/test/rich.test.ts`                                       | KEEP-REWIRE | Contains explicit `createHighlighterCore` / JS engine path; keep assertions but route through Ferriki-compatible surface only. |
| `packages/twoslash/test/target-multi-tokens.test.ts`                        | KEEP-1:1    | Preserves `codeToTokensBase` contract.                                                                                         |
| `packages/twoslash/test/token-split.test.ts`                                | KEEP-1:1    | Preserves token/HAST contract.                                                                                                 |
| `packages/twoslash/test/types-cache.test.ts`                                | KEEP-1:1    | Public highlighter caching behavior.                                                                                           |
| `packages/transformers/test/class-active-code.test.ts`                      | KEEP-1:1    | Depends on `codeToHtml` output contract.                                                                                       |
| `packages/transformers/test/fixtures.test.ts`                               | KEEP-1:1    | Snapshot-based contract coverage.                                                                                              |
| `packages/transformers/test/meta-line-highlight.test.ts`                    | KEEP-1:1    | Transformer contract.                                                                                                          |
| `packages/transformers/test/meta-word-highlight.test.ts`                    | KEEP-1:1    | Transformer contract.                                                                                                          |
| `packages/transformers/test/notation-diff-rose-pine.test.ts`                | KEEP-1:1    | Theme + transformer interaction.                                                                                               |
| `packages/transformers/test/parse-comments-multi-token.test.ts`             | KEEP-1:1    | Token-shape contract.                                                                                                          |
| `packages/transformers/test/style-to-class.test.ts`                         | KEEP-1:1    | HTML/style contract.                                                                                                           |
| `packages/transformers/test/transformer-meta-highlight-zeroIndexed.test.ts` | KEEP-1:1    | Existing snapshot contract.                                                                                                    |
| `packages/transformers/test/utils.test.ts`                                  | KEEP-1:1    | Helper behavior backed by current output shape.                                                                                |
| `packages/transformers/test/whitespace-inline.test.ts`                      | KEEP-1:1    | Whitespace rendering behavior.                                                                                                 |
| `packages/colorized-brackets/test/bracket-customization.test.ts`            | KEEP-1:1    | High-level integration.                                                                                                        |
| `packages/colorized-brackets/test/dual-themes.test.ts`                      | KEEP-1:1    | Theme-map compatibility.                                                                                                       |
| `packages/colorized-brackets/test/explicit-trigger.test.ts`                 | KEEP-1:1    | Public API behavior.                                                                                                           |
| `packages/colorized-brackets/test/fixtures.test.ts`                         | KEEP-1:1    | Fixture-backed compatibility.                                                                                                  |
| `packages/vitepress-twoslash/test/fixtures.test.ts`                         | KEEP-1:1    | Optional adapter lane, not core product scope.                                                                                 |
| `packages/shiki/test/ansi.test.ts`                                          | KEEP-1:1    | Public top-level shorthand coverage.                                                                                           |
| `packages/shiki/test/astro.test.ts`                                         | KEEP-1:1    | Public `createHighlighter` integration.                                                                                        |
| `packages/shiki/test/color-replacement.test.ts`                             | KEEP-1:1    | Important because current Rust adapter still emulates this in TS.                                                              |
| `packages/shiki/test/general.test.ts`                                       | KEEP-1:1    | General public behavior.                                                                                                       |
| `packages/shiki/test/grammar-state.test.ts`                                 | KEEP-1:1    | Key grammar-state contract.                                                                                                    |
| `packages/shiki/test/shorthands.test.ts`                                    | KEEP-1:1    | Top-level shorthand exports.                                                                                                   |
| `packages/shiki/test/shorthands-markdown.test.ts`                           | KEEP-1:1    | Markdown shorthand behavior.                                                                                                   |
| `packages/shiki/test/theme-none.test.ts`                                    | KEEP-1:1    | Important special-case contract.                                                                                               |
| `packages/shiki/test/themes.test.ts`                                        | KEEP-1:1    | Theme behavior contract.                                                                                                       |
| `packages/monaco/test/repro.test.ts`                                        | KEEP-REWIRE | Optional adapter lane. Keep only if Monaco support remains part of compatibility claim.                                        |

## B. Keep, But Rewire Because Topology Changes

These tests remain useful, but old package names, exports, or package boundaries are going away.

| Path                                          | Disposition | Notes                                                                                                               |
| --------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `test/exports.test.ts`                        | KEEP-REWIRE | Replace multi-package snapshotting with `ferriki` export snapshot plus any retained crate/npm metadata checks.      |
| `test/exports/*.yaml`                         | KEEP-REWIRE | Regenerate around Ferriki package shape; old `@shikijs/*` manifests should not survive.                             |
| `test/shiki-backend-entry.ts`                 | DROP        | Transitional env-router for `SHIKI_BACKEND`; unnecessary once `ferriki` is the default Node package.                |
| `packages/cli/test/cli.test.ts`               | KEEP-REWIRE | Optional adapter lane. Keep only if CLI becomes a `bin` inside `npm/ferriki`; otherwise drop with package deletion. |
| `packages/shiki/test/bundle.test.ts`          | KEEP-REWIRE | Old bundle package topology disappears; keep only if Ferriki still promises bundled entrypoints.                    |
| `packages/shiki/test/dist.test.ts`            | KEEP-REWIRE | Reframe around Ferriki package distribution, not old `packages/shiki` dist layout.                                  |
| `packages/shiki/test/get-highlighter.test.ts` | KEEP-REWIRE | Remove JS/WASM engine assertions; keep singleton/highlighter lifecycle behavior if still public.                    |
| `packages/core/test/hast.test.ts`             | KEEP-REWIRE | Public output behavior is useful, but old package-local imports should target Ferriki API.                          |
| `packages/core/test/decorations.test.ts`      | KEEP-REWIRE | Keep if decorations remain supported by Node API; currently TS adapter falls back to JS path here.                  |
| `packages/core/test/strings-enhanced.test.ts` | KEEP-REWIRE | Preserve only if behavior is still public through Ferriki.                                                          |
| `packages/core/test/utils.test.ts`            | KEEP-REWIRE | Keep where it validates public-facing semantics rather than internal helpers.                                       |

## C. Port Out Of `packages/shiki-rust/test`

These tests are valuable, but they are currently written against the transitional bridge package and `SHIKI_BACKEND=rust`. They should not stay under a deleted `packages/shiki-rust` package.

Default rule:

- If the test validates runtime semantics, move it to Rust integration tests in `crates/ferriki-core`.
- If the test validates Node API shape, binding behavior, or JSON/grammar-state marshalling, keep it as Node product tests under `npm/ferriki`.

| Path                                                                         | Disposition           | Notes                                                                                          |
| ---------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/shiki-rust/test/color-replacements-parity.test.ts`                 | PORT-RUST + PORT-NODE | Runtime logic should move to Rust; keep one Node regression for payload shape.                 |
| `packages/shiki-rust/test/escaping-whitespace-parity.test.ts`                | PORT-RUST             | Rendering parity rule.                                                                         |
| `packages/shiki-rust/test/grammar-apply-end-pattern-last.test.ts`            | PORT-RUST             | TextMate semantics.                                                                            |
| `packages/shiki-rust/test/grammar-base-include-repository-scope.test.ts`     | PORT-RUST             | Grammar resolution semantics.                                                                  |
| `packages/shiki-rust/test/grammar-base-include-scope.test.ts`                | PORT-RUST             | Grammar resolution semantics.                                                                  |
| `packages/shiki-rust/test/grammar-captures-fallback.test.ts`                 | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-captures.test.ts`                          | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-content-name.test.ts`                      | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-end-backref.test.ts`                       | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-external-injections-dynamic.test.ts`       | PORT-RUST + PORT-NODE | Runtime behavior plus load-language marshalling coverage.                                      |
| `packages/shiki-rust/test/grammar-external-injections.test.ts`               | PORT-RUST             | Runtime semantics.                                                                             |
| `packages/shiki-rust/test/grammar-html-whitespace-merge.test.ts`             | PORT-RUST             | Rendering semantics.                                                                           |
| `packages/shiki-rust/test/grammar-include-cross-scope-key-collision.test.ts` | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-include-cross-scope-repository.test.ts`    | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-include-scope.test.ts`                     | PORT-RUST + PORT-NODE | Keep one Node test for native registry exposure.                                               |
| `packages/shiki-rust/test/grammar-injections-priority.test.ts`               | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-injections-selector-boolean.test.ts`       | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-injections-selector.test.ts`               | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-injections.test.ts`                        | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-set-precedence.test.ts`                    | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-set.test.ts`                               | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-skeleton.test.ts`                          | PORT-RUST + PORT-NODE | Skeleton grammar behavior in Rust; one Node smoke for adapter visibility.                      |
| `packages/shiki-rust/test/grammar-state.test.ts`                             | PORT-RUST + PORT-NODE | Grammar state semantics in Rust, marshalling shape in Node.                                    |
| `packages/shiki-rust/test/grammar-theme-html.test.ts`                        | PORT-RUST             | Rendering semantics.                                                                           |
| `packages/shiki-rust/test/grammar-theme-style.test.ts`                       | PORT-RUST             | Theme semantics.                                                                               |
| `packages/shiki-rust/test/grammar-theme-token-metadata.test.ts`              | PORT-RUST + PORT-NODE | Token metadata plus Node payload shape.                                                        |
| `packages/shiki-rust/test/grammar-while-backref.test.ts`                     | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-while-captures-fallback.test.ts`           | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-while-captures-parity.test.ts`             | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/grammar-while.test.ts`                             | PORT-RUST             | Grammar semantics.                                                                             |
| `packages/shiki-rust/test/json-parity.test.ts`                               | PORT-RUST + PORT-NODE | Runtime parity plus one Node regression.                                                       |
| `packages/shiki-rust/test/load-language-registry.test.ts`                    | PORT-NODE             | Binding/marshalling behavior.                                                                  |
| `packages/shiki-rust/test/parity-matrix-expanded.test.ts`                    | PORT-RUST             | Replace with Rust-driven parity fixtures; keep report generation optional.                     |
| `packages/shiki-rust/test/plain-theme-parity.test.ts`                        | PORT-RUST             | Theme/render semantics.                                                                        |
| `packages/shiki-rust/test/realworld-snapshot-parity.test.ts`                 | PORT-RUST + PORT-NODE | Keep as high-value parity corpus; split into Rust fixture tests plus one end-to-end Node lane. |
| `packages/shiki-rust/test/theme-default-fg.test.ts`                          | PORT-RUST             | Theme semantics.                                                                               |
| `packages/shiki-rust/test/theme-html-application.test.ts`                    | PORT-RUST             | Theme/render semantics.                                                                        |
| `packages/shiki-rust/test/theme-map-variants-parity.test.ts`                 | PORT-RUST             | Theme-map semantics.                                                                           |
| `packages/shiki-rust/test/theme-none-parity.test.ts`                         | PORT-RUST             | Special theme semantics.                                                                       |
| `packages/shiki-rust/test/theme-token-palette.test.ts`                       | PORT-RUST             | Theme semantics.                                                                               |

Generated reports:

- `packages/shiki-rust/test/out/json-parity-report.json`: DROP as package-local artifact; regenerate under new parity tooling if still useful.
- `packages/shiki-rust/test/out/realworld-parity-report.json`: DROP as package-local artifact; regenerate under new parity tooling if still useful.

## D. Low-Level Tests To Preserve, But Relocate

These are not part of the compatibility suite, but they still express useful product behavior.

| Path                                          | Disposition | Notes                                                                                                                                |
| --------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/engine-ferroni/test/smoke.test.ts`  | PORT-NODE   | Move to `npm/ferriki` low-level binding smoke tests if a low-level scanner API remains exposed.                                      |
| `packages/engine-ferroni/test/parity.test.ts` | PORT-RUST   | Convert to crate-level Ferroni parity tests against known reference behavior, not against `engine-oniguruma` package infrastructure. |

## E. Tests To Drop With JS/WASM Runtime Removal

These tests exist to validate surfaces the target architecture explicitly removes.

| Path                                                            | Disposition | Notes                                                                                                                           |
| --------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/engine-javascript/test/general.test.ts`               | DROP        | JS regex engine package removed.                                                                                                |
| `packages/engine-javascript/test/raw.test.ts`                   | DROP        | JS raw engine package removed.                                                                                                  |
| `packages/engine-javascript/test/compare.test.ts`               | DROP        | Compares JS engine to Oniguruma/WASM.                                                                                           |
| `packages/engine-javascript/test/verify.test.ts`                | DROP        | Snapshot verification for removed JS-vs-WASM corpus.                                                                            |
| `packages/engine-javascript/test/__records__/*`                 | DROP        | Artifacts for removed engine suite.                                                                                             |
| `packages/engine-javascript/test/out/*`                         | DROP        | Removed engine artifacts.                                                                                                       |
| `packages/engine-oniguruma/test/wasm1.test.ts`                  | DROP        | WASM loader removed.                                                                                                            |
| `packages/engine-oniguruma/test/wasm2.test.ts`                  | DROP        | WASM loader removed.                                                                                                            |
| `packages/engine-oniguruma/test/wasm3.test.ts`                  | DROP        | WASM loader removed.                                                                                                            |
| `packages/engine-oniguruma/test/wasm4.test.ts`                  | DROP        | WASM loader removed.                                                                                                            |
| `packages/engine-oniguruma/test/wasm5.test.ts`                  | DROP        | WASM loader removed.                                                                                                            |
| `packages/engine-oniguruma/test/wasm6.test.ts`                  | DROP        | WASM loader removed.                                                                                                            |
| `packages/shiki/test/cf.ts`                                     | DROP        | Cloudflare/WASM path removed.                                                                                                   |
| `packages/codegen/test/codegen.test.ts`                         | DROP        | Current snapshots are built around `engine: 'oniguruma'` and `engine: 'javascript-raw'`; obsolete under single-runtime Ferriki. |
| `packages/codegen/test/__snapshots__/basic-oniguruma.ts`        | DROP        | Old engine topology snapshot.                                                                                                   |
| `packages/codegen/test/__snapshots__/basic-oniguruma-js.js`     | DROP        | Old engine topology snapshot.                                                                                                   |
| `packages/codegen/test/__snapshots__/basic-precompiled.ts`      | DROP        | Old precompiled JS-engine topology snapshot.                                                                                    |
| `packages/langs-precompiled/tests/precompile-run.test.ts`       | DROP        | Depends on removed JS raw engine path.                                                                                          |
| `packages/langs-precompiled/tests/precompile-serialize.test.ts` | DROP        | Depends on precompiled JS-engine artifact flow.                                                                                 |
| `packages/langs-precompiled/tests/__snapshots__/*`              | DROP        | Artifacts for removed precompiled engine flow.                                                                                  |

## F. Internal-Core Tests That Need Reclassification

These tests live under internal packages that are unlikely to survive in their current form. They should be split based on what they actually verify.

| Path                                       | Disposition | Notes                                                                       |
| ------------------------------------------ | ----------- | --------------------------------------------------------------------------- |
| `packages/core/test/alias.test.ts`         | KEEP-REWIRE | Keep if alias resolution remains public through Ferriki.                    |
| `packages/core/test/ansi.test.ts`          | KEEP-REWIRE | Keep if ANSI remains in public API.                                         |
| `packages/core/test/core-sync.test.ts`     | DROP        | Built around explicit JS engine constructor.                                |
| `packages/core/test/core.test.ts`          | SPLIT       | Keep generic highlighter behavior; drop JS/WASM engine matrix.              |
| `packages/core/test/css-variables.test.ts` | KEEP-REWIRE | Keep if theme css-variable output remains public.                           |
| `packages/core/test/injections.test.ts`    | SPLIT       | Keep injection semantics; remove explicit JS engine setup.                  |
| `packages/core/test/registry.test.ts`      | SPLIT       | Keep registry behavior; remove `engine-javascript` dependency.              |
| `packages/core/test/tokens.test.ts`        | SPLIT       | Keep token-shape assertions; remove explicit engine constructor dependency. |
| `packages/core/test/transformers.test.ts`  | SPLIT       | Keep public transformer behavior; remove package-local engine setup.        |

`SPLIT` means: extract the part that still validates Ferriki's public contract, and move the rest either to Rust tests or drop it with the removed runtime constructors.

## Remaining TS Business Logic Inventory

The current `packages/shiki-rust/src/index.ts` still contains a large amount of runtime logic that should move to Rust or disappear with the old bridge package.

### Binding-only or near-binding code that can survive in `npm/ferriki`

| Lines       | Functionality                              | Target                                                          |
| ----------- | ------------------------------------------ | --------------------------------------------------------------- |
| `13-22`     | backend/version/native availability probes | Keep only insofar as Node package needs addon discovery.        |
| `31-37`     | JSON marshalling helper                    | Keep in Node binding.                                           |
| `362-368`   | native error wrappers                      | Keep in Node binding, rename to Ferriki branding.               |
| `1383-1411` | highlighter creation and addon hookup      | Keep structurally, but point at `npm/ferriki` + `ferriki-core`. |

### Runtime/business logic that should move into Rust

| Lines       | Functionality                                                                                                     | Why it belongs in Rust                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `87-160`    | theme/lang parsing for grammar state                                                                              | Runtime policy, not binding glue.                                                          |
| `163-345`   | grammar-state construction and fallback synthesis                                                                 | Highlighter/runtime semantics.                                                             |
| `347-359`   | grammar-state payload preparation                                                                                 | Serialization contract should be defined by Rust runtime.                                  |
| `374-465`   | color replacement handling                                                                                        | Currently business logic in TS; should be native behavior if public.                       |
| `492-917`   | themes-map parsing, token synchronization, HTML assembly inputs                                                   | Large block of rendering/runtime policy.                                                   |
| `919-967`   | token payload normalization                                                                                       | Node may normalize transport shape, but source semantics should come from Rust.            |
| `986-1056`  | theme extraction and native registry synchronization                                                              | Theme/runtime registration policy.                                                         |
| `1073-1221` | grammar/language extraction and registry synchronization                                                          | Grammar/runtime registration policy.                                                       |
| `1223-1381` | parity adapter behavior for `codeToHtml`, `codeToTokens`, `loadLanguage`, `loadTheme`, fallback/decorations logic | This is the main transitional runtime layer and should be either moved to Rust or deleted. |

### Transitional code to delete instead of port

| Lines       | Functionality                                             | Reason                                                                      |
| ----------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `7`         | re-export of `../../shiki/src/index`                      | Old package topology is leaving.                                            |
| `9-15`      | `SHIKI_BACKEND` selection                                 | Temporary migration switch only.                                            |
| `79-85`     | unsupported-reason stubs                                  | Transitional feature gating.                                                |
| `1237-1242` | JS fallback on decorations                                | Symptom of split runtime; should disappear once Rust owns feature behavior. |
| `1333-1365` | proxy-based sync from JS highlighter into native registry | Only needed because JS runtime is still the source of truth.                |
| `1401-1411` | create JS highlighter first, then wrap it                 | Transitional architecture; end-state should instantiate Ferriki directly.   |

## Recommended Immediate Work Items

1. Create a new test home for the future compatibility corpus, separate from package-local product tests.
2. Freeze a reduced compatibility manifest based on sections A and B.
3. Split `packages/shiki-rust/test/*` into:
   - Rust integration targets
   - Node binding targets
4. Mark section E for deletion once replacement coverage exists.
5. Start Phase 1 only after the `packages/shiki-rust/src/index.ts` runtime block has an explicit extraction order.
