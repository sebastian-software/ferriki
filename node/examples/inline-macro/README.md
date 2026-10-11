# Inline macro consumer fixture

This React fixture covers both the `code()` descriptor API and the `Code` JSX
macro. The first route exercises the macro's built-in Declarative Shadow DOM
SSR output and shared stylesheet; the lazy second
route uses a render function that explicitly forwards the prepared descriptor
and `className` to a custom component. Both
routes render on the server, hydrate in the browser and exercise navigation,
copying original source and HMR for inline code. The custom component owns its
copy control and renders the descriptor's `html`.

The fixture is exercised against real packed core, native sidecar and Vite
tarballs by `node/scripts/check-inline-macro-browser.mjs`. Its dependencies are
installed in an isolated temporary consumer; this directory is not another
publishable Ferriki package.

After the repository's normal native build, run from `node/`:

```sh
pnpm dlx playwright@1.63.0 install --with-deps chromium
pnpm run check:inline-macro
```

The script checks classes on the default `<ferriki-code>` host, renderer prop forwarding,
hydration and navigation, clipboard source text, theme and
line CSS, HMR, source maps and the production browser module graph. It closes
its browser/server and removes its own temporary consumer when finished.
See the [macro guide](../../../docs/inline-code-macros.md) for the supported
authoring contract and release availability.
The [code element fixture](../shadow-dom/README.md) checks shadow-root node
identity, early/late registration, client-only mounting, and browser lifecycle.
