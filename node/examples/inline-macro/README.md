# Inline macro consumer fixture

This React fixture consumes prepared `ferrikiCode` descriptors through a custom
code-block component. It renders the first page on the server, hydrates it,
navigates to a lazily loaded second page and accepts updates to that page's
inline code. The component copies `block.code` and renders `block.html`.

The fixture is exercised against real packed core, native sidecar and Vite
tarballs by `node/scripts/check-inline-macro-browser.mjs`. Its dependencies are
installed in an isolated temporary consumer; this directory is not another
publishable Ferriki package.

After the repository's normal native build, run from `node/`:

```sh
pnpm dlx playwright@1.63.0 install --with-deps chromium
pnpm run check:inline-macro
```

The script checks hydration and navigation, clipboard source text, theme and
line CSS, HMR, source maps and the production browser module graph. It closes
its browser/server and removes its own temporary consumer when finished.
See the [macro guide](../../../docs/inline-code-macros.md) for the supported
authoring contract and release availability.
