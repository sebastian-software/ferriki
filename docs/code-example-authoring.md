# Authoring focused code examples

Ferriki can render focused, highlighted, and diff-style code while the consuming renderer keeps control of the surrounding page. The existing Shiki notation transformers supply the comment syntax; Ferriki does not add another annotation language.

For a component-independent inline example, use the [inline code macro](inline-code-macros.md).
It prepares literal code during the build and retains the original text for
copying; file imports and dynamic data are outside its initial scope.

## Feature ownership

| Consumer           | Verified behavior and remaining gaps                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node               | The published `@ferriki/core@0.9.0` JavaScript `ShikiTransformer` pipeline supports optional upstream notation callbacks for line focus, line and word highlights, and additions/removals. Ferriki supplies the callback pipeline; authors opt into the notation package and choose presentation CSS. There is no new Rust or Node annotation parser.                                                                                                                                                            |
| Vite               | Current `@ferriki/vite` source highlights explicitly marked HTML and static JSX. Its `transformers` option forwards the same callbacks through that Node pipeline. Vite keeps its separate `data-meta` syntax for titles, labels, selected lines, and line numbers. The HTML and JSX paths are covered by source and packed-consumer checks; the matching Vite package release is not yet available.                                                                                                             |
| Rust and Ferromark | The published `ferriki@0.9.0` crate returns escaped, balanced per-line HTML fragments. Published `ferromark@3.0.0` exposes `FerrikiHighlightHooks` through its optional `ferriki` feature, pinned to Ferriki `0.7.0`; its renderer owns Markdown parsing and VitePress-style focus/highlight/diff annotations. A custom Ferromark hook can call Ferriki `0.9.0` as shown in the Rust API guide. Rust does not parse Shiki code-comment notation; word highlighting, copy, and collapse remain renderer concerns. |
| HTML presentation  | The consuming page owns CSS, copy policy, and surrounding markup. Native `<details>` and `<summary>` provide a collapsed supporting example without JavaScript; the example adds a small copy handler for its explicit final-code policy.                                                                                                                                                                                                                                                                        |

## Package availability

Registry state checked on 2026-10-03: `@ferriki/core@0.9.0` and its seven
platform sidecars are available from npm; `@ferriki/vite@0.9.0` is not. The
`ferriki@0.9.0` and `ferromark@3.0.0` crates are available from crates.io.
Ferromark 3.0.0 includes a Ferriki adapter, but it pins Ferriki 0.7.0. The
separate, open [Ferromark PR #502](https://github.com/sebastian-software/ferromark/pull/502)
adds framework-neutral JSX and native Ferriki highlighting plus Node
`compileJsx`/`JsxCompiler` support, targeting Ferromark 3.1; it is not part of
the published 3.0.0 crate. The Vite example below runs against this
repository's source, and the packed consumer check verifies the source package
independently of npm publication.

The Rust boundary is described in [the Rust API guide](rust-api.md). For Vite's JSX input, its compiler must expose JSX before lowering it. The `include(id)` option only adds module IDs; it cannot recover JSX after a compiler has lowered it.

## Reuse the Shiki comment notation

Install the optional transformer package separately, using the version that matches Ferriki's pinned Shiki compatibility baseline:

```sh
npm install -D @shikijs/transformers@4.4.3
```

For direct Node calls, pass these callbacks in `transformers`. For Vite, pass them once in the plugin options; the same callbacks then run on every marked HTML or JSX block:

```js
import {
  transformerNotationDiff,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { ferriki } from "@ferriki/vite";

export default {
  plugins: [
    ferriki({
      themes: { light: "github-light-default", dark: "github-dark-default" },
      styleMode: "classes",
      lineNumbers: true,
      transformers: [
        transformerNotationDiff(),
        transformerNotationFocus(),
        transformerNotationHighlight(),
        transformerNotationWordHighlight(),
      ],
    }),
  ],
};
```

Write annotations in valid comments for the code language. The supported Shiki notation uses `[!code focus]` or `[!code focus:N]`, `[!code highlight]`, `[!code word:term]`, `[!code ++]`, and `[!code --]`. In the verified TypeScript example and HTML/JSX fixtures, matching notation comments are removed, unrelated source and indentation are preserved, and a marker-looking TypeScript string stays code. This reuses Shiki's token/comment-based matcher; it does not claim complete comment parsing for every language. Trailing comments keep the source line in place. A comment-only range directive is removed with its line, so put range directives after a real code line when displayed line numbers must stay aligned.

Vite's `data-meta` syntax remains available for titles, labels, selected lines such as `{2,6-7}`, and `showLineNumbers`. Those values compose with comment notation because the adapter applies them as a separate Ferriki transformer. A line may be both highlighted and focused, or both added and focused.

The notation helpers are JavaScript callbacks and use the shared Ferriki transformer fields. Ferriki does not promise full type interchangeability with Shiki's transformer context (see [ADR 0011](../adr/0011-ferriki-1.0-api-contract.md)). A JavaScript Vite config can pass the helpers directly. In a TypeScript config, keep any type assertion at that config boundary and use these helpers only for the verified shared hooks.

The official [`@shikijs/transformers` guide](https://shiki.style/packages/transformers) documents the notation classes and options. Ferriki's compatibility mirror is pinned in [`node/compat/upstream/shiki/.source.json`](../node/compat/upstream/shiki/.source.json). The behavior here reuses that parser and is verified for the TypeScript, HTML, and JSX examples; comments in other languages follow the upstream matcher's language-specific parsing behavior.

## Style the output and preserve keyboard use

The transformers add classes but no presentation: `has-focused`, `has-highlighted`, `focused`, `highlighted`, `highlighted-word`, `has-diff`, `diff add`, and `diff remove`. Start with the runnable [Vite example](../node/examples/code-authoring/) for light and dark variables, line backgrounds, diff borders, visible focus outlines, a native collapsed section, and a copy action.

The example keeps surrounding context at full text contrast and uses a clear leading border and background to focus the relevant lines. Highlight, focus, and diff styles can appear together: the added line is highlighted and focused. Solid and dashed borders distinguish additions from removals without relying on color alone. Each horizontally scrollable `<pre>` has `tabindex="0"`; its left and right arrow keys scroll the code block. The `<summary>` toggles with Enter or Space, and the copy button uses its native keyboard behavior. The stylesheet makes `:focus-visible` clear.

Ferriki does not install a copy handler. Selecting the rendered diff copies its code text, including removed lines, but not comment annotations or line-number CSS. The example's “Copy final code” button omits `.diff.remove` lines, preserves the remaining rendered text (including whitespace), keeps line order, and joins lines with LF. It reads only the primary `<pre>` and never includes the separate supporting code in `<details>`. If the details section is expanded, a user can select and copy it separately.

## Run and verify the example

The example uses repository workspace packages. `@ferriki/vite@0.9.0` was not
available from npm on 2026-10-03, so use the source path below until a matching
release is published. The `build:compat` step generates the pinned workspace
transformer package used by the example config:

```sh
cd node
pnpm install --ignore-scripts
pnpm run build:native
pnpm run build:compat
pnpm exec vite examples/code-authoring --config examples/code-authoring/vite.config.mjs
```

The configuration imports Shiki's notation helpers from the pinned workspace
mirror. `pnpm run test:vite` checks generated HTML and JSX, CSS selectors,
annotation removal, source preservation, and copy policy. `pnpm run
check:packed-vite` packs the current source packages and exercises a consumer
install with both Vite 7 and Vite 8, including the public TypeScript option.

In a Vite/MDX pipeline, comment transformations run only if the marked block is still available as static HTML or JSX before lowering. Use a compiler mode that exposes that intermediate JSX, then configure `include(id)` only if the exposed module ID needs to be added.

The callback boundary and renderer split are recorded in [ADR 0008](../adr/0008-transformers-and-decorations-stay-in-js.md) and [ADR 0012](../adr/0012-publishable-rust-highlighter.md). See [Ferromark's current Markdown integration](rust-api.md#ferromark-adapter-contract) for the Rust path.
