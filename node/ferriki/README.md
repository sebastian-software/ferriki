# ferriki

`ferriki` is the Node-facing package for Ferriki.

It aims to stay compatible with the Shiki-style highlighting API while moving
runtime behavior into a Rust core. The practical goal is to preserve familiar
entrypoints such as `createHighlighter`, `codeToHtml`, and related helpers,
without keeping the historical JS/WASM runtime structure alive as part of the
product.

## Why Use It

- Familiar API surface for existing Shiki-oriented integrations
- Native Rust core instead of layered JS/WASM engine plumbing
- Leaner runtime shape with less product complexity in JavaScript
- Compatibility checked against a mirrored upstream Shiki suite

## Repository Status

This package is the canonical Node package path inside the Ferriki repository.
It builds its native addon against [`crates/ferriki-core`](/Users/sebastian/Workspace/oss-released/ferriki/crates/ferriki-core).

Current expected workflow:

```sh
cd /Users/sebastian/Workspace/oss-released/ferriki/node
pnpm install
pnpm run build:native
```

## Intended API Shape

Ferriki is built around the same high-level contract people expect from Shiki:

- `createHighlighter`
- `codeToHtml`
- `codeToTokens`
- `codeToHast`

Internally, those outputs are intended to be defined by the Rust core, not by a
thick JavaScript orchestration layer.

## License

[MIT](../../LICENSE)
