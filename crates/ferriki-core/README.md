# ferriki-core

`ferriki-core` is Ferriki's Rust runtime crate.

It owns the native side of highlighting: grammar loading, theme handling,
runtime state, tokenization, rendering, and the N-API boundary used by the Node
package.

## Role In The Architecture

Ferriki is intentionally split like this:

- `ferriki-core`: native runtime and binding surface
- `node/ferriki`: Node package and compatibility-facing entrypoint
- `ferroni`: external regex dependency, not a vendored repository component

The design target is that runtime behavior is defined here first. JavaScript is
there to load the addon, expose the public API, and keep compatibility stable,
not to reimplement the highlighter.

## Scope Boundary

`ferriki-core` is the native home of the highlighting runtime.
It does not currently implement ecosystem adapters like `twoslash`,
`markdown-it`, `rehype`, `vitepress-twoslash`, or `colorized-brackets`.

That boundary is intentional. Ferriki would rather keep those areas out of the
product than rebuild the old JS-heavy architecture around the core again.

If Ferriki expands into higher-level features later, the preferred direction is
to build them as native lanes here instead of treating Rust as a token producer
and JavaScript as the real runtime.

`Twoslash` is the strongest candidate for a later native lane, but it is also
the hardest one because it depends on TypeScript compiler and language-service
behavior, not just on highlighted output.

## Current Status

This crate is repository-owned but not yet positioned as a separately published
crate. For now it is the internal native core behind the Ferriki Node package.

## Development

From the repository root:

```sh
cargo check -p ferriki-core
```

## License

[MIT](../../LICENSE)
