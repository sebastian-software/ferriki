# Inline code macros

Use `ferrikiCode` when a component accepts a prepared code example instead of
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
import { ferrikiCode } from "@ferriki/core/macro";
import type { PreparedCodeBlock } from "@ferriki/core/macro";

const example = ferrikiCode("export const answer = 42;\n", {
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

## Supported inputs

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
when their inputs remain inline literals; `ferrikiCode(sample.content, ...)`
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

The native scanner is shared through the Node-only
`@ferriki/core/macro-transform` entry. `findInlineCodeMacros(source, filename)`
validates inline calls and returns call/import edits with UTF-8 byte spans.
Custom adapters must prepare HTML through the supported highlighter, translate
byte spans to their editor's offsets, preserve source maps and deliver the same
prepared data and CSS on server and client. The scanner does not render HTML,
resolve imported source values or execute application code.

The macro runtime entry and this build-only entry are deliberately separate.
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
