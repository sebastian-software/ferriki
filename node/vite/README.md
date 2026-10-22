# @ferriki/vite

Add polished code examples right in your React components. During a Vite 8
build, Ferriki turns literal `code()` and `<Code />` macro calls into
highlighted HTML and CSS. React's default `<Code />` presentation uses a small,
framework-free module to display that prepared output in the browser.

## Requirements and install

Use Node.js 22.13.0 or newer and Vite 8. Keep `@ferriki/core`, its optional
platform package, and `@ferriki/vite` on the same Ferriki release. The Node and
platform requirements are the same as [`@ferriki/core`](https://github.com/sebastian-software/ferriki/tree/main/node/ferriki#requirements-and-install).

```sh
npm install @ferriki/core @ferriki/vite
```

The examples below assume a Vite React project. If it does not already have
the React plugin, add it with `npm install -D @vitejs/plugin-react`.
The first build loads the configured language and theme from Ferriki's
release-pinned asset CDN, verifies the payloads, and caches them. For offline
builds, prepopulate the cache or use a mirror; see [asset loading](https://github.com/sebastian-software/ferriki/blob/main/docs/asset-loading.md).

## Configure Vite and React

Put Ferriki before the React plugin so it can prepare the macro before JSX is
lowered:

```js
// vite.config.js
import { ferriki } from "@ferriki/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [ferriki({ theme: "github-dark-default" }), react()],
});
```

## Add a highlighted component

Save this as a component such as `src/Example.tsx` and render it from your
application:

```tsx
import { Code } from "@ferriki/core/react/macro";

export function Example() {
  return (
    <main>
      <h1>A code example, ready for the page</h1>
      <Code language="ts" source={`const answer: number = 42;`} />
    </main>
  );
}
```

Keep `language` and `source` literal in the component. The `source` value can
be a string or template literal without `${...}` interpolation; Ferriki
highlights it during the build and cannot evaluate variables or imported files.
Start your app with its usual command, such as `npm run dev`, and open the page
that renders `Example` to see the prepared block.

## Prepare code with `code()`

For code that you render yourself, use the function macro in a JavaScript or
TypeScript module:

```ts
import { code } from "@ferriki/core/macro";

export const example = code("export const answer = 42;\n", {
  language: "ts",
  meta: 'title="Answer" [TypeScript] {1}',
});
```

The build replaces the call with a plain `PreparedCodeBlock`:

| Field      | Content                                                        |
| ---------- | -------------------------------------------------------------- |
| `code`     | Exact source text, including its final newline                 |
| `language` | Language ID as written in the call                             |
| `html`     | Complete highlighted `pre`/`code` block                        |
| `css`      | Theme, line-number, and highlight rules when needed            |
| `metadata` | Parsed `title`, `label`, `lineNumbers`, and `highlightedLines` |

Render `html` inside a container, not another `pre`. Vite delivers any
generated CSS for the module. The descriptor's `css` field is for code that
moves the descriptor elsewhere; do not inject it a second time.

## Inputs and plugin options

`language` is a required nonempty string literal. `meta` and `lineNumbers`,
when present, are also static. `meta` supports `title="..."`, the first
`[label]`, line selections such as `{2,4-5}`, and `showLineNumbers`.

The `code()` source must be a string literal or a template literal without
`${...}` interpolations. Variables, imported files, computed strings, and
non-object options are not evaluated; an invalid call fails the build with the
file and position. `<Code />` is self-closing and does not accept JSX children,
spreads, or duplicate attributes. Its presentation props `className`, `theme`,
`maxLines`, and `render` can use runtime values where documented below.

| Option         | Default                 | Meaning                                                         |
| -------------- | ----------------------- | --------------------------------------------------------------- |
| `theme`        | `"github-dark-default"` | One theme for every block                                       |
| `themes`       | none                    | Named themes; the first key supplies default colors             |
| `styleMode`    | `"inline"`              | `"classes"` emits scope classes and matching CSS                |
| `lineNumbers`  | `false`                 | Default for each macro; a call can override it                  |
| `transformers` | none                    | Transformer callbacks applied to every prepared block           |
| `assets`       | none                    | Asset source and cache settings, as for `createHighlighter`     |
| `include`      | none                    | `(id) => boolean` for compiler output without a JS/TS extension |

## React presentation and SSR

The default `<Code />` output is a `<ferriki-code>` Web Component with an open
shadow root and local base styles. Shadow DOM keeps page CSS selectors outside
the inner code; React manages the page and host, while the component manages
the token markup. The code remains text that readers can select and copy.

For the first server-rendered page, Ferriki includes the highlighted HTML in a
template. The browser moves it into the shadow root before JavaScript runs, so
the code is visible immediately. React can then attach to the page and outer
element without replacing the code. Later client navigation uses the prepared
HTML in browser modules; it does not run a highlighter.

The macro reserves space from the source line count for client-only mounts.
The optional runtime `maxLines` prop must be a positive safe integer; it caps
the visible height while keeping longer blocks scrollable, and shorter blocks
stay short. Omit it for an unlimited block.

The server template contains its local style element. Inline mode needs no
external CSS asset or Vite base URL. Classes mode adds a link to one aggregated
CSS asset per build output; deploy the SSR build's CSS with its markup because
SSR and client builds can emit different asset names. Direct class-mode macro
SSR requires an absolute Vite base path or URL. The `theme` prop selects the
component's theme; ancestor theme attributes do not cross the shadow boundary.
See the [Shadow code elements guide](https://github.com/sebastian-software/ferriki/blob/main/docs/shadow-code-elements.md#react-ssr-and-declarative-shadow-dom)
for framework-free use, custom CSS, browser support, and CSP/Trusted Types
limits.

Titles, copy buttons, and tabs can wrap the default `<Code />` without replacing
its isolated code presentation. For complete control, pass a `render` function.
It receives `{ code, className, theme, maxLines }` and runs during application
rendering, not compilation:

```tsx
import type { CodeRenderProps } from "@ferriki/core/react/macro";
import { Code } from "@ferriki/core/react/macro";

function CodeBlock({ code, className }: CodeRenderProps) {
  return (
    <figure className={className}>
      <figcaption>{code.metadata.title}</figcaption>
      <button type="button" onClick={() => navigator.clipboard.writeText(code.code)}>
        Copy code
      </button>
      <div dangerouslySetInnerHTML={{ __html: code.html }} />
    </figure>
  );
}

export function Example() {
  return (
    <Code
      language="ts"
      meta='title="Answer" {1}'
      source={`export const answer = 42;`}
      render={(props) => <CodeBlock {...props} />}
    />
  );
}
```

The macro import is removed before the browser build. Server rendering,
hydration, and client navigation all use prepared HTML. The default React path
loads only the framework-free presentation module; `code()` alone has no
presentation runtime. Custom renderers own their regular-page CSS and HTML
insertion. The Web Component is Ferriki's only built-in React presentation.

## Add line annotations

Pass transformer callbacks to highlight or focus selected lines. For example,
the notation helpers from `@shikijs/transformers` work with `transformers`:

```js
// vite.config.js
import { ferriki } from "@ferriki/vite";
import {
  transformerNotationDiff,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    ferriki({
      transformers: [
        transformerNotationHighlight(),
        transformerNotationFocus(),
        transformerNotationDiff(),
        transformerNotationWordHighlight(),
      ],
    }),
  ],
});
```

Write `// [!code highlight]`, `// [!code focus]`, `// [!code ++]`,
`// [!code --]`, or `// [!code word:answer]` inside the macro's source. Ferriki
removes those comments from highlighted HTML while keeping `code` as written.
In a TypeScript config, the helper context may need a type assertion because
Ferriki does not promise transformer contexts are type-interchangeable with
Shiki's.

## Which modules are transformed

The adapter is import-driven. Vite and Rolldown call its transform only for
JavaScript and TypeScript modules (`.js`, `.jsx`, `.ts`, `.tsx`, and their
`.mjs`/`.cjs`/`.mts`/`.cts` forms) whose source contains
`@ferriki/core/macro` or `@ferriki/core/react/macro`. Every other module is
left alone. A passing module is parsed once with Vite's parser; the parse
decides whether it imports a macro. Mentions in comments or strings, and
type-only imports, leave the module unchanged.

Write the import specifier literally. A specifier written with escape
sequences, such as `"@ferriki/core/\\u006dacro"`, does not pass the text check,
so the module is not transformed and the macro marker reports its configuration
error at runtime.

The imported local name `code` or `Code`, including an alias, is reserved in
its module. Declaring that name anywhere in the module, including as a
parameter or in a nested scope, fails the build. A module importing both
macros can alias the function macro:

```tsx
import { code as prepareCode } from "@ferriki/core/macro";
import { Code } from "@ferriki/core/react/macro";
```

Macro errors identify the module, line, column, and source frame. Unknown
languages warn once per module and produce escaped plain code. Missing assets
and native failures fail the build.

## Themes and generated CSS

Inline output carries its colors in the highlighted HTML. With
`styleMode: "classes"`, theme rules live in generated CSS. A `code()` call or
custom React renderer imports a content-addressed stylesheet, while React
shadow roots link the build's aggregated class stylesheet. For ordinary HTML,
set `data-ferriki-theme="dark"` on the prepared block or an ancestor to switch
the selected theme without highlighting again. See [class-based highlighting](https://github.com/sebastian-software/ferriki/blob/main/docs/class-highlighting.md)
for the full HTML/CSS integration.

## MDX and other compilers

The adapter has to see a compiler's output while it still contains the macro's
import and call. Use the compiler's JSX-output mode, run it earlier in Vite's
`pre` plugin tier than Ferriki, and pass `include(id)` for output IDs without a
JavaScript or TypeScript extension. Such a module is parsed as TSX, and the
transform result declares that type so Rolldown lowers its JSX. A compiler
that turns Markdown into JavaScript within a single hook hides the macro from
other plugins. Fenced code blocks in Markdown are handled by the Markdown
pipeline; they are not macros.

The package shares Ferriki's release version and native asset settings. See
the [Vite integration decision](https://github.com/sebastian-software/ferriki/blob/main/adr/0007-adapter-integrations-stay-outside-ferriki.md)
for its product boundary.
