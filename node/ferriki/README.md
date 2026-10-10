# Ferriki

[![npm version](https://img.shields.io/npm/v/%40ferriki%2Fcore.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@ferriki/core)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](https://github.com/sebastian-software/ferriki#license)
[![Node >= 22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg)](https://nodejs.org)

Ferriki is native syntax highlighting with HTML and CSS-class output for
Node.js: Shiki's HTML API, grammars and themes on a Rust engine. Shiki brought
editor-grade highlighting to the web; Ferriki runs the same TextMate grammars
on a Rust port of VS Code's tokenizer and [Ferroni](https://ferroni.dev),
Oniguruma in Rust, without WebAssembly or regex translation. Ferriki is in
beta: until 1.0, a minor release can change the API.

**Load once. Highlight block after block.** On our 14-file Blacksmith corpus,
reused Ferriki highlighters produced identical HTML to both Shiki engines,
running **4.7× faster than Shiki/WASM on Linux x86-64** and **5.5× on macOS
ARM64**. These factors describe the measured corpus and machines. The
[benchmarks](https://ferriki.dev/evidence/benchmarks) include both hosts,
first-use timings, JSON/Astro and the committed raw reports.

## Install

```sh
npm install @ferriki/core
```

Ferriki requires Node.js 22.13.0 or newer and is ESM-only. The package declares
one optional native package for each supported target (Linux x64 and arm64 with
glibc or musl, macOS arm64, Windows x64 and arm64), and the package manager
installs the matching one. The main package ships no native addon of its own,
so keep optional dependencies enabled in production installs.

The package ships no grammar or theme payloads either. The first time a
language or theme is loaded, Ferriki downloads it from `assets.ferriki.dev`,
pinned to this release and verified by SHA-256, and caches it in
`node_modules/.cache/ferriki`. Offline builds reuse a populated cache or point
`FERRIKI_ASSETS_BASE_URL` at a mirror; `FERRIKI_ASSETS_REMOTE=0` turns
downloads off. See [asset loading](https://github.com/sebastian-software/ferriki/blob/main/docs/asset-loading.md)
for cache, proxy and certificate settings.

## Highlight code

Use the shorthand for one-off highlighting:

```js
import { codeToHtml } from "@ferriki/core";

const html = await codeToHtml('console.log("Hello")', {
  lang: "javascript",
  theme: "nord",
});
```

## Reuse a highlighter

A highlighter loads its languages and themes once; calls on it are synchronous.
Keep the highlighter for the lifetime of a CMS worker or site build. The
`codeToHtml()` shorthand also reuses a process-local singleton.
Call `highlighter.dispose()` when you are done, or declare it with `using` in
TypeScript:

```js
import { createHighlighter } from "@ferriki/core";

const highlighter = await createHighlighter({
  langs: ["javascript", "typescript"],
  themes: ["vitesse-light", "vitesse-dark"],
});

const html = highlighter.codeToHtml("const answer = 42", {
  lang: "typescript",
  theme: "vitesse-dark",
});
```

`getSingletonHighlighter()` shares one highlighter per process, and the
shorthand functions use it. Custom languages and themes take Shiki's TextMate
registration shapes in `langs` and `themes` and are validated before they reach
the native engine. Languages embedded by a grammar load with it; lazy
embeddings load after an explicit `loadLanguage`. The synchronous factories
accept already-resolved names and registrations only.

Keep the default regex prefilter for repeated work. For a short-lived
highlighter, pass `regexPrefilter: false` to `createHighlighter()` to skip
prefilter construction. This is a creation-time choice, with unchanged output.
The [prefilter guide](https://github.com/sebastian-software/ferriki/blob/main/docs/ferriki-api.md#choosing-the-regex-prefilter)
covers the measured setup/reuse tradeoff and the singleton's configuration.

## Light and dark themes

Pass an ordered theme map. With `defaultColor: false`, Ferriki emits CSS
variables for every theme and leaves the choice to your stylesheet:

```js
const html = highlighter.codeToHtml("const answer = 42", {
  lang: "typescript",
  themes: { light: "vitesse-light", dark: "vitesse-dark" },
  defaultColor: false,
});
```

## Class-based output

`styleMode: "classes"` renders every grammar scope as a nested span with
readable classes such as `tok-string`, for your own stylesheet.
`codeToHtmlWithCss` returns `{ html, css }` with the CSS derived from unchanged
TextMate themes. With a theme map, `data-ferriki-theme="dark"` on the block or
an ancestor switches themes without highlighting again:

```js
import { codeToHtmlWithCss } from "@ferriki/core";

const { html, css } = await codeToHtmlWithCss("const answer = 42", {
  lang: "typescript",
  themes: { light: "github-light", dark: "github-dark" },
});
```

The mode is inspired by GitHub's PrettyLights and wooorm's
[starry-night](https://github.com/wooorm/starry-night). The
[class-based highlighting guide](https://github.com/sebastian-software/ferriki/blob/main/docs/class-highlighting.md)
covers the class names, custom CSS and theme switching.

## Transformers

Shiki transformers and decorations run in JavaScript while Ferriki renders
HTML, and their callbacks receive typed token and HAST data. The notation
helpers from `@shikijs/transformers` for focus, highlights, diffs and word
highlights work with them.

## Build-time macros

[`@ferriki/vite`](https://github.com/sebastian-software/ferriki/tree/main/node/vite)
turns `code()` from `@ferriki/core/macro` and `<Code />` from
`@ferriki/core/react/macro` into highlighted HTML and CSS during a Vite 8
build, so the browser receives neither a grammar nor a highlighter. Install it
with the same version as this package:

```sh
npm install @ferriki/core @ferriki/vite
```

See the [inline code macros guide](https://github.com/sebastian-software/ferriki/blob/main/docs/inline-code-macros.md).

## Rust

The same engine is the [`ferriki`](https://crates.io/crates/ferriki) crate; see
the [Rust API guide](https://github.com/sebastian-software/ferriki/blob/main/docs/rust-api.md).

## Compatibility

Ferriki follows Shiki v4.4.3. Shiki's own tests run unchanged against the
native addon from a pinned mirror, each one classified as supported, deferred
or out of scope, and the tokenizer is checked against the complete
vscode-textmate v9.3.2 oracle. HTML is the package's output; token and HAST
data reach transformer callbacks. Terminal ANSI input is rejected with
`ShikiError` instead of rendered.

## Documentation

- [Ferriki API reference](https://github.com/sebastian-software/ferriki/blob/main/docs/ferriki-api.md)
- [Shiki migration guide](https://github.com/sebastian-software/ferriki/blob/main/docs/migrations/shiki-to-ferriki.md)
- [Compatibility policy](https://github.com/sebastian-software/ferriki/blob/main/docs/compatibility.md): the Shiki baseline and the supported targets
- [Troubleshooting](https://github.com/sebastian-software/ferriki/blob/main/docs/troubleshooting.md): native-loader and offline failures
- [Code example authoring](https://github.com/sebastian-software/ferriki/blob/main/docs/code-example-authoring.md): focus, highlights, diffs and copy behavior
- [ferriki.dev](https://ferriki.dev): guides and benchmarks

## License

Licensed under either of [MIT](https://github.com/sebastian-software/ferriki/blob/main/LICENSE-MIT)
or [Apache-2.0](https://github.com/sebastian-software/ferriki/blob/main/LICENSE-APACHE) at your option.

<!-- ferramenta-family:start -->

**ferriki** is part of the [Ferramenta](https://ferramenta.dev) family — A family of Rust tools.

Siblings: [ferroni](https://ferroni.dev) — Oniguruma-compatible regex engine · [ferromark](https://ferromark.dev) — Markdown to HTML, sanitized by default · [ferrolex](https://github.com/sebastian-software/ferrolex) — Spell checking for text and code · [ferrocat](https://ferrocat.dev) — Translation catalog engine · [ferralk](https://github.com/sebastian-software/ferralk) — Glob matching and parallel filesystem walking · [ferrugo](https://github.com/sebastian-software/ferrugo) — PDF previews for untrusted files · [palamedes](https://palamedes.dev) — Internationalization for TypeScript applications · [dalo](https://dalo.sh) — Your team's agent setup, versioned like code · [ardo](https://ardo-docs.dev) — Documentation sites built with React.
<!-- ferramenta-family:end -->
