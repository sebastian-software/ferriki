# ferriki

Ferriki is a Shiki-compatible syntax highlighter backed by a native Rust
TextMate runtime. The grammar interpreter is a mechanical port of
vscode-textmate onto ferroni; the Node layer loads the native addon and the
bundled standard languages and themes.

## Install

```sh
npm install ferriki
```

Ferriki requires Node.js 20 or newer and a supported platform binary.

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
error behavior, see the repository's [Ferriki API reference](../../docs/ferriki-api.md)
and [Shiki migration guide](../../docs/migrations/shiki-to-ferriki.md). The
[compatibility policy](../../docs/compatibility.md) documents the exact Shiki
v4.4.3 baseline and supported CI targets; [troubleshooting](../../docs/troubleshooting.md)
covers native-loader and packed-install failures.

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

[MIT](https://github.com/sebastian-software/ferriki/blob/main/LICENSE)
