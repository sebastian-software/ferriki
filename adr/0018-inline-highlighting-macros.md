# ADR 0018: Prepare Inline Highlighting Macros at Build Time

## Status

Accepted

Last updated: 2026-10-04

## Context

Authored code examples do not always use intrinsic `pre`/`code` markup. A
component may accept a prepared example and own its toolbar, copy action or
tabs. The optional Vite adapter's static-markup path cannot identify that
component-independent boundary. Issue #211 narrows the initial requirement to
inline content, following Palamedes' explicitly imported macro model.

The public Node output direction remains HTML and CSS ([ADR 0017](0017-node-html-output-priority.md)).
Macro processing must not introduce a browser highlighter or execute arbitrary
application JavaScript during a transform.

## Decision

- `@ferriki/core/macro` exports `code(source, options)`. The entry contains
  only the marker and types; it imports no native binding, highlighter or asset
  transport. Executing an unprocessed marker throws an actionable error asking
  the author to configure the build integration.
- `@ferriki/core/react/macro` exports the optional React JSX marker `Code`.
  Its required `source` attribute accepts the same direct string or cooked
  template literal as `code()`. It requires static `language` and accepts
  static `meta` and `lineNumbers`. It accepts only self-closing JSX elements;
  children, spreads, duplicate attributes and unsupported attributes fail
  compilation. The entry contains no React runtime import or native loader;
  only its declarations refer to React types. No separate npm package is needed.
- OXC resolves `Code` imports by symbol identity before JSX lowering. Vite
  replaces each element with a `div` containing the prepared HTML, or with
  the JSX component reference supplied as `component`, receiving the existing
  descriptor in its `code` prop. Component references are identifiers or
  JSX member expressions. They are not evaluated during compilation.
- Code is a directly supplied string literal or cooked template literal with
  no interpolations. Options are an object literal with required `language`
  and optional `meta` and `lineNumbers` literals. Dynamic values, identifier or
  file-import evaluation, spreads, computed options and unsupported options
  fail compilation. A call inside a loop is valid when its inputs are inline.
  Cooked values containing unpaired UTF-16 surrogates fail with diagnostics;
  the native UTF-8 contract must not silently alter original source.
- The private `ferriki-macro` Rust crate uses OXC parsing and semantic binding
  resolution. Named marker imports, aliases and lexical shadowing are checked
  by identity. Unrelated functions are left alone. Escaping the real marker
  binding or unsupported import/call forms produces diagnostics.
- The N-API host exposes that analysis through the build-only
  `@ferriki/core/macro-transform` entry. `findInlineCodeMacros` returns validated
  calls and import edits with UTF-8 byte spans. This is a source-transform
  contract, not a token/HAST rendering result. OXC types remain internal.
- Vite applies the edits with source maps and prepares each validated call
  using its existing reusable Ferriki highlighter, asset cache, themes, style
  mode and JavaScript transformer pipeline. Host-specific module IDs, virtual
  CSS imports and HMR remain Vite responsibilities. The existing static HTML
  and JSX adapter remains available.
- The prepared descriptor contains exact original `code`, requested
  `language`, highlighted `html`, applicable `css` and parsed `metadata`
  (title, label, line numbering and selected lines). Surrounding UI belongs to
  the consumer. No public Node token or HAST API is added.
- Unknown languages warn and produce explicitly escaped plain-code output.
  Native failures and missing assets propagate; they are not silently turned
  into successful highlighting. Per-call `lineNumbers` overrides the plugin
  default; explicit `showLineNumbers` metadata also enables numbering.
- Transformed server and client modules contain the same serializable prepared
  data. Hydration and navigation consume that data without native highlighting
  or browser asset downloads. Native-only runtime policy continues to apply
  to actual highlighting ([ADR 0009](0009-native-only-runtime.md)).
- A Markdown/MDX host must expose the imported marker and call before lowering
  or hiding that module. The macro does not intercept a compiler's internal
  fence rendering. Ferromark retains ownership of its fence-equivalent
  standalone rendering and Markdown metadata contract.

## Consequences

- The first integration supports inline examples without compile-time constant
  evaluation, file loaders or a runtime/server preparation service.
- The core macro subpath is safe to import in a browser but is not a browser
  highlighting runtime. Missing integration fails clearly instead of changing
  output between server and client.
- The shared scanner is built into the private N-API host. The published Rust
  highlighter does not acquire OXC dependencies or a macro API.
- CSS delivery, exact source copying, source maps, import identity, hydration,
  navigation and HMR are checked at their respective compiler/consumer
  boundaries. Package tests exercise the real packed core, sidecar and Vite
  packages.
- Prepared HTML carries the same trust boundary as normal Ferriki HTML:
  original source is escaped, while custom transformer output is trusted
  caller code. Components must not pass arbitrary unrelated HTML as prepared
  Ferriki output.

## History

- 2026-10-04: Added the native React `Code` macro with a literal `source` attribute and optional presentation component.

- 2026-10-04: Shortened the unreleased marker export to `code`; no compatibility alias is retained.

- 2026-10-04: Accepted the inline-only macro and shared native analysis boundary (#211).
