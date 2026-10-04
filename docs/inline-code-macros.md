# Inline code macros

Use `code` when a component accepts a prepared code example instead of
authored `pre`/`code` markup. Ferriki prepares HTML and CSS during the build;
your component owns the title, copy button, tabs and other presentation.

This feature is new repository source for issue #211. Use the local packed
consumer checks until a release containing the macro subpaths is published;
installing an earlier `@ferriki/core` release does not provide these exports.
Core, the native platform sidecar and `@ferriki/vite` must have matching versions.

## Configure Vite

Install the matching core and Vite packages when that release is available:

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

The plugin also continues to process [marked HTML and static JSX](code-example-authoring.md).
No React dependency or browser highlighter is added by Ferriki.

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

function CodeBlock({ code }: { code: PreparedCodeBlock }) {
  return (
    <figure>
      <figcaption>{code.metadata.title}</figcaption>
      <button type="button" onClick={() => navigator.clipboard.writeText(code.code)}>
        Copy code
      </button>
      <div dangerouslySetInnerHTML={{ __html: code.html }} />
    </figure>
  );
}

export function Example() {
  return <CodeBlock code={example} />;
}
```

The original string, including its final newline, is retained in `code.code`.
The HTML contains the complete highlighted `pre`/`code` block. Render that HTML
inside a container rather than nesting it in another `pre`. Ferriki escapes
original source text. Custom transformer output is trusted caller code, as in
the normal HTML API; do not treat arbitrary HTML as a prepared Ferriki result.

The Vite plugin imports the generated stylesheet for the transformed module.
`code.css` also carries generated theme CSS and adapter line presentation rules,
for consumers that transfer the prepared descriptor outside that module's
normal CSS delivery. Do not inject a second copy when Vite already delivers it.
Select a configured class-output theme with `data-ferriki-theme="dark"` on the
code block or an ancestor. Surrounding UI and custom transformer presentation
styles remain your responsibility.

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

By default, the transform emits a `div` containing the complete prepared
`pre`/`code` HTML and delivers its CSS. Optional `className` applies to this
outer `div`, leaving the generated highlighting classes inside it intact.
Unlike highlighting inputs, `className` accepts ordinary runtime expressions:

```tsx
<Code
  className={compact ? "example compact" : "example"}
  language="ts"
  source={`const answer = 42;`}
/>;
```

For a custom copy button, title or tabs, provide a `render` function. It receives
`{ code: PreparedCodeBlock, className?: string }`. You explicitly decide which
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
`render={({ code, className }) => <MyCodeBlock code={code} className={className} />}`.
The renderer can pass its own props, capture local values, return a fragment
or `null`, or be a named function. It runs during normal application rendering;
Ferriki never evaluates it at build time. A stable module-local React component
invokes it when React renders the element, including JSX stored at module scope.
Render ordinary React components through JSX inside the callback. There is no
implicit prop insertion or extra container around its result. `className` is included in the renderer's props
only when supplied on `Code`; the callback controls where to apply it.
An omitted renderer, or one that evaluates to `undefined`, uses the default
`div`. A renderer returning `null` or `undefined` keeps that result.
`render` accepts functions, not JSX elements. The unreleased `component` prop
has been replaced by this explicit contract and has no compatibility alias.

Import aliases with JSX component names such as `Code as HighlightedCode` work,
and unrelated locally shadowed components are left alone. Using the imported
marker as a function, passing it elsewhere or re-exporting it is rejected.
An unprocessed marker throws an actionable integration error.

Server rendering, hydration, navigation and HMR use the same prepared HTML/CSS
path as `code()`. The macro import is removed from transformed application
modules, so the browser does not load it or any build-time macro code.

## Supported function inputs

Code must appear directly in the call as a string literal or a template literal
without `${...}` interpolations. Template content uses JavaScript's cooked
string value, so escapes have their normal JavaScript meaning. Constant
bindings, raw-file imports, variables and computed strings are not evaluated.
Cooked strings must contain valid Unicode; unpaired UTF-16 surrogates are
rejected instead of changing the original source.

Options must be an object literal with these supported keys:

| Option | Meaning |
| --- | --- |
| `language` | Required nonempty string literal, such as `"ts"`. |
| `meta` | Optional string literal. Uses the adapter's existing `title="..."`, `[label]`, `{2,4-5}` and `showLineNumbers` metadata syntax. |
| `lineNumbers` | Optional boolean literal overriding the plugin default. Explicit `showLineNumbers` metadata also enables numbering. |

Themes, style mode, assets and transformer callbacks are configured on the
plugin. Dynamic options, spreads, computed keys, duplicate keys and unsupported
keys produce a filename/position diagnostic. Calls inside loops are allowed
when their inputs remain inline literals; `code(sample.content, ...)`
is outside this contract.

Named import aliases work. Lexically shadowed functions are ordinary functions
and are not transformed. The macro must be called directly: assigning it to
another variable, re-exporting it or using unsupported import/call forms is
rejected instead of leaving an accidental runtime macro invocation.
Type-only imports and re-exports remain valid; they carry no runtime marker.

## Errors and application delivery

Calling the marker without a transform throws a clear configuration error.
Enable the Ferriki integration and ensure that the module reaches its transform.
Unknown languages emit a warning and produce escaped plain-code output. Missing
assets and native failures propagate; they are not successful highlighting.

The same prepared descriptor is emitted into server and browser modules. A
hydrated component and subsequent navigation consume that data without a native
binding or asset downloader in the browser. A server-only HTML rewrite does not
implement this contract. Inline source and its highlighted representation are
included in application assets; use this path for examples intended to be shown.

For MDX, expose the imported marker and call to the plugin before the compiler
hides or lowers that module. `include(id)` can add an exposed module ID; it
cannot reveal a compiler's internal rendering. Ordinary Markdown fences stay
on their existing Ferromark compiler path.

## Other build hosts

Macro recognition is part of `@ferriki/vite`. `@ferriki/core` ships no macro
scanner; the former build-only `@ferriki/core/macro-transform` entry and its
`findInlineCodeMacros` function were removed without a compatibility alias.
Custom adapters must prepare HTML through the supported highlighter, preserve
source maps and deliver the same prepared data and CSS on server and client.
See [ADR 0018](../adr/0018-inline-highlighting-macros.md) for ownership and the
inline-only boundary.

## Repository checks

After the repository's normal native setup, run from `node/`:

```sh
pnpm run test:vite
pnpm run check:packed-vite
pnpm dlx playwright@1.63.0 install --with-deps chromium
pnpm run check:inline-macro
```

The focused browser check uses the real packed core, sidecar and Vite packages.
It covers server rendering and hydration, navigation, exact source copying,
theme/CSS delivery, HMR and the browser module boundary. The portable packed
consumer check also retains the existing marked HTML/JSX Vite 7/8 coverage.
