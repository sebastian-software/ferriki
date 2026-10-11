# @ferriki/vite

`@ferriki/vite` prepares Ferriki's inline highlighting macros during Vite
transforms with Ferriki's native highlighter. It replaces `code()` calls from
`@ferriki/core/macro` and `<Code />` elements from `@ferriki/core/react/macro`
with highlighted HTML and CSS at build time. The default React output is a
`<ferriki-code>` Web Component with an open shadow root and shared, scoped styles.
Ferriki adds its small, framework-free presentation module for that path;
highlighting, grammars, assets, and the build-time parser stay out of the browser.
It adds no React runtime dependency.

Install it with the core package; `@ferriki/core`, its platform sidecar and
`@ferriki/vite` must have the same version:

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

<Code className="example-code" language="ts" maxLines={12} source={`const answer = 42;`} />;
```

Place Ferriki before the React plugin. The self-closing marker requires literal
`source` and `language`; optional `meta` and `lineNumbers` are also static.
Optional `className` accepts a string or runtime expression and applies to
`<ferriki-code>`. Page selectors cannot style its inner `pre`, `code`, or tokens.
Runtime `theme` selects a configured theme alias on the host. Runtime
`maxLines` accepts a positive safe integer and sets a scrollable visible-line
cap. The first configured
theme supplies the default colors. Aliases used by React macros must start with
an ASCII letter or underscore and contain only letters, digits, underscores,
and hyphens.

The generated JSX passes only a content-derived `codeRef`. In a browser build,
the empty host's `code-ref` attribute selects prepared HTML registered outside
React; the element owns its token nodes. During React SSR, the macro emits that
HTML in Declarative Shadow DOM through a server-only HTML sink. The browser
parser creates the shadow root before upgrade, and hydration retains its nodes.
Both paths use one constructed stylesheet and one theme configuration. The
client registry also supplies blocks for later client-rendered navigation.

The default host reserves space from the build-known source line count. Its
sizing style and shadow `pre` share line-height and padding variables, so a
client-only mount retains the surrounding layout until registration fills the
host. SSR includes the highlighted DSD markup as well. `maxLines` is an optional
runtime positive safe integer; longer blocks keep all code and scroll vertically,
while shorter blocks stay short. Omit it or pass `undefined` for no cap. The
macro matches the height reservation to the cap automatically. See the
[sizing guide](../../docs/shadow-code-elements.md#client-rendering-with-reserved-space)
for manual hosts, custom dimensions, and the nonwrapping-line estimate.

The default React SSR path already emits Declarative Shadow DOM; it does not
need a post-render rewrite. Its template links the shared component stylesheet
so highlighted output is styled before JavaScript. In development, Vite serves
that stylesheet at `${base}@ferriki/code-elements.css`. A production build
emits one aggregated, hashed `assets/ferriki-code-*.css` file. Deploy the CSS
emitted by the SSR build with the application's public assets. The plugin
re-emits this required stylesheet when Vite suppresses ordinary SSR assets;
SSR and client builds can produce different hashes. The default `/` base and
absolute path or CDN bases are supported. Direct macro SSR rejects `base: "./"`
and `base: ""` because a relative stylesheet URL is ambiguous on nested routes.

For manually authored empty reference hosts, the plugin API still provides
`renderCodeElements()` and `codeElementCss()` for a complete-HTML server stage.
Production applications can save `codeElementBlocks()` and the CSS after the
SSR build, then call `renderCodeElementShadows()` from
`@ferriki/core/web-component/server` with that registry. These APIs read modules
already transformed by the same plugin instance. Streaming SSR and React
Server Components are unsupported.

Titles, copy buttons, and tabs can wrap the default `<Code />` without replacing
its isolated code presentation. For complete control over the result, use the
application-owned escape hatch `render={(props) => <MyCodeBlock {...props} />}`.
The callback receives the prepared descriptor as `code` and, when supplied,
`className`, `theme`, and `maxLines`; prop forwarding is explicit. It runs during
application rendering, not compilation. An absent or `undefined` renderer uses
the default shadow host. A callback returning `null` or `undefined` keeps its
result. A custom renderer can render `code.html` in regular HTML and take
responsibility for page CSS, or compose the framework-free component. The Web
Component is the only built-in React presentation; the highlighter's HTML API
remains available independently. Children and spreads on `Code` are
unsupported. The macro import and element are replaced before React lowers JSX.

See the [Shadow DOM guide](https://github.com/sebastian-software/ferriki/blob/main/docs/shadow-code-elements.md)
for framework-free use, CSS migration, browser support, and CSP/Trusted Types
limits. Shadow DOM isolates selectors; it does not sanitize arbitrary HTML.

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
sequences, such as `"@ferriki/core/\u006dacro"`, does not pass the text check;
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
default. `code()` and custom React renderers import content-addressed CSS virtual modules
when their blocks need CSS. Editing an example produces a new stylesheet ID
that Vite replaces during HMR. Default React modules contribute their generated
CSS to the stylesheet shared by every shadow root. Inline colors remain in the
HTML; single-theme inline output needs no separate color stylesheet.

Pass optional Ferriki `transformers` callbacks to apply Shiki notation
transformers to every prepared block. For example, install a compatible
`@shikijs/transformers` version and pass `transformerNotationFocus()`,
`transformerNotationHighlight()`, `transformerNotationDiff()`, or
`transformerNotationWordHighlight()` in that array. These are JavaScript
callbacks; the Vite package does not add another annotation syntax or a browser
highlighter. See the [code example authoring guide](https://github.com/sebastian-software/ferriki/blob/main/docs/code-example-authoring.md)
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

The package requires Node.js 22.13.0 or newer and Vite 8. It shares Ferriki's
release version and native asset settings. See the [Vite integration decision](https://github.com/sebastian-software/ferriki/blob/main/adr/0007-adapter-integrations-stay-outside-ferriki.md)
for its product boundary.

For multiple themes, the first key in <code>themes</code> supplies the default colors.
For default React output, pass <code>theme="dark"</code> on <code>&lt;Code&gt;</code>.
For ordinary class-output HTML, set <code>data-ferriki-theme="dark"</code> on the
prepared <code>&lt;pre&gt;</code> or an ancestor.
