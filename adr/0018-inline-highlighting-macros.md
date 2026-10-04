# ADR 0018: Prepare Inline Highlighting Macros at Build Time

## Status

Accepted

Last updated: 2026-10-04

## Context

Authored code examples do not always use intrinsic `pre`/`code` markup. A
component may accept a prepared example and own its toolbar, copy action or
tabs. Marked static `pre` markup, which the first version of the optional Vite
adapter highlighted, cannot identify that component-independent boundary.
Issue #211 narrows the initial requirement to inline content, following
Palamedes' explicitly imported macro model.

The public Node output direction remains HTML and CSS ([ADR 0017](0017-node-html-output-priority.md)).
Macro processing must not introduce a browser highlighter or execute arbitrary
application JavaScript during a transform.

Issue #216 assessed what macro recognition costs consumers that do not use it.
The first implementation compiled an OXC parser with semantic analysis into
the N-API addon, which every Node highlighting consumer installs, and the Vite
adapter parsed most application modules with Babel whether or not they used a
macro. Vite 8's bundler, Rolldown, already ships OXC: Vite's `parseAst` returns
an ESTree with UTF-16 offsets for TypeScript and JSX. Vite 7's `parseAst` is
Rollup's and does not parse TypeScript. No Vite or Rolldown hook shares the
bundler's own parse with a plugin: a `transform` hook receives a string and
cannot return an AST, `meta.ast` is a lazy `parseAst` of that string, the OXC
transformer accepts no user plugins, and third-party Rust plugins cannot be
loaded.

Palamedes' Vite plugin gates on its macro package names before parsing and
then parses once in its own native addon, the same parse count as here. That
addon is build tooling only, and Palamedes shares its macro semantics with
extraction and lint, so owning the parser is right there. Ferriki's addon is
the runtime highlighter for server rendering and other Node callers, and a
Ferriki macro ends at a literal handed to that highlighter, so borrowing the
host's parser is right here.

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
- `Code` imports are resolved by their reserved name before JSX lowering. Vite
  replaces each element with a `div` containing the prepared HTML. Optional
  `className` applies to that outer container and accepts a string or runtime
  expression. An optional runtime `render` function instead receives
  `{ code: PreparedCodeBlock, className?: string }`; consumers explicitly
  forward props in ordinary JSX. It accepts no JSX-element shorthand. An absent
  or `undefined` renderer retains the default output, while a callback
  returning `null` or `undefined` retains its result. Presentation expressions
  are evaluated once in authored attribute order when the JSX element is created,
  never during compilation. A stable generated module-local React component
  defers callback invocation until React renders that element. The unreleased
  `component` prop is replaced without an alias.
- Code is a directly supplied string literal or cooked template literal with
  no interpolations. Options are an object literal with required `language`
  and optional `meta` and `lineNumbers` literals. Dynamic values, identifier or
  file-import evaluation, spreads, computed options and unsupported options
  fail compilation. A call inside a loop is valid when its inputs are inline.
  Cooked values containing unpaired UTF-16 surrogates fail with diagnostics;
  the native UTF-8 contract must not silently alter original source.
- `@ferriki/vite` requires Vite 8 (peer `vite: ^8.0.0`) and recognizes macros
  on the ESTree that Vite's own parser produces (`parseAst` from `vite`, which
  is Rolldown's OXC). Its dependencies are `@ferriki/core` and `magic-string`;
  it uses no Babel, HTML parser or HAST utilities. The host's parser is the
  only JavaScript parser in Ferriki's Node build path.
- The adapter is import-driven. Its `transform` is an object hook with a host
  filter: `id` accepts JavaScript and TypeScript module IDs, and `code`
  requires the text `@ferriki/core/macro` or `@ferriki/core/react/macro`. A
  function `include(id)` cannot be a host filter; with one, the filter keeps
  only `code`, and the handler accepts script IDs and the IDs the predicate
  accepts. Rolldown evaluates the filter natively in builds, and Vite's dev
  plugin container evaluates it before calling the hook, so a module without a
  macro specifier is never parsed or touched. A candidate module is parsed
  once.
- The textual filter is a performance filter, never evidence: the parse
  decides. A mention in a comment or string, or a type-only import, leaves the
  module unchanged. A specifier spelled with escape sequences does not pass the
  filter; that module is not transformed, and its marker throws the
  configuration error at runtime.
- Named marker imports and aliases are recognized from the module's import
  declarations. The imported local name (`code`, `Code` or an alias) is
  reserved in its module: a declaration with that name in any scope fails
  compilation, whether it is a variable, function, class, parameter,
  destructured binding, catch binding, import, or TypeScript type alias,
  interface, enum, enum member or namespace. Type annotations are erased
  before runtime and are not checked, so a type parameter or a parameter of a
  function type may still use the name. The parser reports no redeclaration,
  and TypeScript reports only a same-scope conflict (TS2440), so the adapter
  enforces the rule itself. With the name reserved, every runtime reference to
  it is the marker, and no scope analysis is needed. Escaping the marker
  binding, by any use other than a direct call or self-closing element, and
  unsupported import/call forms produce diagnostics.
- Diagnostics use Vite's plugin error channel (`this.error`): a
  `FerrikiMacroError` with the code `FERRIKI_MACRO` (Rolldown builds expose it
  as `pluginCode`), the module `id`, a `loc` with a 1-based line and a 0-based
  column derived from the tree offset, and a code frame. A syntax error in a
  candidate module is reported with the parser's own position.
- `@ferriki/core` exposes no macro analysis. The native scanner and its
  build-only `@ferriki/core/macro-transform` entry (`findInlineCodeMacros`)
  were removed without a compatibility alias (#216). Measured for linux-x64 at
  0.11.0 on 2026-10-04, the scanner made up 29.5% of the addon (3,938,096 bytes
  with it, 2,775,072 bytes without), which every highlighting consumer
  installs. The addon exports `FerrikiHighlighter`, `createHighlighter` and
  `ferrikiVersion`. The `check:boundary` script
  ([`check-native-boundary.mjs`](../node/scripts/check-native-boundary.mjs))
  fails if an OXC crate enters the dependency tree of the addon or of the
  published `ferriki` crate.
- The adapter applies its edits with `magic-string` in the tree's UTF-16
  offsets, the offset model of its source map, and a module it leaves
  unchanged returns `null` without a source map. Palamedes follows the same
  two patterns with UTF-8 offsets and `string_wizard`. Macro value imports are
  removed, unused ones included; type-only specifiers stay. A descriptor at the
  start of a statement or a concise arrow body is parenthesized. When the
  adapter emits JSX into a module whose ID has no JSX extension, the transform
  result declares `moduleType` `jsx` or `tsx`, so Rolldown lowers that JSX in
  builds; in dev, Vite's OXC plugin selects modules by ID (`oxc.include`), not
  by module type.
- The adapter prepares each validated call using its reusable Ferriki
  highlighter, asset cache, themes, style mode and JavaScript transformer
  pipeline. Host-specific module IDs, virtual CSS imports and HMR remain Vite
  responsibilities.
- `code()` and `<Code />` are the adapter's only entry points. The two
  marked-block paths were removed (#216): `data-highlight="auto"` blocks in
  Vite's `index.html` (`transformIndexHtml`) and static intrinsic
  `<pre data-highlight="auto">` elements in `.jsx`/`.tsx` modules. Neither had
  an import to gate on, and they were the only paths that needed an HTML parser
  or generated JSX from highlighted output.
- One adapter parse per macro-bearing module, plus the host's own passes (JSX
  lowering, and Rolldown's module parse in builds), is the accepted floor for
  an inline macro; lowering JSX inside the adapter would parse just as often.
  Measured on 2026-10-04 with Vite 8.3.2, `parseAst` took about 11.5 ms on a
  46 KB JavaScript module with JSX, against about 7.5 ms for Rolldown's own
  TypeScript and JSX lowering with a source map. Most of the adapter's cost is
  materializing the ESTree as JavaScript objects, not the parse itself. The
  adapter therefore adds roughly one and a half JSX-lowering passes per
  macro-bearing module, once per change in development and once per build.
- The prepared descriptor contains exact original `code`, requested
  `language`, highlighted `html`, applicable `css` and parsed `metadata`
  (title, label, line numbering and selected lines). Surrounding UI belongs to
  the consumer. The adapter passes Ferriki's HTML string through without a
  HAST round trip. No public Node token or HAST API is added.
- Unknown languages warn and produce explicitly escaped plain-code output.
  Native failures and missing assets propagate; they are not silently turned
  into successful highlighting. Per-call `lineNumbers` overrides the plugin
  default; explicit `showLineNumbers` metadata also enables numbering.
- Transformed server and client modules contain the same serializable prepared
  data. Hydration and navigation consume that data without native highlighting
  or browser asset downloads. Native-only runtime policy continues to apply
  to actual highlighting ([ADR 0009](0009-native-only-runtime.md)).
- A Markdown/MDX host must expose the imported marker and call before lowering
  or hiding that module. `include(id)` adds such an exposed module ID; an
  included ID without a script extension is parsed as TSX. The macro does not
  intercept a compiler's internal fence rendering. Ferromark retains ownership
  of its fence-equivalent standalone rendering and Markdown metadata contract.

## Considered options

- **A Cargo feature with two addon flavors**: keeps the scanner out of the
  highlighting addon but doubles the seven-package sidecar matrix, against the
  reasoning of [ADR 0013](0013-cdn-loaded-standard-assets.md), which rejects
  multiplying the release matrix to slim the installation.
- **A WASM scanner inside `@ferriki/vite`**: keeps a parallel OXC copy beside
  Rolldown's and adds a second toolchain.
- **A file import resolved and loaded by the plugin**
  (`import example from "./sample.ts?ferriki"`): the only design with no
  adapter-side parse. It was set aside in favor of inline literals (#211) and
  stays on record as the alternative if the parse cost ever matters.

## Consequences

- The first integration supports inline examples without compile-time constant
  evaluation, file loaders or a runtime/server preparation service.
- The core macro subpath is safe to import in a browser but is not a browser
  highlighting runtime. Missing integration fails clearly instead of changing
  output between server and client.
- Macro recognition is not built into the N-API host. Neither the addon nor
  the published Rust highlighter acquires JavaScript parser dependencies or a
  macro API. The release summary lists the size of every sidecar's
  `ferriki.node`, so addon growth is visible in each release.
- A module that does not spell out a macro specifier costs only the host's
  filter check, in development and in builds; the adapter never sees it.
- `@ferriki/vite` does not support Vite 7. Another build host needs its own
  adapter that prepares HTML through the supported highlighter, preserves
  source maps and delivers the same prepared data and CSS on server and client.
- Projects that used the marked HTML or static intrinsic JSX blocks move their
  examples to `code()` or `<Code />`; no compatibility path remains.
- A module that imports a macro cannot reuse its name. A React module that
  imports `code()` cannot destructure `({ code })` in a renderer; it renames
  that binding or imports the macro as `code as prepareCode`.
- A macro specifier spelled with escapes is reported at runtime by the marker,
  not at build time.
- CSS delivery, exact source copying, source maps, import identity, hydration,
  navigation and HMR are checked at their respective compiler/consumer
  boundaries. Package tests exercise the real packed core, sidecar and Vite
  packages; the packed consumer check runs against Vite 8.0.0 and the current
  Vite 8 release.
- Prepared HTML carries the same trust boundary as normal Ferriki HTML:
  original source is escaped, while custom transformer output is trusted
  caller code. Components must not pass arbitrary unrelated HTML as prepared
  Ferriki output.

## History

- 2026-10-04: `@ferriki/vite` requires Vite 8, transforms only modules that import a macro and parses them once with Vite's parser; the imported macro name is reserved in its module instead of yielding to lexical shadowing; diagnostics use Vite's plugin error channel; the marked HTML and static intrinsic JSX paths are removed (#216).

- 2026-10-04: Records the accepted parse floor, the file-import alternative and the rejected addon flavor and WASM scanner options (#216).

- 2026-10-04: Removed the native OXC scanner and the `@ferriki/core/macro-transform` entry; `@ferriki/vite` recognizes macros over the host parser's ESTree (#216).

- 2026-10-04: Replaced the unreleased React `component` prop with an explicit runtime `render` function and added `className` for the default container or renderer.

- 2026-10-04: Added the native React `Code` macro with a literal `source` attribute and optional presentation component.

- 2026-10-04: Shortened the unreleased marker export to `code`; no compatibility alias is retained.

- 2026-10-04: Accepted the inline-only macro and shared native analysis boundary (#211).
