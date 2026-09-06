# Ferriki

Ferriki is Shiki-compatible syntax highlighting with a leaner Rust core and
Node bindings. The grammar interpreter is a mechanical port of vscode-textmate
onto [Ferroni](https://github.com/sebastian-software/ferroni); the Node layer
loads the native addon and the bundled standard languages and themes.

## Install

```sh
npm install ferriki
```

Ferriki requires Node.js 22.13.0 or newer and a supported platform binary.
The main package declares one optional native package for each supported target;
package managers select the matching OS/CPU/libc sidecar automatically. Keep
optional dependencies enabled in production installs unless you intentionally
ship the bundled main-package binary instead.

## Highlight code

Use a shorthand for one-off highlighting:

```js
import { codeToHtml } from 'ferriki'

const html = await codeToHtml('console.log("Hello")', {
  lang: 'javascript',
  theme: 'nord',
})
```

Reuse a highlighter when highlighting multiple snippets:

```js
import { createHighlighter } from 'ferriki'

using highlighter = await createHighlighter({
  langs: ['javascript', 'markdown'],
  themes: ['nord'],
})

const html = highlighter.codeToHtml('const answer = 42', {
  lang: 'javascript',
  theme: 'nord',
})

const tokens = highlighter.codeToTokens('# Hello', {
  lang: 'markdown',
  theme: 'nord',
})
```

For Ardo-style light/dark output, pass an ordered theme map. With
`defaultColor: false`, Ferriki emits CSS variables for every theme:

```js
const html = highlighter.codeToHtml('const answer = 42', {
  lang: 'typescript',
  themes: {
    light: 'vitesse-light',
    dark: 'vitesse-dark',
  },
  defaultColor: false,
})
```

`codeToHast` returns the same highlighted output as a HAST root. Languages
embedded by a grammar are loaded with it; lazy embeddings are loaded only
after an explicit `loadLanguage`.

Custom registrations use the same TextMate shapes as Shiki and are validated
before they cross the native boundary:

```js
using custom = await createHighlighter({
  langs: [{
    name: 'todo',
    scopeName: 'source.todo',
    aliases: ['todos'],
    patterns: [{ match: '\\bTODO\\b', name: 'keyword.todo' }],
  }],
  themes: [{
    name: 'todo-theme',
    type: 'light',
    fg: '#111111',
    bg: '#ffffff',
    settings: [{
      scope: 'keyword.todo',
      settings: { foreground: '#ff00aa', fontStyle: 'bold' },
    }],
  }],
})
```

Synchronous factories accept already-resolved names and registrations only;
promises and loader functions require `createHighlighter`.

Terminal ANSI input is intentionally outside Ferriki's 1.0 contract. Strip or
parse escape sequences before passing code to the highlighter; Ferriki rejects
`lang: 'ansi'` with `ShikiError` rather than emitting control bytes.

## Current API

The native runtime currently provides:

- `codeToHtml`, `codeToHast`, `codeToTokens`, and `codeToTokensBase`
- `createHighlighter`, `createHighlighterCore`, and their synchronous core
  constructor
- asynchronous and synchronous language and theme loading
- bundled standard TextMate grammars and themes
- deterministically enumerable `bundledLanguages` and `bundledThemes` loader maps
- `bundledLanguagesAlias`, mapping each bundled alias to its canonical language ID
- language aliases, lazy embedded languages, and external grammar injections
- validated custom TextMate grammar and theme registrations
- `ferrikiVersion` and the low-level `ferriki/native` binding loader

The renderer supports the classic single-theme structure and ordered
light/dark CSS-variable themes. ANSI escape sequences are rejected explicitly;
token explanations, grammar-state continuation, transformers, and decoration
adapters remain separately scoped facade work (see issues
[#47](https://github.com/sebastian-software/ferriki/issues/47) and
[#45](https://github.com/sebastian-software/ferriki/issues/45)).

For the complete retained API, option semantics, deliberate removals, and
error behavior, see the repository documentation:

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

Licensed under either of
[MIT](https://github.com/sebastian-software/ferriki/blob/main/LICENSE-MIT) or
[Apache-2.0](https://github.com/sebastian-software/ferriki/blob/main/LICENSE-APACHE)
at your option.

<!-- ferramenta-family:start -->
**ferriki** is part of the [Ferramenta](https://ferramenta.dev) family — Rust-native developer tools that keep the APIs the ecosystem already knows.

Siblings: [ferroni](https://sebastian-software.github.io/ferroni/) · [ferromark](https://sebastian-software.github.io/ferromark/) · [ferrolex](https://github.com/sebastian-software/ferrolex) · [ferrocat](https://ferrocat.dev) · [palamedes](https://palamedes.dev) · [ferrovia](https://github.com/sebastian-software/ferrovia) · [ferralk](https://github.com/sebastian-software/ferralk) · [ferrugo](https://github.com/sebastian-software/ferrugo).
<!-- ferramenta-family:end -->
