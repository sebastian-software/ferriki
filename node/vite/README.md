# @ferriki/vite

`@ferriki/vite` highlights opted-in code blocks during Vite transforms with
Ferriki's native highlighter. It emits HTML and CSS at build time; it does not
add a browser highlighter, a React runtime, or custom elements.

The current adapter source is in this repository at [`node/vite`](https://github.com/sebastian-software/ferriki/tree/main/node/vite). As of 2026-10-03, `@ferriki/vite@0.9.0` is not available from npm; check the registry before adding it to an application. To run the source example or exercise a local packed consumer, follow [code example authoring](https://github.com/sebastian-software/ferriki/blob/main/docs/code-example-authoring.md). After a matching package release exists, install it with:

```sh
npm install @ferriki/vite
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
  ],
};
```

Mark ordinary HTML with `data-highlight="auto"` and a static language. `auto`
means that the block opts into highlighting; Ferriki does not detect its
language.

```html
<pre
  data-highlight="auto"
  data-language="ts"
  data-meta='title="Example" [API] {2} showLineNumbers'
><code>const answer = 42;
console.log(answer);</code></pre>
```

The same marker works on intrinsic `<pre><code>` blocks in `.jsx` and `.tsx`
modules. The plugin accepts static text and string literal children. Dynamic
children, computed protocol attributes, dynamic `class` or `style` props, and
spread attributes leave that block unchanged. Other attributes and surrounding
UI remain in place. Unknown languages produce one warning per file and keep
the original code as plain text.

For a Markdown/MDX compiler, the plugin must run while the compiler's output is
still JSX. A transform that compiles Markdown and lowers JSX inside a single
hook does not expose that intermediate source to Vite plugins. Use the
compiler's JSX-output mode or pass an `include(id)` predicate for an exposed
virtual JSX module ID. Place a compiler that exposes that module earlier in
Vite's `pre` plugin tier than Ferriki. The predicate only expands which IDs are
parsed and does not make lowered output transformable.

`data-meta` supports `title="..."`, the first `[label]`, line selections such
as `{2,4-5}`, and `showLineNumbers`. Line numbers are off by default and can be
enabled globally with `lineNumbers: true`. For class output, Ferriki injects
the generated stylesheet into HTML and imports a content-addressed CSS virtual
module from transformed JSX. Editing a block produces a new stylesheet ID so
Vite's module graph replaces the prior CSS during HMR.

Pass optional Ferriki `transformers` callbacks to apply Shiki notation
transformers to each marked block. For example, install a compatible
`@shikijs/transformers` version and pass `transformerNotationFocus()`,
`transformerNotationHighlight()`, `transformerNotationDiff()`, or
`transformerNotationWordHighlight()` in that array. These are JavaScript
callbacks; the Vite package does not add another annotation syntax or a browser
runtime. See the [code example authoring guide](https://github.com/sebastian-software/ferriki/blob/main/docs/code-example-authoring.md)
for feature ownership, CSS, accessible collapse and copy behavior, and a
runnable example.

The package requires Node.js 22.13 or newer and Vite 7 or 8. It shares Ferriki's
release version and native asset settings. See the [Vite integration decision](https://github.com/sebastian-software/ferriki/blob/main/adr/0007-adapter-integrations-stay-outside-ferriki.md)
for its product boundary.

For multiple themes, the first key in <code>themes</code> supplies the default colors.
With class output, set <code>data-ferriki-theme="dark"</code> on a marked
<code>&lt;pre&gt;</code> or one of its ancestors to select another configured theme.
