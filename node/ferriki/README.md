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

## What This Package Includes

`ferriki` is the Node package for the highlighting runtime itself.

Included now:

- `createHighlighter`
- `codeToHtml`
- `codeToTokens`
- `codeToHast`
- the Node binding layer for the Rust core

Not included as product features:

- `twoslash`
- `markdown-it`
- `rehype`
- `vitepress-twoslash`
- `colorized-brackets`
- other ecosystem adapters mirrored only for compatibility tracking

Those areas may still appear in the mirrored upstream workspace under [`node/compat/upstream/shiki`](/Users/sebastian/Workspace/oss-released/ferriki/node/compat/upstream/shiki), but they are not part of the supported Ferriki package surface.

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

## Future Extension Direction

Ferriki is not trying to become a pile of JS wrappers around the Rust core.
If Ferriki adopts higher-level extensions later, the preferred direction is to
move the heavy lifting into Rust as well.

`Twoslash` is the most plausible future candidate, but it is not trivial:
its current model depends heavily on TypeScript compiler and language-service
behavior. Any Ferriki-native version would need a deliberate architecture of
its own instead of a thin copy of the existing JS integration.

## License

[MIT](../../LICENSE)
