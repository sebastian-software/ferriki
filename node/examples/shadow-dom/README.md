# Shadow DOM code element example

This consumer fixture covers a light-DOM baseline, the existing
`highlightedCode` property adapter, the default React `Code` macro, and a
separate manual reference registry. The property lane remains useful for
imperative consumers. The default macro renders a short `code-ref` host and,
on the server, includes prepared code in Declarative Shadow DOM (DSD). Vite adds
a shared stylesheet link directly to each DSD root, so the highlighted block
and its styles are available before JavaScript runs. No postprocessing call is
needed.

`ReferenceCode.mjs` accepts only the short reference and presentation props.
Trusted highlighted HTML stays in a separate registry:

```jsx
import { Code } from "@ferriki/core/react/macro";

<Code source={`const example = "build-prepared";\n`} language="ts" theme="dark" />;
```

The transformed `Code` macro has separate server and browser branches. The
server branch embeds the prepared HTML inside DSD with a compact reference
marker. During development, Vite serves the shared stylesheet at
`/@ferriki/code-elements.css`; production builds emit one hashed
`assets/ferriki-code-*.css` asset, and each shadow root links to that shared
stylesheet. The browser branch registers the reference once per module and
keeps the host itself empty, so parsing creates the DSD nodes before hydration
and hydration can preserve them.

For manual reference registries, `@ferriki/core/web-component/server` exports
`renderCodeElementShadows(markup, { blocks, stylesheetHref })`. The reference
fixture uses this lower-level helper separately from the default macro. In the
browser, register `defineCodeElement({ css, themeAliases, blocks })` before
hydrating. An unknown DSD reference keeps its server-rendered nodes and marked
stylesheet link until its block and CSS are registered. A matching reference
keeps its nodes when registration or hydration runs again. A changed reference
replaces the rendered code inside the existing shadow root.

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

The browser check covers both style modes, direct macro DSD with JavaScript
disabled, its stylesheet, source-derived sizing, and a two-line cap injected
into the temporary copy of the existing macro fixture. It also checks late
and partial block registration, hydration and retained DSD node identity,
reference changes, the property adapter, theme and parent updates, CSS
isolation, selection, copy, HMR, and source maps. The manual reference fixture
continues to exercise the standalone server helper and capped no-JavaScript
sizing. Chromium also runs the CDP accessibility-tree and `window.find`
checks. The demo command prints its local URL and runs until Ctrl+C. Both use
temporary consumers and do not modify workspace manifests or the lockfile.

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
