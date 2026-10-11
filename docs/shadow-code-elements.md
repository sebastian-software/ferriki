# Shadow code elements

`<ferriki-code>` is a framework-free Web Component for prepared highlighted
HTML. React manages an empty host with a short `code-ref`; the component resolves
that reference and owns the token nodes in an open shadow root. An optional
server HTML stage supplies Declarative Shadow DOM (DSD), so the browser can
display highlighted code before JavaScript and retain those nodes on upgrade.

The React `Code` macro uses the reference interface by default. The optional
`@ferriki/core/web-component` and `@ferriki/core/web-component/server` entries
import no React runtime, native binding, asset loader, or highlighter. Prepare
the HTML at build time or on the server.

## Use the custom element in React

```tsx
import { code } from "@ferriki/core/macro";
import { codeElementSizing, defineCodeElement } from "@ferriki/core/web-component";
import type {} from "@ferriki/core/react/macro";

const block = code(`export const answer = 42;`, { language: "ts" });
const sizing = codeElementSizing(block.code.split(/\r\n|\r|\n/u).length);
defineCodeElement({
  css: block.css,
  themeAliases: [],
  blocks: { answer_v1: block.html },
});

export function Example() {
  return <ferriki-code code-ref="answer_v1" className="example-code" style={sizing} />;
}
```

Configure the [Vite integration](inline-code-macros.md) for `code()`. This
example uses a single theme; for multiple themes, pass the same aliases as the
plugin. The type-only React macro import supplies the JSX tag declaration.
A result from `codeToHtmlWithCss` can also supply the HTML and CSS, provided
preparation runs outside the browser.

`blocks` maps IDs to trusted HTML. IDs contain one or more ASCII letters,
digits, underscores, or hyphens. Repeated registration with the same ID and
HTML is harmless; changing the HTML for an existing ID throws. Give changed
content a new ID. Registration can add blocks later and updates connected
hosts waiting for those references. An unresolved reference shows no code;
switching to it clears the previous content.

React passes neither highlighted HTML nor code children through this reference
host. Its only content prop is a string ID. Theme and parent updates retain the
shadow nodes. A changed reference replaces the content; repeating a reference
does not parse it again. The optional `codeRef` property reflects `code-ref`.
Use the `code-ref` attribute in server-rendered JSX; both browser upgrade and
the DSD HTML stage resolve that attribute. The `codeRef` property is useful for
imperative writes or client-only React rendering.

## React macro default

```tsx
import { Code } from "@ferriki/core/react/macro";

<Code
  language="ts"
  source={`export const answer = 42;`}
  maxLines={12}
  className="example-code"
  theme={darkMode ? "dark" : "light"}
/>;
```

The transform prepares module-level data, assigns a content-derived ID, and
registers the HTML and CSS once through the default helper. Identical descriptors
share an ID. React receives only `codeRef` and runtime presentation props, then
renders `<ferriki-code code-ref="ferriki-…" />`. No token JSX serializer, React
HTML injection, or hydration suppression is involved.

The default host also gets a module-level sizing style derived from the source
line count. It reserves space before JavaScript fills the shadow root, without
shipping token markup in SSR. `maxLines` optionally caps the visible block at a
positive safe integer number of lines; all highlighted code remains in the
shadow root and longer blocks scroll vertically. Shorter blocks stay short.
Omit `maxLines` or pass `undefined` for an unlimited block.

`className`, `theme`, and `maxLines` are runtime props. `maxLines` must resolve
to a positive safe integer when supplied. `source`, `language`, `meta`, and
`lineNumbers` remain compile-time literals. `theme` names a key in the plugin's
`themes` map; omitting it uses the first theme or the single configured theme.
A custom `render` function still receives the complete prepared descriptor and
uses ordinary Vite CSS delivery. It does not register the tag automatically.

## Migrate existing React macros

Existing `<Code />` calls select the Web Component without an opt-in flag.
The generated host changes from a `div` containing highlighted HTML to an empty
`<ferriki-code>` with shadow content. This changes observable markup and CSS
scoping: keep surrounding layout styles on the host, register rules for inner
code through the shared stylesheet, and select the theme on the host itself.
Page selectors and ancestor theme attributes no longer style inner tokens.

Default SSR reserves space but contains no highlighted text before JavaScript.
Applications that require that text install the complete-HTML DSD stage below.
Copy original source from the prepared descriptor; DOM-based tools query the
host's open `shadowRoot`. Titles, copy buttons, and tabs can remain ordinary
React wrappers around `<Code />`.

The HTML API and `code()` descriptor keep their existing contracts. An existing
custom `render` callback retains control over its result, including ordinary
light-DOM HTML when an application requires that integration.

## Client rendering with reserved space

Highlighted SSR output is optional. Use the reference host when code can appear
after JavaScript loads; the empty host can already occupy its eventual space.
The default React macro applies this reservation and any `maxLines` cap
automatically. For a manual host, pass the same cap to `codeElementSizing` and
the `max-lines` attribute so the no-JavaScript reservation matches the eventual
scroll viewport:

```tsx
<ferriki-code code-ref="answer_v1" max-lines={12} style={codeElementSizing(lineCount, 12)} />
```

The `maxLines` property accepts a positive safe integer, `null`, or
`undefined`; nullish values mean unlimited. The canonical attribute is
`max-lines`; React SSR may lowercase a JSX `maxLines` property to the `maxlines`
alias. Invalid attribute values are ignored and leave the block unlimited. The
sizing helper throws for an invalid line count or cap. It reserves the source
line count, limited by the cap when supplied, plus shared block padding. The
shadow `pre` uses
`--ferriki-code-max-block-size` for the same cap and remains vertically
scrollable, so no code is truncated. The runtime adds `tabindex="0"` to a capped
`pre` for keyboard scrolling unless the authored `pre` already has a `tabindex`.

For imperative hosts, apply the uncapped reservation with
`Object.assign(element.style, codeElementSizing(lineCount))`, then set
`element.maxLines = maxLines`; the property updates the cap styling.

The estimate is the line count times one line box, plus block padding. Source
CRLF, CR, and LF separators count as line breaks; a trailing blank line counts
too. Empty source reserves one line. The default line box is `1.3125rem`, matching
the code font's `0.875rem` size and `1.5` line spacing, with no block padding.
The host uses content-box sizing so its own borders and padding add equally
before and after upgrade.

Customize the estimate and the actual shadow presentation together:

```css
.example-code {
  --ferriki-code-line-height: 1.5rem;
  --ferriki-code-padding-block: 1rem;
}
```

Both variables must be lengths; use `1.5rem`, for example, rather than a unitless
line-height value. The shared shadow stylesheet reads the same variables as
the reservation. These small host sizing declarations do not duplicate theme
palettes. Registration, hydration, and theme changes retain the reserved size
in the browser fixture; changing references can change the source-line count
and its reservation.

This estimates nonwrapping preformatted lines. Custom transformer layout,
wrapping, and scrollbar geometry may require application-specific sizing. Use
the optional DSD stage below when highlighted text must be present before
JavaScript.

## Server rendering with Declarative Shadow DOM

Ordinary React SSR emits only the reference host:

```html
<ferriki-code class="example-code" code-ref="answer_v1"></ferriki-code>
```

Without the server HTML stage, this host stays empty until JavaScript registers
the component and its blocks; the macro's sizing style still reserves space.
To display code before JavaScript, postprocess
the complete rendered HTML outside React:

```js
import { renderCodeElementShadows } from "@ferriki/core/web-component/server";

const html = renderCodeElementShadows(reactHtml, {
  blocks: { answer_v1: preparedBlock.html },
  stylesheetHref: "/assets/ferriki-code.css",
});
```

The server stage fills eligible empty reference hosts with
`<template shadowrootmode="open">`, a reference marker, a link to the shared CSS
file, and the trusted highlighted HTML. It skips manual hosts with content or
HTML-property attributes, scripts, comments, and inert templates. Unknown
references in eligible hosts throw. Calling it on the same result again leaves
the HTML unchanged. This helper processes a complete, well-formed HTML string;
it is not a streaming HTML parser or sanitizer.

The browser attaches the shadow root while parsing the document. Register the
component **after that HTML has been parsed**, before hydration. A deferred
module entry has this ordering for ordinary complete-page SSR. Defining the
element before the parser reaches its DSD template is unsupported: the
constructor would create the root first. Do not run a registration script
ahead of the SSR body.

On upgrade, the element reuses the existing root and its matching reference
marker. It preserves the server-created nodes, including when the registry
arrives later. React hydrates the empty light-DOM host. The component never
moves React-owned children into its root. Theme and parent updates preserve
those nodes; changed references replace them. Streaming SSR and React Server
Components are outside the verified contract.

See [Declarative Shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM#declaratively_with_html)
and [React's custom-element contract](https://react.dev/reference/react-dom/components#custom-html-elements).

### Connect the Vite server pipeline

Keep the same plugin instance used to transform the SSR modules:

```js
const codePlugin = ferriki(options);
const server = await createServer({ plugins: [codePlugin] /* other options */ });
const { App } = await server.ssrLoadModule("/src/app.jsx");
const reactHtml = renderToString(React.createElement(App));
const html = codePlugin.api.renderCodeElements(reactHtml, {
  stylesheetHref: "/ferriki-code.css",
});
```

Serve `codePlugin.api.codeElementCss()` as `/ferriki-code.css`. Call these APIs
after the relevant modules have been transformed. The
[browser example](../node/examples/shadow-dom/README.md) exercises this pipeline.
Vite does not automatically install a framework SSR hook or CSS endpoint.

For production, save `codePlugin.api.codeElementBlocks()` as a server registry
and `codePlugin.api.codeElementCss()` as a CSS asset after the SSR build. The
standalone `renderCodeElementShadows` helper accepts that saved registry at
request time. Use identical highlighting options for client and server builds
so their content-derived IDs match. The registry is prepared HTML data; serving
it to a client and registering it separately is also possible. The default
macro keeps its module-level registry in the client bundle.

## Share styles

In `styleMode: "inline"`, token and background colors are already style
attributes in the highlighted HTML. Shared CSS covers typography, line
annotations, and selectors for switching inline theme variables. There is no
separate resolved inline color palette to duplicate.

In `styleMode: "classes"`, the HTML carries class names and descriptor `css`
contains the token and theme rules. Include these rules in the shared CSS file
for DSD before JavaScript. `stylesheetHref` is optional, but class output needs
its styles to be available before upgrade for correct no-JavaScript colors.

DSD roots link to one CSS URL. This repeats a small link element, not the CSS
declarations. Once their blocks are registered, all roots in a document adopt
the exact same constructed `CSSStyleSheet`, and the component removes their
DSD links marked `data-ferriki-code-css`. A root awaiting its block registration
keeps that external stylesheet so partial or lazy registration preserves its
styles. No root receives an inline `<style>` tag. Repeated registration and
overlapping class rules are deduplicated; new rules reach existing roots.
Browser-created link stylesheets before upgrade are not promised to share the
same `CSSStyleSheet` object.
See [shared constructed stylesheets](https://developer.mozilla.org/en-US/docs/Web/API/ShadowRoot/adoptedStyleSheets).

When registering class-mode blocks, supply their associated `css` in the same
call or register it before their `blocks`. Registering an ID signals that its
shared styles are ready and permits removal of the DSD stylesheet link. The
generated Vite helper registers both together; manual consumers must do so too.

Use one theme alias profile per tag definition. Conflicting alias sets throw;
additional CSS must use the same theme mapping and compatible rules. The
registration defaults are `["light", "dark"]`; use `[]` for a single theme.
Aliases start with an ASCII letter or underscore and contain only ASCII letters,
digits, underscores, and hyphens. Theme switching uses Ferriki's default
`--shiki-` variable prefix. Add transformer presentation rules through the
shared `css` option. `codeElementStyles(aliases)` returns base and theme rules
for a manually prepared CSS asset.

CSS and HTML registry additions last for the definition's lifetime. Hot updates
can add new IDs and class rules; unused old entries remain until a page reload.
`code()` still uses ordinary Vite CSS delivery, so mixed light-DOM and shadow
consumers can also have a page stylesheet. Page CSS does not style shadow tokens.

Style the host for layout and surrounding presentation:

```css
ferriki-code.example-code {
  margin-block: 1rem;
  border-radius: 0.5rem;
  overflow: hidden;
}
```

Page selectors for inner `pre`, `code`, or token spans do not cross the shadow
boundary, and the component's stylesheet rules do not style the surrounding
page. This isolates code presentation from ordinary page resets and selectors;
it does not promise identical pixels in every document. Page CSS can style the
host, whose font family the inner `pre` inherits. Inherited properties and custom
properties can cross the boundary, `rem` dimensions still use the document's
root font size, and available fonts affect text metrics. Keep those inputs
consistent when matching presentation across pages. Set the theme attribute on
the host; an ancestor's theme attribute does not select it.
Code remains real selectable text. For exact-source copy buttons, use the
descriptor's `code`; queries for rendered content use `element.shadowRoot`.
Keep application controls outside the root.

## Direct HTML property and use without React

The string interface remains available for imperative or dynamic consumers:

```js
defineCodeElement({ css: preparedBlock.css, themeAliases: [] });
const element = document.createElement("ferriki-code");
element.highlightedCode = preparedBlock.html;
element.maxLines = 12;
document.querySelector(".example-slot").append(element);
```

The `maxLines` property may also be set to `null` or `undefined` to remove the
cap. Assigning an invalid value throws. For server-rendered or static hosts, use
the `max-lines` attribute and a matching `codeElementSizing(lineCount, maxLines)`
style so both the initial reservation and upgraded scroll viewport agree.

React 19 can also use `<ferriki-code highlightedCode={html} />`. Register before
React creates the host so it recognizes the property. `highlighted-code` and
the SSR-lowercased `highlightedcode` attribute provide the string interface too.
The component parses this trusted HTML internally; strings used as ordinary
React children would be escaped text. The latest explicit property or observed
attribute write selects the content source. `null` or `undefined` clears the
content and exposes an optional light-DOM fallback through a slot.

Property-mode React SSR serializes HTML as an escaped attribute. It can retain
a caller-supplied plain-source child for no-JavaScript output, but has extra
transport cost. The default reference macro has no such fallback. Importing and
calling `defineCodeElement` on a server returns `undefined`; a foreign tag
definition reports a conflict.

## Browser and trust boundary

The browser runtime requires Custom Elements, Shadow DOM, and constructed
stylesheets with `adoptedStyleSheets`. DSD also needs native declarative shadow
parsing. The browser fixture checks Chromium, Firefox, and WebKit; WebKit tests
do not certify every Safari version or device.

Ferriki escapes original source; custom transformer markup is trusted caller
code. Pass only HTML from that pipeline. Shadow DOM isolates selectors and DOM
ownership; it is not a sanitizer or security sandbox. CSR still parses HTML,
and DSD shifts that parsing to the document parser. Token DOM and layout work
remain, so isolation alone does not establish a speedup.

The [reference and DSD benchmark](../node/benchmarks/shadow-dom-spike/REFERENCE-DSD-REPORT.md)
records the measured SSR, setup, commit, and payload tradeoffs. It uses thin
adapters rather than the full generated macro helper, and excludes document
parsing and asset loading from browser timing. It does not measure complete
startup or isolated React CPU time.

The [hydration breakdown](../node/benchmarks/shadow-dom-spike/HYDRATION-BREAKDOWN.md)
shows that most of the inline reference call-to-commit interval is browser
style, layout, prepaint, and paint work pending after registration. Similar
light-DOM work happens before its timer starts. React hydrates the outer hosts;
the larger elapsed interval does not mean it processes the shadow tokens.

Strict [`require-trusted-types-for 'script'`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/require-trusted-types-for)
can reject the component's string sink during CSR or content changes; no
built-in Trusted Types policy or `TrustedHTML` hook is provided. Inline token
output still needs CSP permission for style attributes; classes mode avoids
token style attributes. The macro's SSR sizing hints are host style attributes
in either mode, so the application's policy must permit those too. Allow the
shared stylesheet asset in the application's stylesheet policy.
