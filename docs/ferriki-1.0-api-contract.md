# Ferriki 1.0 Node API Contract

Status: accepted baseline for the 1.x release line.

This document freezes the public Node contract for Ferriki's highlighter and
the integration requirements tracked by its consumers. It does not state the
release status of Ardo, Ferromark, or any adapter migration, and it is not a
promise to reproduce every Shiki package. Runtime, declarations, docs, and
compatibility tests must converge on this matrix.

## Contract vocabulary

- **Stable**: part of the supported 1.0 surface. Compatible changes require
  the normal semver policy.
- **Shim**: retained for migration compatibility, with the limits documented
  here. A shim is not a promise to reproduce the original implementation.
- **Remove**: present only to ease pre-1.0 migration and removed before 1.0;
  new code must not depend on it.
- **Deferred**: known upstream behavior that Ferriki does not implement today;
  it is excluded from the Ferriki input type and tracked for a separate product
  decision, without a promise that it will be implemented.
- **Non-goal**: deliberately outside Ferriki's product boundary.

## Export and method matrix

| Surface                                                                | 1.0 status | Contract                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ShikiError`                                                           | Stable     | Public error identity. Facade validation and lifecycle failures use this class; native implementation details do not leak as the normal API.                                                                                         |
| `ferrikiVersion()`                                                     | Stable     | Returns the loaded native core version, or `undefined` when the platform binding is unavailable.                                                                                                                                     |
| `createHighlighter()`                                                  | Stable     | Async factory for lazy language/theme inputs and reusable highlighting.                                                                                                                                                              |
| `createHighlighterCore()`                                              | Stable     | Async reusable factory with the same highlighter contract and no adapter ownership.                                                                                                                                                  |
| `createHighlighterCoreSync()`                                          | Stable     | Sync reusable factory for already-resolved registrations.                                                                                                                                                                            |
| `getSingletonHighlighter()`                                            | Stable     | Process-local async singleton; later calls add requested registrations and return the same handle.                                                                                                                                   |
| `getSingletonHighlighterCore()`                                        | Shim       | Alias retained for Shiki migrations; same singleton semantics as `getSingletonHighlighter()`.                                                                                                                                        |
| `createShikiPrimitiveAsync()`                                          | Shim       | Alias retained while upstream consumers migrate; no separate primitive runtime is promised.                                                                                                                                          |
| `createShikiPrimitive()`                                               | Shim       | Sync alias for `createHighlighterCoreSync()`.                                                                                                                                                                                        |
| `codeToHtml()`                                                         | Stable     | Top-level async shorthand or sync reusable-highlighter method. Ferriki escapes source text; callback HAST changes and HTML replacements by transformer `postprocess` hooks are not sanitized and remain the caller's responsibility. |
| `codeToHast()`                                                         | Remove     | Top-level shorthand and reusable-highlighter method are removed before 1.0; use `codeToHtml()` or the HTML transformer callbacks.                                                                                                    |
| `codeToTokens()`                                                       | Remove     | Top-level shorthand and reusable-highlighter method are removed before 1.0; token data remains available inside transformer callbacks.                                                                                               |
| `codeToTokensBase()`                                                   | Remove     | Structured-output convenience method removed before 1.0; no alias or compatibility package is provided.                                                                                                                              |
| `codeToTokensWithThemes()`                                             | Remove     | Structured-output convenience method removed before 1.0; use the public HTML theme-map path.                                                                                                                                         |
| `hastToHtml()`                                                         | Remove     | Public serializer removed with standalone HAST output; Ferriki serializes its internal tree during HTML rendering.                                                                                                                   |
| `getLastGrammarState()`                                                | Stable     | Top-level async shorthand or synchronous highlighter method taking source text and a grammar-backed language; plain-text aliases and `ansi` are rejected. Pass the result to `codeToHtml()` through `grammarState`.                  |
| `bundledLanguages` / `bundledThemes`                                   | Stable     | Deterministically enumerable lazy loader maps. Language keys include canonical IDs and supported aliases; enumeration never loads asset payloads.                                                                                    |
| `bundledLanguagesAlias`                                                | Stable     | Deterministic alias-to-canonical map used by catalog discovery and `getLoadedLanguages()`.                                                                                                                                           |
| `createCssVariablesTheme()`                                            | Stable     | Creates a typed CSS-variable theme registration; details are covered by the theme contract (#48).                                                                                                                                    |
| `createJavaScriptRegexEngine()`                                        | Removed    | The native runtime owns matching; use Ferriki's native factories without engine injection.                                                                                                                                           |
| `createOnigurumaEngine()`                                              | Removed    | The native runtime owns matching; use Ferriki's native factories without engine injection.                                                                                                                                           |
| `loadWasm()` / `wasmBinary`                                            | Removed    | Browser/WASM loading is not a Ferriki 1.0 runtime path.                                                                                                                                                                              |
| Markdown, rehype, VitePress, Twoslash, and colorized-brackets packages | Non-goal   | Optional adapter lanes may be tested separately; they are not Ferriki core exports (#38, ADR 0004).                                                                                                                                  |
| Rust crates through npm                                                | Non-goal   | The npm package exposes no Rust API. The Rust crates are published separately and have their own contract (ADR 0012, ADR 0014, `docs/rust-api.md`).                                                                                  |

### Additive class output

`codeToHtmlWithCss` is a Ferriki extension returning `{ html, css }` from existing
TextMate themes. Theme maps switch through `data-ferriki-theme` without replacing
tokens. The normal output stays unchanged; `check:classes` runs in the mandatory
core gate. See [Class-based highlighting](class-highlighting.md).

## Input and output matrix

### Factory inputs

`transformers` is a stable factory input for both async and sync constructors.
It supplies defaults to public HTML calls. A call's explicit list replaces the
defaults, including `[]` to disable them; omission or `undefined` inherits
them. The constructor copies the array. Hooks follow the existing
`enforce: 'pre'`, normal, `enforce: 'post'` tiers with stable order within each
tier. The HTML pipeline runs token and HAST hooks internally before
`postprocess`; those stages provide callback data, not standalone Node results.
The singleton retains its first creation's defaults.

| Input                | Status  | Rules                                                                                                                                                                                                                                                                                      |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `langs`              | Stable  | Accepts names, synchronous registrations, arrays, promises, or loader functions. Custom registrations are validated and cached (#46).                                                                                                                                                      |
| `themes`             | Stable  | Accepts names, synchronous registrations, arrays, promises, or loader functions. Custom registrations are validated and cached (#46).                                                                                                                                                      |
| `langAlias`          | Stable  | Explicit alias-to-canonical mapping. Cycles and unknown targets produce `ShikiError`.                                                                                                                                                                                                      |
| `assets`             | Stable  | `{ remote, baseUrl, cacheDir }` for the release-pinned standard payloads (ADR 0013). Unset fields fall back to `FERRIKI_ASSETS_REMOTE`, `FERRIKI_ASSETS_BASE_URL` and `FERRIKI_CACHE_DIR`; an explicit option wins. Unknown keys and invalid values produce `ShikiError` with `ERR_USAGE`. |
| `engine`             | Removed | Engine injection is not a Ferriki runtime extension point; native matching is selected by the Ferriki binding.                                                                                                                                                                             |
| Unknown factory keys | Remove  | Do not silently widen the public type. Unsupported keys are rejected by the typed API and validated at runtime where practical (#10, #42).                                                                                                                                                 |

### Highlight options

| Option                                        | Status   | Rules                                                                                                                                                                                                                            |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `styleMode`                                   | Stable   | `inline` (default) or nested `classes`; preserves full grammar boundaries. See [class guide](class-highlighting.md) and `check:classes`.                                                                                         |
| `lang`                                        | Stable   | Required by the TypeScript declaration; HTML runtime defaults an omitted value to `text`. `getLastGrammarState()` requires a grammar-backed language; `text`, `txt`, `plain`, `plaintext`, and `ansi` are rejected.              |
| `theme`                                       | Stable   | Single-theme rendering with deterministic class, foreground, and background output.                                                                                                                                              |
| `themes`                                      | Stable   | Ordered theme map for light/dark or multi-theme output; never silently collapsed to one theme. `defaultColor: false` emits CSS variables for every theme.                                                                        |
| `defaultColor`                                | Stable   | `light`, `dark`, a named theme, or `false`; invalid combinations throw `ShikiError` (#43).                                                                                                                                       |
| `meta`                                        | Stable   | Opaque fence metadata passed through the JS facade for Ferromark/Ardo integration (#55), without changing the source trust boundary. Ardo parses title/label/line attributes; Ferriki never interpolates `meta.__raw` into HTML. |
| `data`                                        | Stable   | Callback-only metadata attached to the internal root `<pre>` HAST node in classic structure. The serializer omits it from HTML; inline structure has no `<pre>` node, and no public method returns the node.                     |
| `transformers`                                | Stable   | JS callbacks run during HTML rendering. Token payloads and Ferriki HAST nodes are callback data, not public structured results (ADR 0008, #45, #207).                                                                            |
| `decorations`                                 | Stable   | Declarative ranges are validated and applied in the JS rendering layer (ADR 0008, #45).                                                                                                                                          |
| `includeExplanation`                          | Stable   | Controls `scopeNames` and `type` metadata in token transformer callbacks; there is no public explanation array (#47, #207).                                                                                                      |
| `grammarState`                                | Stable   | Continues HTML grammar inference from serializable state returned by `getLastGrammarState(code, options)`; no token/HAST result overloads.                                                                                       |
| `mergeWhitespaces` / `mergeSameStyleTokens`   | Stable   | Rendering controls with deterministic token boundaries.                                                                                                                                                                          |
| `colorReplacements`                           | Deferred | Not implemented by Ferriki; supplying it throws `ShikiError` with `ERR_UNSUPPORTED`. Runtime support is tracked separately in #190.                                                                                              |
| `rootStyle` / `tabindex`                      | Stable   | Explicit HTML root attributes; `false`/`null` disable the corresponding output.                                                                                                                                                  |
| `tokenizeMaxLineLength` / `tokenizeTimeLimit` | Stable   | Resource limits with deterministic `ShikiError` failures (#51).                                                                                                                                                                  |
| ANSI input                                    | Removed  | Ferriki rejects terminal escape sequences with `ShikiError`; callers must strip or parse ANSI before highlighting.                                                                                                               |
| `theme: 'none'`                               | Stable   | Explicit unstyled theme with documented inheritance in multi-theme output (#48).                                                                                                                                                 |
| Unknown options                               | Remove   | No catch-all option type. New options require a contract entry and a compatibility test (#10, #42).                                                                                                                              |

### Transformer callback data and HTML output

- `codeToHtml()` and `codeToHtmlWithCss()` are the public Node render outputs.
  The pipeline constructs token and HAST data internally for transformers and
  decorations; no public method returns those structures.
- Token callbacks retain UTF-16 offsets, source line boundaries, deterministic
  font metadata, aligned theme variants, and the `scopeNames`/`type` metadata
  selected by `includeExplanation`.
  Ferriki's typed HAST nodes remain available to HAST callbacks and decoration
  callbacks. The transformer context has no `codeToHast` or `codeToTokens`
  convenience method.
- `getLastGrammarState(code, options)` returns serializable continuation state
  from source text when `lang` is grammar-backed. The helper rejects `text`,
  `txt`, `plain`, `plaintext`, and `ansi`; an omitted runtime `lang` defaults to
  `text` for HTML calls, although the TypeScript declaration requires `lang`.
  Pass that state through `grammarState` to a later HTML render; there are no
  token-result or HAST-result overloads.
- Standalone Node HAST/token methods and the public `hastToHtml()` serializer
  are removed before 1.0. This is a deliberate breaking divergence from
  Shiki, with no deprecated aliases or compatibility package.
- `HighlightOptions.data` is attached to the internal root `<pre>` HAST node in
  classic structure for callbacks only. The serializer omits `node.data`; the
  inline structure has no `<pre>` node, and the Node API returns no HAST result.
- The public Rust token APIs are unchanged. Ferriki escapes source text at the
  HTML boundary. Transformer and decoration callbacks can change HAST, and a
  transformer `postprocess` hook can replace HTML. Ferriki does not sanitize
  these changes; the caller must apply its own policy to callback-generated
  markup.

## Lifecycle, concurrency, and errors

The 1.0 runtime floor is Node.js 22.13.0. Supported native targets are
Linux x64/arm64 with glibc or musl, macOS arm64 (Apple Silicon), and Windows x64/arm64
with MSVC. macOS Intel and other architectures are explicit non-support until a tested
sidecar is published (see #52).

- A highlighter handle owns its native state and must be disposable. Calls
  after `dispose()` throw `ShikiError` with a stable lifecycle category (#51).
- Async registration loading is explicit; sync factories reject unresolved
  promises and loader functions with `ShikiError`.
- Concurrent async loads are deduplicated per handle. Rendering calls are
  safe to interleave without leaking languages, themes, or aliases between
  handles (#51).
- Validation failures have stable `ShikiError` identity and a
  machine-readable `code` category (#50). Message text is documented for
  user-facing migration errors; native stack details are not part of the
  contract.
- Missing native bindings fail at import/use with an actionable platform
  error. There is no JS, WASM, or silent plaintext fallback runtime.
- Standard grammar and theme payloads are not bundled (ADR 0013). Only the
  asynchronous paths (`createHighlighter`, `getSingletonHighlighter`,
  `loadLanguage`, `loadTheme` and the one-shot functions for the `lang`,
  `theme` and `themes` they receive) download, verify and cache payloads,
  including a language's embedded languages. Synchronous factories, sync
  loads and highlighting never perform I/O beyond the cache. A payload that
  cannot be downloaded, fails its SHA-256 digest, or is missing from the cache
  with downloads turned off fails with `FerrikiError` and `ERR_ASSET`, whose
  message names the remedies. Downloads are not retried.

## Ardo and Ferromark traceability

| Consumer requirement           | Contract entry                                                                    | Owning follow-up |
| ------------------------------ | --------------------------------------------------------------------------------- | ---------------- |
| Synchronous fenced rendering   | `Highlighter.codeToHtml()`                                                        | #42, #55         |
| Lazy language/theme discovery  | Enumerable catalogs and loader inputs                                             | #44, #46         |
| Light/dark output              | `themes`, `defaultColor`, HTML and resolved CSS                                   | #43              |
| Line/title/fence metadata      | `meta` through HTML callbacks; Ardo owns container/title/line attributes          | #45, #55         |
| Safe unknown-language fallback | `ShikiError` taxonomy and the public adapter's escaped fallback/diagnostic policy | #50, #55         |
| Line highlighting/decorations  | JS transformer/decorator pipeline                                                 | #45, ADR 0008    |
| No private native calls        | Node exports only                                                                 | #10, #31         |

## Compatibility and semver policy

### TypeScript compatibility

The CI typecheck job builds the pinned Shiki mirror and includes
`node/ferriki/shiki-type-conformance.typecheck.ts` in the workspace TypeScript
project. Key-set assertions catch new optional mirror fields that ordinary
structural assignment would otherwise allow to disappear. Any new difference
must be supported or added to the explicit boundary below.

- Inputs are checked from Shiki's full code-to-HAST and factory option shapes
  into Ferriki. Key guards account for every mirrored option, so new optional
  fields cannot silently disappear. Theme registrations are narrowed to the
  named values Ferriki accepts, and `undefined` entries in `themes` are filtered
  at runtime. String `tabindex` is supported; `mergeWhitespaces` accepts
  booleans only. `colorReplacements` is deferred and rejected at runtime with
  `ERR_UNSUPPORTED` (#190); `grammarContextCode` and `colorsRendering` are
  outside the Ferriki input contract. The broad HAST-options value comparison
  separately lists `grammarState`, `transformers`, and `decorations` as native
  type boundaries: grammar state and transformer contexts use Ferriki types,
  and decoration transform callbacks receive Ferriki HAST nodes. Factory
  `engine` injection is removed, and Shiki's `warnings` toggle is not a Ferriki
  option.
- Ferriki `ThemedToken` values supplied to transformer callbacks are checked
  against the mirrored Shiki token shape. They carry `scopeNames` and `type`
  metadata but no `explanation` array. There is no public Node
  `TokensResult`; Ferriki's JSON-serializable `GrammarState` is retrieved with
  `getLastGrammarState(code, options)` and passed to later `codeToHtml()` calls,
  while Shiki's state exposes internal stack methods.
- The token boundary explicitly omits upstream per-token `bgColor` and
  explanation `themeMatches`; transformer token payloads carry resolved
  styling. Ferriki's `scopeNames` and multi-theme `variants` are callback
  payload extensions. `includeExplanation` controls the callback scope and
  token type metadata without adding an explanation array.
- `HastRoot` keeps property values as `unknown` for serializable callback
  metadata, so it is not a full `@types/hast` `Root`. JavaScript transformer
  hooks remain supported, with shared token payload and context source/token
  fields checked separately. The full `ShikiTransformer` context is not
  interchangeable: Ferriki uses its own grammar-state and HAST types and omits
  Shiki's nested `codeToHast`/`codeToTokens` convenience methods. Type
  transformers as Ferriki's `ShikiTransformer`. Decoration values without a
  transform callback are structurally shared; callback node types follow the
  same Ferriki HAST boundary.

### Release guarantees

- The accepted Stable rows are the Ferriki 1.x compatibility promise.
- Shims are documented, covered by migration tests, and may emit a deprecation
  notice in a minor release. They are removed only in a planned major release
  or before 1.0 when this document marks them **Remove**.
- The Node structured-output methods marked **Remove** have no deprecated
  aliases or compatibility package; consumers must migrate before Ferriki 1.0.
- Every upstream compatibility test is classified as supported, deferred to a
  linked issue, or an intentional non-goal. A green mandatory gate never
  counts deferred tests as passing contracts.
- The Shiki mirror version is pinned independently from this API contract and
  is updated only through the explicit sync procedure (#36, #40, #41).

## Build-time macro subpaths

The additive `@ferriki/core/macro` entry defines `code` and its prepared
HTML/CSS descriptor; executing an unprocessed marker throws. Macro recognition
belongs to `@ferriki/vite`; `@ferriki/core` exports no build-time transform
entry. These entries add no runtime browser highlighter or token/HAST output.
The contract and supported inline syntax are in [ADR
0018](../adr/0018-inline-highlighting-macros.md) and the [macro
guide](inline-code-macros.md). Root render outputs stay unchanged.

`@ferriki/core/react/macro` adds the optional `Code` JSX marker. Its required
`source` and `language` and optional `meta` and `lineNumbers` attributes are
literal-only. Elements are self-closing and accept no children. An optional
`render` function receives `{ code: PreparedCodeBlock, className?: string }`
during application rendering, with explicit prop forwarding in ordinary JSX.
`className` accepts a string or runtime expression and applies to the default
`div`, or is passed to the renderer when supplied. An absent or `undefined`
renderer uses the default prepared-HTML container; callback results are
retained. The marker and import are erased before React's JSX transform. React
is only required by consumers of this entry's type declarations and generated
JSX, not by the core runtime.
