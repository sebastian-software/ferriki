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
