# @ferriki/vite

`@ferriki/vite` prepares Ferriki's inline highlighting macros during Vite
transforms with Ferriki's native highlighter. It replaces `code()` calls from
`@ferriki/core/macro` and `<Code />` elements from `@ferriki/core/react/macro`
with highlighted HTML and CSS at build time; it does not add a browser
highlighter, a React runtime, or custom elements.

The current adapter source is in this repository at [`node/vite`](https://github.com/sebastian-software/ferriki/tree/main/node/vite). As of 2026-10-03, `@ferriki/vite@0.9.0` is not available from npm; check the registry before adding it to an application. To exercise a local packed consumer, follow the [inline macro guide](https://github.com/sebastian-software/ferriki/blob/main/docs/inline-code-macros.md#repository-checks). After a matching package release exists, install it with:

```sh
npm install @ferriki/core @ferriki/vite
```

```js
// vite.config.js
import { ferriki } from "@ferriki/vite";

export default {
  plugins: [
    ferriki({
      themes: { light: "github-light-default", dark: "github-dark-default" },
      styleMode: "classes",
      lineNumbers: true,
    }),
    // Add your framework plugin after Ferriki.
  ],
};
```

## Prepare code with `code()`

```ts
import { code } from "@ferriki/core/macro";

export const example = code("export const answer = 42;\n", {
  language: "ts",
  meta: 'title="Answer" [TypeScript] {1}',
});
```

The call becomes a prepared descriptor with the exact original `code`, its
`language`, the highlighted `html`, the applicable `css` and parsed
`metadata`. Code and options must be literals written in the call; the
[inline macro guide](https://github.com/sebastian-software/ferriki/blob/main/docs/inline-code-macros.md)
lists the supported forms.

## Prepare code with `<Code />` in React

```tsx
import { Code } from "@ferriki/core/react/macro";

<Code className="example-code" language="ts" source={`const answer = 42;`} />;
```

Place Ferriki before the React plugin. The self-closing marker requires literal
`source` and `language`; optional `meta` and `lineNumbers` are also static.
Optional `className` accepts a string or runtime expression and styles the
default outer `div`. For custom presentation, use
`render={(props) => <MyCodeBlock {...props} />}`. The callback receives the
prepared descriptor as `code` and, when supplied, `className`; prop forwarding
is explicit. It runs during application rendering, not compilation. An absent
or `undefined` renderer keeps the default output. Children, spreads on `Code`,
and other attributes are unsupported. The macro import and element are
replaced before React lowers JSX.

## Which modules are transformed

The adapter is import-driven. Its transform hook declares a host filter, so
Vite and Rolldown only call it for JavaScript and TypeScript modules
(`.js`, `.jsx`, `.ts`, `.tsx` and their `.mjs`/`.cjs`/`.mts`/`.cts` forms) whose
source contains the text `@ferriki/core/macro` or `@ferriki/core/react/macro`.
Every other module is never parsed or changed. A module that passes this text
check is parsed once with Vite's own parser (Rolldown's OXC `parseAst`); the
parse, not the text, decides whether it imports a macro. A module that imports
nothing from the macro subpaths, or only types, is returned unchanged.

Spell the import specifier literally. A specifier written with escape
sequences, such as `"@ferriki/core/macro"`, does not pass the text check;
that module is not transformed and its `code()` call or `<Code />` element
throws the marker's configuration error at runtime.

The imported local name of `code` or `Code`, including an alias, is reserved in
its module. Declaring that name anywhere in the module, also as a parameter or
in a nested scope, is a compile error. A React module that imports both macros
and destructures `({ code })` in a renderer therefore imports the function
macro under another name, for example `import { code as prepareCode }`.

Macro errors are reported through Vite with the module ID, a line and column,
and a code frame. Unknown languages warn once per module and produce escaped
plain code.

## Options

`meta` supports `title="..."`, the first `[label]`, line selections such as
`{2,4-5}`, and `showLineNumbers`. Line numbers are off by default and can be
enabled globally with `lineNumbers: true`; a call's `lineNumbers` overrides that
default. With `styleMode: "classes"`, each transformed module imports a
content-addressed CSS virtual module, so editing an example produces a new
stylesheet ID that Vite's module graph replaces during HMR.

Pass optional Ferriki `transformers` callbacks to apply Shiki notation
transformers to every prepared block. For example, install a compatible
`@shikijs/transformers` version and pass `transformerNotationFocus()`,
`transformerNotationHighlight()`, `transformerNotationDiff()`, or
`transformerNotationWordHighlight()` in that array. These are JavaScript
callbacks; the Vite package does not add another annotation syntax or a browser
runtime. See the [code example authoring guide](https://github.com/sebastian-software/ferriki/blob/main/docs/code-example-authoring.md)
for feature ownership, CSS and copy behavior.

For a Markdown/MDX compiler, the plugin must run while the compiler's output
still contains the macro import and call. A transform that compiles Markdown
and lowers JSX inside a single hook does not expose that intermediate source to
Vite plugins. Use the compiler's JSX-output mode or pass an `include(id)`
predicate for an exposed module ID without a JavaScript or TypeScript
extension, and place that compiler earlier in Vite's `pre` plugin tier than
Ferriki. Such a module is parsed as TSX; when the adapter emits JSX into it,
the transform result declares the `tsx` module type so Rolldown lowers that JSX
in builds.

The package requires Node.js 22.13 or newer and Vite 8. It shares Ferriki's
release version and native asset settings. See the [Vite integration decision](https://github.com/sebastian-software/ferriki/blob/main/adr/0007-adapter-integrations-stay-outside-ferriki.md)
for its product boundary.

For multiple themes, the first key in <code>themes</code> supplies the default colors.
With class output, set <code>data-ferriki-theme="dark"</code> on a prepared
<code>&lt;pre&gt;</code> or one of its ancestors to select another configured theme.
