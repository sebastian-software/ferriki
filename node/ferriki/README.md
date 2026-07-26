# ferriki

**Placeholder release.** Ferriki — a Shiki-compatible syntax highlighter
with a native Rust core — is currently being rebuilt as a native-only
runtime, and this package version intentionally ships no highlighting
API.

## What is happening

The original incremental port kept a bundled JavaScript engine as
scaffolding. An honest compatibility measurement against the mirrored
upstream Shiki suite showed structural defects in that transitional
tokenizer, so the core is being re-ported properly: a mechanical 1:1
port of [vscode-textmate](https://github.com/microsoft/vscode-textmate)
onto [ferroni](https://github.com/sebastian-software/ferroni)'s
Oniguruma-compatible Scanner API, verified against the upstream test
suites.

- Decision record: [ADR 0009 — native-only runtime](https://github.com/sebastian-software/ferriki/blob/main/adr/0009-native-only-runtime.md)
- Re-port: [sebastian-software/ferriki#30](https://github.com/sebastian-software/ferriki/issues/30)
- Facade and cut-over: [sebastian-software/ferriki#31](https://github.com/sebastian-software/ferriki/issues/31)

## What this version provides

```js
import { ferrikiVersion } from 'ferriki'

ferrikiVersion() // version of the bundled native core, if a platform binary loads
```

Nothing else — use [shiki](https://www.npmjs.com/package/shiki) until the
native runtime ships. The Shiki-compatible API (`codeToHtml`,
`codeToHast`, `codeToTokens`, `createHighlighter`) returns with the
re-port, verified against the mirrored Shiki v4.3.1 suite.

## License

[MIT](https://github.com/sebastian-software/ferriki/blob/main/LICENSE)
