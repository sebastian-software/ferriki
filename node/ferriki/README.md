# ferriki

Shiki-compatible syntax highlighting for Node.js with a native Rust core.

Ferriki keeps the Shiki API you already use — `createHighlighter`,
`codeToHtml`, `codeToHast`, `codeToTokens` — and moves the highlighting
runtime into Rust. Compatibility is verified against a mirrored upstream
Shiki test suite on every change.

## Install

```sh
npm install ferriki
```

Requires Node.js >= 20 (matching upstream shiki@4). The package is ESM-only.

## Quick start

```js
import { codeToHtml } from 'ferriki'

const html = await codeToHtml('const x = 1', {
  lang: 'js',
  theme: 'nord',
})
```

All bundled Shiki languages and themes are available out of the box.

## Backend selection

Ferriki ships two engines: the native Rust core and a JS fallback. The
backend is selected via an environment variable:

| Setting | Effect |
| --- | --- |
| unset | Native Rust core when a platform binary is available, JS engine otherwise (default) |
| `FERRIKI_BACKEND=rust` | Force the native Rust core (throws if no platform binary loads) |
| `FERRIKI_BACKEND=js` | Force the JS engine |

`SHIKI_BACKEND` is supported as a deprecated alias; `FERRIKI_BACKEND`
takes precedence.

## Platform support

Native binaries are built for linux-x64, linux-arm64, darwin-x64,
darwin-arm64, and win32-x64. On other platforms the JS engine keeps
everything working — highlighting output is identical, just slower.

## Shiki compatibility

- Compatibility target: the upstream Shiki 4.0.x line (mirrored suite:
  [v4.0.1](https://github.com/sebastian-software/ferriki/tree/main/node/compat/upstream/shiki)).
- The main entry (`import ... from 'ferriki'`) covers the full `shiki`
  main-entry surface.
- Supported subpaths for drop-in aliasing: `ferriki/core`, `ferriki/langs`,
  `ferriki/themes`, `ferriki/types`, `ferriki/engine/javascript`,
  `ferriki/engine/oniguruma`. Not exposed: `shiki/wasm`, `shiki/textmate`,
  and the `shiki/bundle/*` entries.
- Ecosystem adapters (`markdown-it`, `rehype`, VitePress integrations,
  `colorized-brackets`) are intentionally out of package scope — they sit
  on top of `codeToHtml`/`codeToHast` and keep working against those
  outputs.

## Bundler note

Ferriki is a Node-only package that loads a native addon and reads asset
catalogs from disk. Keep it external in bundlers (e.g. Vite/Rollup
`external`, Next.js `serverExternalPackages`).

## Development

Ferriki is developed in the
[sebastian-software/ferriki](https://github.com/sebastian-software/ferriki)
repository (Rust core in `crates/`, this package under `node/ferriki`).
Build and test instructions live in the repository README; architectural
decisions are documented as
[ADRs](https://github.com/sebastian-software/ferriki/tree/main/adr).

## License

[MIT](https://github.com/sebastian-software/ferriki/blob/main/LICENSE)
