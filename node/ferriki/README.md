# Ferriki

[![npm version](https://img.shields.io/npm/v/%40ferriki%2Fcore.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@ferriki/core)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](https://github.com/sebastian-software/ferriki#license)
[![Node >= 22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg)](https://nodejs.org)

Ferriki is Shiki-compatible syntax highlighting with a leaner Rust core and
Node bindings. The grammar interpreter is a mechanical port of vscode-textmate
onto [Ferroni](https://github.com/sebastian-software/ferroni); the Node layer
loads the native addon and fetches the standard languages and themes on first
use from a release-pinned CDN.

## Install

```sh
npm install @ferriki/core
```

Ferriki requires Node.js 22.13.0 or newer and a supported platform binary.
The main package declares one optional native package for each supported target;
package managers select the matching OS/CPU/libc sidecar automatically. The
main package ships no native addon of its own, so keep optional dependencies
enabled in production installs.

The package ships no grammar or theme payloads either. The first time a
language or theme is loaded, Ferriki downloads it from `assets.ferriki.dev`,
pinned to this release and verified by SHA-256, and caches it in
`node_modules/.cache/ferriki`. Offline builds reuse a populated cache or point
`FERRIKI_ASSETS_BASE_URL` at a mirror; `FERRIKI_ASSETS_REMOTE=0` turns
downloads off. See [standard assets](https://github.com/sebastian-software/ferriki/blob/main/docs/ferriki-api.md#standard-assets).

## Highlight code

Use a shorthand for one-off highlighting:

```js
import { codeToHtml } from "@ferriki/core";

const html = await codeToHtml('console.log("Hello")', {
  lang: "javascript",
  theme: "nord",
});
```

Reuse a highlighter when highlighting multiple snippets:

```js
import { createHighlighter } from "@ferriki/core";

using highlighter = await createHighlighter({
  langs: ["javascript", "markdown"],
  themes: ["nord"],
});

const html = highlighter.codeToHtml("const answer = 42", {
  lang: "javascript",
  theme: "nord",
});
```

For Ardo-style light/dark output, pass an ordered theme map. With
`defaultColor: false`, Ferriki emits CSS variables for every theme:

```js
const html = highlighter.codeToHtml("const answer = 42", {
  lang: "typescript",
  themes: {
    light: "vitesse-light",
    dark: "vitesse-dark",
  },
  defaultColor: false,
});
```

`codeToHast` returns the highlighted result as a typed HAST root. Languages
embedded by a grammar load with it; lazy embeddings load only after an explicit
`loadLanguage`. Token APIs remain available for callers that need token lines,
explanations, or multi-theme token data.

Custom registrations use the same TextMate shapes as Shiki and are validated
before they cross the native boundary:

```js
using custom = await createHighlighter({
  langs: [
    {
      name: "todo",
      scopeName: "source.todo",
      aliases: ["todos"],
      patterns: [{ match: "\\bTODO\\b", name: "keyword.todo" }],
    },
  ],
  themes: [
    {
      name: "todo-theme",
      type: "light",
      fg: "#111111",
      bg: "#ffffff",
      settings: [
        {
          scope: "keyword.todo",
          settings: { foreground: "#ff00aa", fontStyle: "bold" },
        },
      ],
    },
  ],
});
```

Synchronous factories accept already-resolved names and registrations only;
promises and loader functions require `createHighlighter`.

Terminal ANSI input is intentionally outside Ferriki's 1.0 contract. Strip or
parse escape sequences before passing code to the highlighter; Ferriki rejects
`lang: 'ansi'` with `ShikiError` rather than emitting control bytes.

## Class-based output (next release)

Inspired by [GitHub's PrettyLights](https://github.com/wooorm/starry-night#what-is-prettylights)
and [wooorm's starry-night](https://github.com/wooorm/starry-night).

Use `styleMode: "classes"` for nested scope classes and custom CSS.
`codeToHtmlWithCss` returns `{ html, css }` using unchanged TextMate themes,
including theme maps that switch via `data-ferriki-theme` without retokenizing.
See the [class-based highlighting guide](https://github.com/sebastian-software/ferriki/blob/main/docs/class-highlighting.md) for examples and integration details.

## Supported API

HTML is the primary Node output: `codeToHtml` produces the highlighted markup,
and `styleMode: "classes"` adds nested scope classes; `codeToHtmlWithCss` also
returns the resolved CSS for stylesheet theming. `codeToHast`,
`codeToTokens`, `codeToTokensBase`, and `codeToTokensWithThemes` remain
available for consumers that need structured output.

The API also includes reusable highlighter factories, synchronous and
asynchronous language and theme loading, lazy standard assets, enumerable
language/theme catalogs, aliases, grammar injections, custom registrations,
CSS-variable themes, token explanations, grammar-state continuation,
transformers, and decorations. Transformers and decorations run in the
JavaScript facade (ADR 0008). ANSI escape sequences are rejected explicitly.

For the complete retained API, option semantics, deliberate removals, and
error behavior, see the repository documentation:

- [Ferriki 1.0 Node API contract](https://github.com/sebastian-software/ferriki/blob/main/docs/ferriki-1.0-api-contract.md)
- [Ferriki API reference](https://github.com/sebastian-software/ferriki/blob/main/docs/ferriki-api.md)
- [Shiki migration guide](https://github.com/sebastian-software/ferriki/blob/main/docs/migrations/shiki-to-ferriki.md)
- [Compatibility policy](https://github.com/sebastian-software/ferriki/blob/main/docs/compatibility.md) — the exact Shiki v4.4.3
  baseline and supported CI targets
- [Troubleshooting](https://github.com/sebastian-software/ferriki/blob/main/docs/troubleshooting.md) — native-loader and
  packed-install failures

## Compatibility

The TextMate interpreter is checked against the complete pinned
vscode-textmate v9.3.2 oracle. End-to-end behavior is checked through an
honestly aliased mirror of Shiki v4.4.3, including core highlighting, dynamic
loading, Markdown embeddings, Vue/SCSS lazy embeddings, and external
injections.

- [ADR 0009 — native-only runtime](https://github.com/sebastian-software/ferriki/blob/main/adr/0009-native-only-runtime.md)
- [ADR 0010 — mechanical vscode-textmate port](https://github.com/sebastian-software/ferriki/blob/main/adr/0010-mechanical-vscode-textmate-port.md)
- [Issue #30 — interpreter re-port](https://github.com/sebastian-software/ferriki/issues/30)

## License

Licensed under either of [MIT](https://github.com/sebastian-software/ferriki/blob/main/LICENSE-MIT)
or [Apache-2.0](https://github.com/sebastian-software/ferriki/blob/main/LICENSE-APACHE) at your option.

<!-- ferramenta-family:start -->

**ferriki** is part of the [Ferramenta](https://ferramenta.dev) family — A family of Rust tools.

Siblings: [ferroni](https://sebastian-software.github.io/ferroni/) — Oniguruma-compatible regex engine · [ferromark](https://sebastian-software.github.io/ferromark/) — Markdown to HTML with a secure default and every GFM extension included. · [ferrolex](https://github.com/sebastian-software/ferrolex) — Spell checking for text and code · [ferrocat](https://ferrocat.dev) — Translation catalog engine · [palamedes](https://palamedes.dev) — Internationalization for TypeScript applications · [ferrovia](https://github.com/sebastian-software/ferrovia) — SVGO-compatible SVG optimizer · [ferralk](https://github.com/sebastian-software/ferralk) — Glob matching and parallel filesystem walking · [ferrugo](https://github.com/sebastian-software/ferrugo) — PDF previews for untrusted files.
<!-- ferramenta-family:end -->
