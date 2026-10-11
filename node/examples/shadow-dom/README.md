# Shadow DOM code element example

This consumer fixture covers four presentations of the same prepared Ferriki
code: a light-DOM baseline, the existing `highlightedCode` property adapter, an
empty reference-backed React host, and a reference host completed with
Declarative Shadow DOM (DSD). The property lane remains useful for imperative
consumers. The default React `Code` macro now emits a short `code-ref`; a server
postprocessor can add DSD so highlighted text and styles are present before
JavaScript runs.

`ReferenceCode.mjs` accepts only the short reference and presentation props.
Trusted highlighted HTML stays in a separate registry:

```jsx
import { Code } from "@ferriki/core/react/macro";

<Code source={`const example = "build-prepared";\n`} language="ts" theme="dark" />;
```

For Vite SSR, `api.renderCodeElements(markup, { stylesheetHref })` resolves
references collected by the transformed `Code` macro, adds one marked
stylesheet link per DSD root, and inserts the prepared HTML. Serve the shared
CSS from `api.codeElementCss()` at the URL passed as `stylesheetHref`:

```js
const html = ferrikiPlugin.api.renderCodeElements(renderedMarkup, {
  stylesheetHref: "/ferriki-code.css",
});
const css = ferrikiPlugin.api.codeElementCss();
```

The standalone `@ferriki/core/web-component/server` helper supports manual
reference registries. In the browser, register `defineCodeElement({ css,
themeAliases, blocks })` before hydrating. An unknown DSD reference keeps its
server-rendered nodes and marked stylesheet link until its block and CSS are
registered. A matching reference keeps its nodes when registration or
hydration runs again. A changed reference replaces the rendered code inside
the existing shadow root.

The reference fixture also exercises the low-level `max-lines` host attribute.
Its source-derived `codeElementSizing(lineCount, maxLines)` style reserves the
capped height before JavaScript; after registration, the shadow `<pre>` keeps
the same cap, scrolls to later lines, and receives keyboard focus when capped.
The browser check grows and removes the cap while checking that the host and
code nodes remain in place.

The property adapter remains available through
`@ferriki/core/web-component`. Call
`defineCodeElement({ css, themeAliases })`, then assign trusted Ferriki markup
through the `highlightedCode` property. Its server output includes readable
source fallback children; those children remain React-owned. Ferriki shares
constructed stylesheets between matching elements in a document. The shadow
tree isolates page selectors, but it is not a security boundary.

After the normal workspace install, run from `node/` with the pinned temporary
dependencies:

```sh
set -eu
shadow_spike_deps="$(mktemp -d)"
npm install --prefix "$shadow_spike_deps" \
  react@19.3.0 react-dom@19.3.0 scheduler@0.28.0 playwright@1.63.0
"$shadow_spike_deps/node_modules/.bin/playwright" install chromium firefox webkit
pnpm run build:native
FERRIKI_SHADOW_BENCH_DEPS_ROOT="$shadow_spike_deps" \
  node scripts/check-shadow-dom-spike.mjs --browsers chromium,firefox,webkit
FERRIKI_SHADOW_BENCH_DEPS_ROOT="$shadow_spike_deps" \
  pnpm run demo:shadow-dom
```

The browser check covers both style modes, no-JavaScript DSD output, late and
partial block registration, hydration and node identity, reference changes,
the property adapter, theme and parent updates, CSS isolation, selection,
copy, HMR, and source maps. Chromium also runs the CDP accessibility-tree and
`window.find` checks. The demo command prints its local URL and runs until
Ctrl+C. Both use temporary consumers and do not modify workspace manifests or
the lockfile.

On macOS 27, Playwright's bundled Firefox may exit with `Could not find profile
folder` because Gecko cannot access Firefox's shared app-data directory when
launched from a terminal ([Playwright issue #42768](https://github.com/microsoft/playwright/issues/42768)).
For a single check, use a fresh invocation-scoped `CFFIXED_USER_HOME` without
changing `HOME` or persistent shell configuration:

```sh
firefox_spike_home="$(mktemp -d)"
CFFIXED_USER_HOME="$firefox_spike_home" \
FERRIKI_SHADOW_BENCH_DEPS_ROOT="$shadow_spike_deps" \
  node scripts/check-shadow-dom-spike.mjs --browsers firefox
```

The production benchmark is separate from browser correctness checks. It
preserves the historical property-lane result and adds reference and DSD lanes
for inline and class styles across one-large and twelve-mixed workloads. Its
DSD server-render interval includes helper postprocessing. Browser timings are
elapsed wall-clock intervals to a React commit boundary; they do not isolate
React CPU time or imply that React traverses the shadow tree. See the
[benchmark report](../../benchmarks/shadow-dom-spike/README.md).
