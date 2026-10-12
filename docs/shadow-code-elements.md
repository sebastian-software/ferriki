# Shadow code elements

Think of each code block as a small display with its own styling. React
controls where that display sits on the page and the attributes of its outer
element. The `<ferriki-code>` Web Component controls the code inside it.
Shadow DOM provides the boundary: page CSS selectors do not reach the code,
and React does not manage its individual tokens. The code remains real text
that people can select and copy.

Ferriki adds the syntax colors during the build. The browser receives the
prepared result and does not run a highlighter.

![An unhighlighted JSX Code call passes its example through the source property as a
string with braces and backticks. The code moves through build-time highlighting
and server HTML to an isolated area in the browser. React manages the page and
outer code element; the Web Component manages the text inside.](assets/code-element-lifecycle-v2.png)

For the first page load with server rendering, the server sends the actual
highlighted HTML inside a template in the code element. The browser moves that
template's contents into the element's isolated area before JavaScript runs.
The template is gone, and the code is already visible. React then attaches to
the surrounding page and the outer code element; the code inside stays in
place. This path needs no extra HTML processing step after server rendering.

On later client navigation, the Web Component fills new code elements from
prepared HTML included in the browser modules. The highlighter still does not
run in the browser. Each shadow root gets small local rules for layout,
scrolling, line annotations, and inline theme switching. Class output also
uses one external CSS asset; the
[style delivery details](#share-styles) appear later in this guide.

This introductory illustration was generated with ImageGen; its
[saved prompt](assets/code-element-lifecycle-v2-prompt.md) records the visual.
The [implementation diagrams](#react-ssr-and-declarative-shadow-dom) show the
individual runtime steps and final DOM structure.

The optional `@ferriki/core/web-component` and
`@ferriki/core/web-component/server` entries also work without React. They
import no React runtime, native binding, asset loader, or highlighter. Prepare
the HTML at build time or on the server. The server helper remains available
for manually authored reference hosts.

## Use the custom element in React

```tsx
import { code } from "@ferriki/core/macro";
import { codeElementSizing, defineCodeElement } from "@ferriki/core/web-component";
import type {} from "@ferriki/core/react/macro";

const block = code(`export const answer = 42;`, { language: "ts" });
const sizing = codeElementSizing(block.code.split(/\r\n|\r|\n/u).length);
defineCodeElement({
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
preparation runs outside the browser. For classes output, pass its generated
CSS through `stylesheetHref`; `css` on `defineCodeElement` remains available
for manual local stylesheet additions.

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

The transform prepares each descriptor, assigns a content-derived ID, records
its source-line count, and prepares a DSD template. Identical descriptors share
an ID. The generated helper uses `import.meta.env.SSR` to select the server or
browser result; local `window` or `globalThis` bindings cannot change that
choice. On the server, it renders `<ferriki-code>` with the DSD template through
a server-only `dangerouslySetInnerHTML` value. The highlighter already escaped
the source, and custom
transformer markup remains trusted application input. The helper does not
convert tokens into React elements. In the browser, it registers prepared HTML
and the optional class stylesheet URL outside React, then returns an empty
`<ferriki-code code-ref="…" />`
with runtime presentation props.

The server template contains the matching reference marker, the highlighted
HTML, and a local base-style element. In classes mode it also links the
aggregated CSS asset. The document parser consumes the template and creates the
open shadow root before JavaScript runs. When the
element is defined, it reuses that root and preserves its token nodes; React
hydrates the host without moving its children or suppressing hydration. Later
client navigation creates empty reference hosts whose content comes from the
client module registry.

The default host also gets a module-level sizing style derived from the source
line count. This reserves space for client-only mounts until registration fills
the shadow root, while SSR also includes the prepared token markup in DSD.
`maxLines` optionally caps the visible block at a positive safe integer number
of lines; all highlighted code remains in the shadow root and longer blocks
scroll vertically. Shorter blocks stay short. Omit `maxLines` or pass
`undefined` for an unlimited block.

`className`, `theme`, and `maxLines` are runtime props. `maxLines` must resolve
to a positive safe integer when supplied. `source`, `language`, `meta`, and
`lineNumbers` remain compile-time literals. `theme` names a key in the plugin's
`themes` map; omitting it uses the first theme or the single configured theme.
A custom `render` function still receives the complete prepared descriptor and
uses ordinary Vite CSS delivery. It does not register the tag automatically.

## Migrate existing React macros

This default presentation transition targets Ferriki 1.1.0 as a one-time
exception during the initial 1.x adoption period. Existing macro calls remain
valid, but consumers of the previous DOM and CSS scoping need the migration
below. See [ADR 0019](../adr/0019-shadow-dom-code-elements.md#release-scope)
for the release scope.

Existing `<Code />` calls select the Web Component without an opt-in flag.
The generated host changes from a `div` containing highlighted HTML to
`<ferriki-code>` with shadow content. This changes observable markup and CSS
scoping: keep layout styles on the host, set supported public color variables
in normal page CSS, and select the theme on the host itself. Page selectors and
ancestor theme attributes do not target inner tokens; inherited custom
properties, including the documented color overrides, can still cross the
shadow boundary.

SSR now includes highlighted output in DSD by default. A browser-only mount has
an empty host until its module registers the content, while the host sizing
style reserves the expected space. Copy original source from the prepared
descriptor; DOM-based tools query the host's open `shadowRoot`. Titles, copy
buttons, and tabs can remain ordinary React wrappers around `<Code />`.

The HTML API and `code()` descriptor keep their existing contracts. An existing
custom `render` callback retains control over its result, including ordinary
light-DOM HTML when an application requires that integration.

## Client rendering with reserved space

The default React macro emits highlighted DSD during SSR. The source-line
reservation is still useful for client-only mounts and manual reference hosts
that have no DSD; it gives the empty host its expected space before JavaScript
registers the block. The macro applies this reservation and any `maxLines` cap
automatically. For a manual host, pass the same cap to `codeElementSizing` and
the `max-lines` attribute so the initial reservation matches the eventual
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
line-height value. The local base-style element reads the same variables as the
reservation. These small host sizing declarations do not duplicate theme
palettes. Registration, hydration, and theme changes retain the reserved size
in the browser fixture; changing references can change the source-line count
and its reservation.

This estimates nonwrapping preformatted lines. Custom transformer layout,
wrapping, and scrollbar geometry may require application-specific sizing.

## React SSR and Declarative Shadow DOM

The React macro emits DSD directly during SSR. Its server branch uses
`import.meta.env.SSR` and a server-only `dangerouslySetInnerHTML` value for the
prepared template; the browser branch returns an empty reference host and
registers its HTML, theme aliases, and optional class stylesheet URL. The SSR
host has ordinary light-DOM attributes and a DSD template:

```html
<ferriki-code class="example-code" code-ref="answer_v1">
  <template shadowrootmode="open">
    <!--ferriki-code:ENCODED_REFERENCE-->
    <style data-ferriki-code-base>
      BASE_AND_THEME_SWITCH_RULES
    </style>
    <!-- Classes mode only: -->
    <link rel="stylesheet" href="CLASS_CSS_URL" data-ferriki-code-css />
    <pre><code>...prepared highlighted HTML...</code></pre>
  </template>
</ferriki-code>
```

`ENCODED_REFERENCE` matches the host's `code-ref`. Every root has a small local
style block for layout, scrolling, line annotations, and inline theme switching.
`CLASS_CSS_URL` is present only in classes mode and points to the aggregated
class rules. The template contains the prepared HTML, not a React tree of token
elements. The macro's default SSR path needs no post-render HTML rewrite.

Inline mode needs no external CSS asset or Vite `base` restriction. In classes
mode, Vite serves the aggregated class CSS during development at
`${base}@ferriki/code-elements.css` and emits a hashed
`assets/ferriki-code-*.css` file in production. Deploy the CSS emitted by the
SSR build with the application's public assets; client and SSR build graphs can
produce different hashes. Direct class-mode macro SSR needs an absolute path or
URL base because a relative asset URL is ambiguous on nested routes. See the
[Vite guide](../node/vite/README.md) for the asset delivery contract.

The document parser consumes the template and creates the open shadow root
before JavaScript runs. Load and register the component after complete document
parsing and before React hydration. Do not define `<ferriki-code>` before the
parser reaches the template; its constructor would create the shadow root too
early for DSD. Upgrade reuses the parser-created root and preserves the
matching reference's nodes. The module registers the HTML and, in classes mode,
the stylesheet URL; React then hydrates the host without moving shadow nodes or
disabling hydration checks. Theme and parent updates retain the nodes. A later
client-rendered route uses the browser module's registry to populate new empty
reference hosts. Client-only mounts also use that registry and the macro's
source-line sizing reservation. The diagram below shows the separate SSR,
hydration, and later CSR paths.

```mermaid
flowchart TD
  B["Vite build transform<br/>Prepare descriptors, IDs, line counts, and templates"]
  SSR["React SSR<br/>import.meta.env.SSR selects host plus DSD"]
  BASECSS["Local base and theme-switch rules<br/>One style element per shadow root"]
  CSS["Optional aggregated class CSS<br/>Dev endpoint or hashed production file"]
  HTML["Complete HTML<br/>DSD has local rules; classes mode links class CSS"]
  PARSER["Browser parser<br/>Consumes DSD before JavaScript"]
  ROOT["Parser-created open shadow root<br/>Marker and highlighted HTML"]
  CLIENT["Browser module<br/>Registers HTML, aliases, and optional CSS URL"]
  UPGRADE["Custom-element upgrade<br/>Reuses the root and preserves its styles"]
  HYDRATE["React hydration<br/>Updates the host; retains shadow nodes"]
  NAV["Later CSR navigation<br/>New references resolve from the module registry"]
  CSR["CSR-only mount<br/>Empty reference host resolves after registration"]
  B --> SSR --> HTML --> PARSER --> ROOT
  B --> BASECSS --> HTML
  B -. "classes mode only" .-> CSS
  CSS -. "linked by each template in classes mode" .-> HTML
  B --> CLIENT
  ROOT --> UPGRADE
  CLIENT --> UPGRADE --> HYDRATE --> NAV
  CLIENT --> CSR
  classDef prepared fill:#e5efff,stroke:#3978c8,color:#102444
  classDef shadow fill:#e1f7f3,stroke:#129d91,color:#102444
  class B,SSR,BASECSS,CSS,HTML,CLIENT prepared
  class ROOT,UPGRADE,NAV,CSR shadow
```

### DOM and module ownership

```mermaid
flowchart LR
  REACT["React tree<br/>Wrappers and host attributes"]
  REGISTRY["Prepared browser module<br/>Reference → trusted HTML<br/>Aliases, optional CSS URL, and sizing"]
  subgraph DOM["Final DOM per code block"]
    HOST["ferriki-code host<br/>code-ref, theme, max-lines, sizing"]
    SHADOW["#shadow-root: open"]
    MARKER["Reference marker comment"]
    BASE["Local base-style element"]
    LINK["Optional class CSS link"]
    TOKENS["pre → code → syntax spans<br/>Real selectable text"]
    HOST --> SHADOW
    SHADOW --> MARKER
    SHADOW --> BASE
    SHADOW -. "classes mode" .-> LINK
    SHADOW --> TOKENS
  end
  REACT --> HOST
  REGISTRY -. "Web Component fills new CSR roots" .-> SHADOW
  classDef react fill:#e5efff,stroke:#3978c8,color:#102444
  classDef shadow fill:#e1f7f3,stroke:#129d91,color:#102444
  class REACT,HOST react
  class SHADOW,MARKER,BASE,LINK,TOKENS shadow
```

Vite prepares both representations from the same trusted descriptor. React
owns the custom-element host, its attributes, and surrounding controls. The
HTML parser creates the SSR shadow root; after upgrade, `<ferriki-code>` owns
its token nodes, local base-style element, and optional class CSS link. The
application serves the class CSS asset when that mode is used. The final DOM
has no DSD template; the parser consumed it. A supplied
`render` callback replaces the built-in presentation and
owns its own markup and CSS.

The standalone `renderCodeElementShadows()` helper and
`plugin.api.renderCodeElements()` remain available for manually authored empty
reference hosts in complete server HTML. They add DSD after React has rendered;
they are not part of the default `<Code />` path. The helper skips hosts with
existing content or HTML-property attributes, and ignores scripts, comments,
and inert templates. Unknown eligible references throw. Repeating the helper
is idempotent. It accepts one complete HTML string; it is neither a streaming
parser nor a sanitizer.

For manual Vite server rendering, keep the same plugin instance used to
transform the SSR modules:

```js
const codePlugin = ferriki(options);
const server = await createServer({ plugins: [codePlugin] /* other options */ });
const { App } = await server.ssrLoadModule("/src/app.jsx");
const reactHtml = renderToString(React.createElement(App));
const html = codePlugin.api.renderCodeElements(reactHtml, {
  stylesheetHref: sharedCssUrl,
});
```

The plugin uses its configured theme aliases for this helper. In classes mode,
serve `codePlugin.api.codeElementCss()` at `sharedCssUrl`.
Inline mode needs no external stylesheet URL. These manual APIs read modules
already transformed by the same plugin instance; they do not install an
application SSR hook or serve the class CSS endpoint. Production builds can
save `codeElementBlocks()` and `codeElementCss()` for the standalone helper.
Pass the same theme aliases to `renderCodeElementShadows()` so it emits the
matching base rules. Use identical highlighting options in client and server
builds so content-derived IDs match. Streaming SSR and React Server Components
are outside the verified contract.

See [Declarative Shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM#declaratively_with_html)
and [React's custom-element contract](https://react.dev/reference/react-dom/components#custom-html-elements).

## Share styles

In `styleMode: "inline"`, token and background colors stay in the highlighted
HTML. Each shadow root gets a compact `<style data-ferriki-code-base>` block
for layout, scrolling, line annotations, and multi-theme switching. Inline
mode needs no external CSS asset or stylesheet URL.

In `styleMode: "classes"`, the HTML carries scope classes and Vite combines
the generated token and theme rules into one external CSS asset per build
output. Each DSD root links its build's asset before JavaScript, and client-created
roots link the client asset. SSR and client build graphs can produce different
hashes, so deploy the SSR build's CSS with its markup. Class-mode macro SSR
requires an absolute Vite base. The link stays in the shadow root after the
component upgrades, so the browser can load the asset in both paths. Manual consumers pass the URL as
`stylesheetHref` to `defineCodeElement` or the server helper. The optional
`css` value on `defineCodeElement` remains for manual local stylesheet additions;
it is not the delivery path for Vite's aggregated class rules. No constructed
or adopted stylesheet is required, and browser modules do not carry generated
palette CSS strings in modules that use only the built-in renderer. `code()` and
explicit custom-render descriptors keep their portable `css` field.

Use one theme alias profile per tag definition. Conflicting alias sets throw;
manual local CSS must use the same theme mapping and compatible rules. The
registration defaults are `["light", "dark"]`; use `[]` for a single theme.
Aliases start with an ASCII letter or underscore and contain only ASCII letters,
digits, underscores, and hyphens. Theme switching uses Ferriki's default
`--shiki-` variable prefix. Add manually authored local rules through the
`css` option. `codeElementStyles(aliases)` returns the base and theme-switching
rules used in each root's local style element.

## Public color overrides

The component inherits public color custom properties from ordinary page CSS.
The React `Code` macro prepares the matching `var()` fallbacks. HTML supplied
directly through `highlightedCode` keeps its own declared styles; semantic
overrides require prepared markup that reads these properties.
Set them globally, on a theme container, or on one `<ferriki-code>` host. Ferriki
does not assign defaults to these properties inside the shadow root, so inherited
values remain available. `--ferriki-foreground` sets the code block's default
text color, and `--ferriki-background-color` sets its background. Category
properties override matching semantic tokens and their documented child
categories; when no relevant category property is set, each token keeps its
resolved theme color. The Vite macro retains native scope boundaries during
inline build-time preparation so it can classify semantic tokens. This private
preparation detail does not change general inline `codeToHtml()` output.

```css
:root {
  --ferriki-foreground: #e6edf3;
  --ferriki-background-color: #0d1117;
  --ferriki-keyword-color: #ff7b72;
  --ferriki-string-color: #a5d6ff;
}

.docs-theme {
  --ferriki-background-color: #161b22;
  --ferriki-comment-color: #8b949e;
}

.docs-theme ferriki-code.example-code {
  --ferriki-function-color: #d2a8ff;
}
```

The root properties control the block's default text color and background.
Category properties control matching semantic tokens. An unset category uses
that token's resolved theme color.

| Property                     | Use                                                                 |
| ---------------------------- | ------------------------------------------------------------------- |
| `--ferriki-foreground`       | Default code block text color; themed tokens keep their own colors. |
| `--ferriki-background-color` | Code block background.                                              |

Use the following category reference for more targeted palette adjustments:

| Category         | Public property                  | Falls back through                             |
| ---------------- | -------------------------------- | ---------------------------------------------- |
| `keyword`        | `--ferriki-keyword-color`        | Resolved theme color                           |
| `string`         | `--ferriki-string-color`         | Resolved theme color                           |
| `comment`        | `--ferriki-comment-color`        | Resolved theme color                           |
| `number`         | `--ferriki-number-color`         | Resolved theme color                           |
| `boolean`        | `--ferriki-boolean-color`        | `constant` → resolved theme color              |
| `constant`       | `--ferriki-constant-color`       | Resolved theme color                           |
| `function`       | `--ferriki-function-color`       | Resolved theme color                           |
| `type`           | `--ferriki-type-color`           | Resolved theme color                           |
| `variable`       | `--ferriki-variable-color`       | Resolved theme color                           |
| `parameter`      | `--ferriki-parameter-color`      | `variable` → resolved theme color              |
| `property`       | `--ferriki-property-color`       | `variable` → resolved theme color              |
| `operator`       | `--ferriki-operator-color`       | Resolved theme color                           |
| `punctuation`    | `--ferriki-punctuation-color`    | Resolved theme color                           |
| `tag`            | `--ferriki-tag-color`            | Resolved theme color                           |
| `attribute`      | `--ferriki-attribute-color`      | Resolved theme color                           |
| `regexp`         | `--ferriki-regexp-color`         | `string` → resolved theme color                |
| `escape`         | `--ferriki-escape-color`         | `string` → resolved theme color                |
| `builtin`        | `--ferriki-builtin-color`        | `function` → `variable` → resolved theme color |
| `namespace`      | `--ferriki-namespace-color`      | Resolved theme color                           |
| `class`          | `--ferriki-class-color`          | `type` → resolved theme color                  |
| `interface`      | `--ferriki-interface-color`      | `type` → resolved theme color                  |
| `enum`           | `--ferriki-enum-color`           | `type` → resolved theme color                  |
| `struct`         | `--ferriki-struct-color`         | `type` → resolved theme color                  |
| `type-parameter` | `--ferriki-type-parameter-color` | `type` → resolved theme color                  |
| `method`         | `--ferriki-method-color`         | `function` → resolved theme color              |
| `macro`          | `--ferriki-macro-color`          | Resolved theme color                           |
| `decorator`      | `--ferriki-decorator-color`      | Resolved theme color                           |
| `annotation`     | `--ferriki-annotation-color`     | Resolved theme color                           |
| `label`          | `--ferriki-label-color`          | Resolved theme color                           |
| `heading`        | `--ferriki-heading-color`        | `markup` → resolved theme color                |
| `markup`         | `--ferriki-markup-color`         | Resolved theme color                           |
| `inserted`       | `--ferriki-inserted-color`       | `markup` → resolved theme color                |
| `deleted`        | `--ferriki-deleted-color`        | `markup` → resolved theme color                |
| `invalid`        | `--ferriki-invalid-color`        | Resolved theme color                           |

The final `resolved theme color` fallback is specific to each token when no
matching category property is set. The finite category set cannot express every
nested scope rule. For ordinary HTML output, use class output and its `tok-*`,
`scope-*`, `leaf-*`, and `exact-*` selectors in your stylesheet. Page CSS cannot
reach the default React macro's shadow tokens; use a custom renderer for ordinary
HTML or add local rules through a direct `defineCodeElement({ css })` setup with
the matching theme aliases. The React macro has no separate override CSS source
option. `--ferriki-color` and `--ferriki-background` are internal per-token
variables, not public overrides.

HTML registry entries and manual local CSS additions last for the definition's
lifetime. Palette changes refresh the shared development CSS URL; existing roots
keep their style and link nodes. Unused registry entries remain until a reload.
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
defineCodeElement({ themeAliases: [] });
// In classes mode, pass stylesheetHref: preparedClassCssUrl.
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

The browser runtime requires Custom Elements and Shadow DOM. DSD also needs
native declarative shadow parsing. The browser fixture checks Chromium,
Firefox, and WebKit; WebKit tests do not certify every Safari version or device.

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
built-in Trusted Types policy or `TrustedHTML` hook is provided. Both modes use
a local style element for base presentation, so CSP must allow those rules.
Inline token output also uses style attributes; the macro's SSR sizing hints
use host style attributes in either mode. Classes mode needs the external CSS
asset allowed by the application's stylesheet policy.
