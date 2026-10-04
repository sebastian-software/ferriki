# Authoring focused code examples

Ferriki can render focused, highlighted, and diff-style code while the consuming renderer keeps control of the surrounding page. The existing Shiki notation transformers supply the comment syntax; Ferriki does not add another annotation language.

In Vite, an example is prepared with the [inline code macros](inline-code-macros.md):
`code()` from `@ferriki/core/macro` returns a prepared descriptor, and React's
`<Code />` from `@ferriki/core/react/macro` renders one. Both take literal code
during the build and retain the original text; file imports and dynamic data
are outside their initial scope.

## Feature ownership

| Consumer           | Verified behavior and remaining gaps                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node               | The published `@ferriki/core@0.9.0` JavaScript `ShikiTransformer` pipeline supports optional upstream notation callbacks for line focus, line and word highlights, and additions/removals. Ferriki supplies the callback pipeline; authors opt into the notation package and choose presentation CSS. There is no new Rust or Node annotation parser.                                                                                                                                                            |
| Vite               | Current `@ferriki/vite` source prepares `code()` calls and React `<Code />` elements on Vite 8. Its `transformers` option forwards the same callbacks through that Node pipeline to every prepared block. The macros' `meta` option keeps the adapter's syntax for titles, labels, selected lines, and line numbers. The macro paths are covered by source and packed-consumer checks; the matching Vite package release is not yet available.                                                                  |
| Rust and Ferromark | The published `ferriki@0.9.0` crate returns escaped, balanced per-line HTML fragments. Published `ferromark@3.0.0` exposes `FerrikiHighlightHooks` through its optional `ferriki` feature, pinned to Ferriki `0.7.0`; its renderer owns Markdown parsing and VitePress-style focus/highlight/diff annotations. A custom Ferromark hook can call Ferriki `0.9.0` as shown in the Rust API guide. Rust does not parse Shiki code-comment notation; word highlighting, copy, and collapse remain renderer concerns. |
| HTML presentation  | The consuming component owns CSS, copy policy, and surrounding markup. Native `<details>` and `<summary>` provide a collapsed supporting example without JavaScript; a copy action decides whether it copies the authored source or the final code.                                                                                                                                                                                                                                                             |

## Package availability

Registry state checked on 2026-10-03: `@ferriki/core@0.9.0` and its seven
platform sidecars are available from npm; `@ferriki/vite@0.9.0` is not. The
`ferriki@0.9.0` and `ferromark@3.0.0` crates are available from crates.io.
Ferromark 3.0.0 includes a Ferriki adapter, but it pins Ferriki 0.7.0. The
separate, open [Ferromark PR #502](https://github.com/sebastian-software/ferromark/pull/502)
adds framework-neutral JSX and native Ferriki highlighting plus Node
`compileJsx`/`JsxCompiler` support, targeting Ferromark 3.1; it is not part of
the published 3.0.0 crate. The macros run against this repository's source,
and the packed consumer checks verify the source packages independently of npm
publication.

The Rust boundary is described in [the Rust API guide](rust-api.md). For Vite, a compiler must expose the macro import and call before lowering its output. The `include(id)` option only adds module IDs; it cannot recover a call after a compiler has lowered it.

## Reuse the Shiki comment notation

Install the optional transformer package separately, using the version that matches Ferriki's pinned Shiki compatibility baseline:

```sh
npm install -D @shikijs/transformers@4.4.3
```

For direct Node calls, pass these callbacks in `transformers`. For Vite, pass them once in the plugin options; the same callbacks then run on every prepared `code()` call and `<Code />` element:

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

Write annotations in valid comments for the code language, inside the macro's literal source:

```ts
import { code } from "@ferriki/core/macro";

export const parser = code(
  `function parseResponse(raw: string) {
  const parsed = JSON.parse(raw); // [!code highlight] [!code focus:4] [!code word:parsed]
  if (typeof parsed.value !== "string") {
    throw new TypeError("Expected a string"); // [!code --]
    return String(parsed.value).trim(); // [!code ++]
  }
  const marker = "// [!code focus]";
  return parsed.value + marker;
}`,
  { language: "ts", meta: 'title="Response parser" [TypeScript] {2,5-6}' },
);
```

The supported Shiki notation uses `[!code focus]` or `[!code focus:N]`, `[!code highlight]`, `[!code word:term]`, `[!code ++]`, and `[!code --]`. In the verified macro fixtures, matching notation comments are removed from the highlighted HTML, unrelated source and indentation are preserved, and a marker-looking TypeScript string stays code. This reuses Shiki's token/comment-based matcher; it does not claim complete comment parsing for every language. Trailing comments keep the source line in place. A comment-only range directive is removed with its line, so put range directives after a real code line when displayed line numbers must stay aligned.

The macros' `meta` option keeps titles, labels, selected lines such as `{2,6-7}`, and `showLineNumbers`. Those values compose with comment notation because the adapter applies them as a separate Ferriki transformer. A line may be both highlighted and focused, or both added and focused.

The notation helpers are JavaScript callbacks and use the shared Ferriki transformer fields. Ferriki does not promise full type interchangeability with Shiki's transformer context (see [ADR 0011](../adr/0011-ferriki-1.0-api-contract.md)). A JavaScript Vite config can pass the helpers directly. In a TypeScript config, keep any type assertion at that config boundary and use these helpers only for the verified shared hooks.

The official [`@shikijs/transformers` guide](https://shiki.style/packages/transformers) documents the notation classes and options. Ferriki's compatibility mirror is pinned in [`node/compat/upstream/shiki/.source.json`](../node/compat/upstream/shiki/.source.json). The behavior here reuses that parser and is verified for TypeScript macro examples; comments in other languages follow the upstream matcher's language-specific parsing behavior.

## Style the output and preserve keyboard use

The transformers add classes but no presentation: `has-focused`, `has-highlighted`, `focused`, `highlighted`, `highlighted-word`, `has-diff`, `diff add`, and `diff remove`. The adapter's own `meta` selection adds `ferriki-highlight-line` and `highlighted`, and the prepared CSS styles those two classes and the line numbers. Everything else is the consumer's stylesheet, for example:

```css
.code-example .line.focused {
  border-inline-start: 0.2rem solid var(--example-focus);
}
.code-example .line.diff.add {
  border-inline-start: 0.25rem solid var(--example-add);
}
.code-example .line.diff.remove {
  border-inline-start: 0.25rem dashed var(--example-remove);
}
.code-example pre:focus-visible {
  outline: 0.2rem solid var(--example-focus);
}
```

Keep surrounding context at full text contrast and use a clear leading border and background to focus the relevant lines. Highlight, focus, and diff styles can appear together. Solid and dashed borders distinguish additions from removals without relying on color alone. Highlighted output gives each `<pre>` `tabindex="0"`, so a horizontally scrollable block is reachable from the keyboard; make `:focus-visible` clear. A `<summary>` toggles with Enter or Space, and a copy button uses its native keyboard behavior.

Ferriki does not install a copy handler. The descriptor's `code` is the exact authored source, including notation comments and removed lines. A "Copy final code" action that should omit them reads the rendered lines instead: keep every `.line` element without the `remove` class, take its text content (including whitespace) in order, and join the lines with LF. Selecting the rendered diff copies its code text, including removed lines, but not comment annotations or line-number CSS.

## Verify the behavior

`@ferriki/vite@0.9.0` was not available from npm on 2026-10-03, so the checks
below run against this repository's source. The `build:compat` step generates
the pinned workspace transformer package that the tests load:

```sh
cd node
pnpm install --ignore-scripts
pnpm run build:native
pnpm run build:compat
pnpm run test:vite
pnpm run check:packed-vite
```

`pnpm run test:vite` checks prepared macro output with the notation callbacks,
annotation removal, source preservation, metadata classes and CSS. `pnpm run
check:packed-vite` packs the current source packages and exercises a consumer
install with Vite 8.0.0 and the current Vite 8 release, including the public
TypeScript options.

In a Vite/MDX pipeline, a macro is prepared only if its import and call are still visible to the plugin before the compiler lowers the module. Use a compiler mode that exposes that intermediate output, then configure `include(id)` only if the exposed module ID needs to be added.

The callback boundary and renderer split are recorded in [ADR 0008](../adr/0008-transformers-and-decorations-stay-in-js.md) and [ADR 0012](../adr/0012-publishable-rust-highlighter.md). See [Ferromark's current Markdown integration](rust-api.md#ferromark-adapter-contract) for the Rust path.
