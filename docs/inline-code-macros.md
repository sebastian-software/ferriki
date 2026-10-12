# Inline code macros

Use `code` when a component accepts a prepared code example instead of
authored `pre`/`code` markup. Ferriki prepares HTML and CSS during the build;
your component owns the title, copy button, tabs and other presentation.

The macro markers ship in `@ferriki/core`; `@ferriki/vite` prepares them
during the build. Core, the native platform sidecar and `@ferriki/vite` must
have matching versions.

## Configure Vite

`@ferriki/vite` requires Vite 8. Install the core and Vite packages:

```sh
npm install @ferriki/core @ferriki/vite
```

Place Ferriki before a framework plugin that lowers JSX:

```ts
import { defineConfig } from "vite";
import { ferriki } from "@ferriki/vite";

export default defineConfig({
  plugins: [
    ferriki({
      themes: { light: "github-light-default", dark: "github-dark-default" },
      styleMode: "classes",
      lineNumbers: true,
    }),
    // Add your framework plugin here.
  ],
});
```

The plugin transforms only modules that import a macro: see
[which modules are transformed](#which-modules-are-transformed). No React
dependency or browser highlighter is added by Ferriki.

## Prepare an inline example

The following TSX uses a custom React component. The macro also works in plain
JavaScript/TypeScript expressions; React is only this example's consumer.

```tsx
import { code } from "@ferriki/core/macro";
import type { PreparedCodeBlock } from "@ferriki/core/macro";

const example = code("export const answer = 42;\n", {
  language: "ts",
  meta: 'title="Answer" [TypeScript] {1}',
});

function CodeBlock({ block }: { block: PreparedCodeBlock }) {
  return (
    <figure>
      <figcaption>{block.metadata.title}</figcaption>
      <button type="button" onClick={() => navigator.clipboard.writeText(block.code)}>
        Copy code
      </button>
      <div dangerouslySetInnerHTML={{ __html: block.html }} />
    </figure>
  );
}

export function Example() {
  return <CodeBlock block={example} />;
}
```

The component's prop is named `block` because `code` is the imported macro in
this module, and that name is [reserved](#which-modules-are-transformed).
The original string, including its final newline, is retained in `block.code`.
The HTML contains the complete highlighted `pre`/`code` block. Render that HTML
inside a container rather than nesting it in another `pre`. Ferriki escapes
original source text. Custom transformer output is trusted caller code, as in
the normal HTML API; do not treat arbitrary HTML as a prepared Ferriki result.

The Vite plugin delivers generated CSS for `code()` and custom renderers as
usual. The descriptor's `css` carries its generated CSS for consumers that move
the prepared descriptor outside that module's delivery; do not inject a second
copy when Vite already delivers it. Select a configured class-output theme with
`data-ferriki-theme="dark"` on the code block or an ancestor. Surrounding UI
and custom transformer presentation styles remain your responsibility.

## React JSX macro

In React, use the optional `Code` marker to keep an example in JSX. The import
is `@ferriki/core/react/macro`, shipped in the same core package. Configure
`ferriki()` before the React plugin as shown above. Your React project supplies
React and its normal TypeScript declarations; Ferriki's marker imports no
React runtime or native highlighter.

```tsx
import { Code } from "@ferriki/core/react/macro";

export function Example() {
  return (
    <Code
      language="tsx"
      className="example-code"
      lineNumbers
      source={`function Hello() {
  return <h1>Hello</h1>;
}`}
    />
  );
}
```

The element must be self-closing. `source` is a direct string literal or cooked
template literal without interpolations. JSX text and `children` are not
supported. `language` is required; it and `meta` accept JSX string attributes
or direct string/template expressions without interpolation. Metadata and
line-number defaults match `code()`. `lineNumbers` accepts a boolean literal;
without a value it means `true`. Spreads, duplicate and unsupported attributes
fail compilation.
Dynamic source and highlighting options fail with a filename/position error.
Quoted JSX attributes use JSX character-reference decoding: `source="x &amp; y"`
means `x & y`. Expression literals such as `source={"x &amp; y"}` retain the
literal entity spelling. Templates preserve the authored formatting and use
normal JavaScript escape semantics.

By default, the transform emits a `<ferriki-code>` Web Component. In React SSR,
its host contains Declarative Shadow DOM with the complete prepared `pre`/`code`
HTML and a small local style block for base presentation. Classes mode adds a
link to its aggregated CSS asset. The browser parser creates the open shadow
root before custom-element upgrade; the component reuses it and keeps its token
nodes through hydration. In the browser render, React receives an empty host
with a stable content reference and the module registers prepared HTML and, in
classes mode, the CSS asset URL for hydration and later client-rendered
navigation. `className` applies to the host; page selectors such as `.example
pre` cannot reach inside the root. `theme` selects a configured alias. These
presentation props accept ordinary runtime expressions:

```tsx
<Code
  className={compact ? "example compact" : "example"}
  theme={darkMode ? "dark" : "light"}
  maxLines={12}
  language="ts"
  source={`const answer = 42;`}
/>
```

`maxLines` is a runtime presentation prop. It must be a positive safe integer
when supplied; omit it or pass `undefined` for an unlimited block. Longer blocks
keep all highlighted code and scroll vertically, while blocks shorter than the
cap remain short. The default host applies the matching no-JavaScript height
reservation automatically. Manual hosts can use
`codeElementSizing(lineCount, maxLines)` with the `max-lines` attribute; see the
[sizing guide](shadow-code-elements.md#client-rendering-with-reserved-space).

The macro uses `import.meta.env.SSR` to select the server or browser output, so
local `window` or `globalThis` bindings cannot change the branch. The server
branch puts the prepared HTML in a server-only `dangerouslySetInnerHTML` value
on the custom-element host; React serializes it as DSD with a matching reference
marker. This is the default SSR path and needs no post-render rewrite. The
browser branch registers the module's prepared content and theme aliases for
client-created hosts. Classes mode also registers the stylesheet URL. Both
paths use the build-known source line count and optional `maxLines` cap for the
host reservation. Each root has a local base-style element, and classes mode
keeps its external CSS link after upgrade. After parser creation, upgrade and
hydration retain the server nodes; later theme and parent updates retain them
too. Source/HMR updates use a new reference inside the existing root. The
complete-HTML `plugin.api.renderCodeElements()` and
`renderCodeElementShadows()` helpers remain available for manually authored
reference hosts. See the [lifecycle diagram](shadow-code-elements.md#react-ssr-and-declarative-shadow-dom)
and [ownership diagram](shadow-code-elements.md#dom-and-module-ownership), plus
the sections on saved production registries, direct property use, stylesheet
delivery, and the complete-HTML SSR boundary.

Inline mode needs no external CSS asset or Vite `base` restriction. In classes
mode, Vite serves the aggregated CSS during development at
`${base}@ferriki/code-elements.css` and emits a hashed
`assets/ferriki-code-*.css` file in production. Deploy the asset emitted by the
SSR build with the application's public assets; SSR and client build graphs can
produce different hashes. Direct class-mode macro SSR requires an absolute path
or URL base because relative URLs are ambiguous on nested routes. See the
[Vite guide](../node/vite/README.md) for deployment details.

Titles, copy buttons, and tabs can wrap the default `<Code />` in ordinary React
components while its code remains isolated. For complete control over the
rendered result, provide a `render` function. This application-owned escape hatch
replaces the default presentation; the example below opts into light-DOM HTML
and its page CSS. It receives
`{ code: PreparedCodeBlock, className?: string, theme?: string, maxLines?: number }`.
You explicitly decide which
props to pass to your components:

```tsx
import { Code } from "@ferriki/core/react/macro";
import type { CodeRenderProps } from "@ferriki/core/react/macro";

function MyCodeBlock({ code, className }: CodeRenderProps) {
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
      className="example-code"
      language="ts"
      meta='title="Answer" {1}'
      source={`export const answer = 42;`}
      render={(props) => <MyCodeBlock {...props} />}
    />
  );
}
```

Destructuring is equally valid:
`render={({ code, className, maxLines }) => <MyCodeBlock code={code} className={className} maxLines={maxLines} />}`.
The renderer can pass its own props, capture local values, return a fragment
or `null`, or be a named function. It runs during normal application rendering;
Ferriki never evaluates it at build time. A stable module-local React component
invokes it when React renders the element, including JSX stored at module scope.
Render ordinary React components through JSX inside the callback. There is no
implicit prop insertion or extra container around its result. `className` is included in the renderer's props
only when supplied on `Code`; `theme` and `maxLines` follow the same rule. The callback controls where to apply them.
An omitted renderer, or one that evaluates to `undefined`, uses the default
`<ferriki-code>` host. A renderer returning `null` or `undefined` keeps that result.
`render` accepts functions, not JSX elements.

Import aliases with JSX component names such as `Code as HighlightedCode` work.
The imported name is reserved in its module, so a component, parameter or other
declaration with that name fails compilation. Using the imported marker as a
function, passing it elsewhere or re-exporting it is rejected. An unprocessed
marker throws an actionable integration error.

Server rendering, hydration, navigation and HMR use the same prepared HTML.
The `code()` descriptor and custom renderers retain their existing CSS data and
delivery. Default React output loads `@ferriki/core/web-component` for presentation;
`code()` alone adds no presentation runtime. Macro markers, native highlighting,
asset transport, and the build-time parser stay out of browser bundles.
Default React roots each contain their small base-style element; classes mode
uses one aggregated external asset linked from each root. `code()` and custom
renderers keep their ordinary Vite CSS delivery. Custom transformer rules for
the default component can be added as manual local CSS through
`defineCodeElement({ css, themeAliases })` with the configured aliases (`[]`
for a single theme); there is no separate override CSS source option.
A custom renderer can instead keep ordinary HTML and its page stylesheet.

## Supported function inputs

Code must appear directly in the call as a string literal or a template literal
without `${...}` interpolations. Template content uses JavaScript's cooked
string value, so escapes have their normal JavaScript meaning. Constant
bindings, raw-file imports, variables and computed strings are not evaluated.
Cooked strings must contain valid Unicode; unpaired UTF-16 surrogates are
rejected instead of changing the original source.

Options must be an object literal with these supported keys:

| Option        | Meaning                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `language`    | Required nonempty string literal, such as `"ts"`.                                                                               |
| `meta`        | Optional string literal. Uses the adapter's existing `title="..."`, `[label]`, `{2,4-5}` and `showLineNumbers` metadata syntax. |
| `lineNumbers` | Optional boolean literal overriding the plugin default. Explicit `showLineNumbers` metadata also enables numbering.             |

Themes, style mode, assets and transformer callbacks are configured on the
plugin. Dynamic options, spreads, computed keys, duplicate keys and unsupported
keys produce a filename/position diagnostic. Calls inside loops are allowed
when their inputs remain inline literals; `code(sample.content, ...)`
is outside this contract.

Named import aliases work. The macro must be called directly: assigning it to
another variable, re-exporting it or using unsupported import/call forms is
rejected instead of leaving an accidental runtime macro invocation.
Type-only imports and re-exports remain valid; they carry no runtime marker.

## Which modules are transformed

The plugin's transform declares a host filter. Vite and Rolldown call it only
for JavaScript and TypeScript modules, plus IDs accepted by `include(id)`,
whose source contains the exact text `@ferriki/core/macro` or
`@ferriki/core/react/macro`. A module without that text is never parsed. A
module with it is parsed once by Vite's own parser, and the parse decides: a
mention in a comment or string, or a type-only import, leaves the module
unchanged.

Write the module specifier literally. A specifier spelled with escape
sequences, such as `"@ferriki/core/\u006dacro"`, does not pass the text check,
so that module is not transformed and the marker throws its configuration
error at runtime.

The local name that a macro import binds, `code`, `Code` or an alias, is
reserved in its module. Any declaration with that name fails compilation: a
variable, function, class, parameter, destructured binding, catch binding,
import, or TypeScript type alias, interface, enum or namespace, at the top
level or in a nested scope. TypeScript only reports a conflict in the same
scope, so the plugin checks this itself; with the name reserved, every runtime
use of it refers to the macro. Type annotations are erased before runtime and
are not checked, so a type parameter or a parameter name inside a function type
may still use the name. A React module that imports
both macros and destructures `({ code })` in a renderer imports the function
macro under another name, such as `import { code as prepareCode }`.

## Errors and application delivery

Calling the marker without a transform throws a clear configuration error.
Enable the Ferriki integration and ensure that the module reaches its transform.

Compile errors are reported through Vite's plugin error channel as a
`FerrikiMacroError` with the code `FERRIKI_MACRO` (Rolldown builds report that
code as `pluginCode`), the module `id`, a `loc` with line and column, and a
code frame that the dev server overlay and the build output show. Syntax
errors in a module that imports a macro are reported with the parser's own
position.

Unknown languages emit a warning and produce escaped plain-code output. Missing
assets and native failures propagate; they are not successful highlighting.

The same prepared descriptor is emitted into server and browser modules. A
hydrated component and subsequent navigation consume that data without a native
binding or asset downloader in the browser. A server-only HTML rewrite does not
implement this contract. Inline source and its highlighted representation are
included in application assets; use this path for examples intended to be shown.

For MDX, expose the imported marker and call to the plugin before the compiler
hides or lowers that module. `include(id)` can add an exposed module ID; it
cannot reveal a compiler's internal rendering. An included ID without a
JavaScript or TypeScript extension is parsed as TSX; when the plugin emits JSX
into it, the transform result declares the `tsx` module type so that Rolldown
lowers that JSX in builds. Ordinary Markdown fences stay on their existing
Ferromark compiler path.

## Other build hosts

Macro recognition is part of `@ferriki/vite`; `@ferriki/core` ships the markers
and no macro scanner or build-time transform entry. Custom adapters must prepare
HTML through the supported highlighter, preserve source maps and deliver the
same prepared data and CSS on server and client. See [ADR
0018](../adr/0018-inline-highlighting-macros.md) for ownership and the
inline-only boundary.

## Repository checks

After the repository's normal native setup, run from `node/`:

```sh
pnpm run test:vite
pnpm run test:web-component
pnpm run check:packed-vite
pnpm dlx playwright@1.63.0 install --with-deps chromium
pnpm run check:inline-macro
```

The focused browser check uses the real packed core, sidecar and Vite packages.
It covers server rendering and hydration, navigation, exact source copying,
theme/CSS delivery, HMR and the browser module boundary. The portable packed
consumer check runs both macros, their diagnostics and a production build
against Vite 8.0.0 and the current Vite 8 release. The [Shadow DOM consumer
check](../node/examples/shadow-dom/README.md) covers the reference component,
highlighted no-JavaScript DSD, direct property mode, registration, shared styles, node preservation, themes, updates,
and imperative use in Chromium, Firefox, and WebKit.

## Rendering HTML in React

`codeToHtml()` returns an HTML string; `code()` prepares a descriptor with
that string in its `html` field. React escapes a string in `{html}`, so it
displays the tags as text. Use `dangerouslySetInnerHTML` to
insert the prepared markup in ordinary HTML. `<Code />` uses a
`<ferriki-code code-ref="…">` host: its SSR branch emits prepared markup as
Declarative Shadow DOM through a server-only HTML sink, while its browser branch
registers HTML for empty reference hosts. The optional server helper fills
manually authored reference hosts outside React. Direct
`<ferriki-code highlightedCode={html} />` remains supported. These paths keep
the finished HTML intact without converting its tokens into React elements.

Literal HTML cannot simply be pasted into JSX: attributes such as `class`
and `style` have different representations, and escaped source text must be
preserved. The current adapter keeps Ferriki's HTML intact instead of converting each
highlighted span into a React element. The shadow root contains real, selectable `pre`, `code` and `span` elements.

Ferriki escapes the original source. Custom transformers control their own
markup; only insert HTML from your highlighting pipeline.

The direct JSX experiment from [issue #221](https://github.com/sebastian-software/ferriki/issues/221)
was removed in favor of the isolated HTML presentation described in
[ADR 0019](../adr/0019-shadow-dom-code-elements.md).
