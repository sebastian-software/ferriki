# ferriki-core

`ferriki-core` is the unpublished N-API host behind the Ferriki Node package.
Its native methods call the shared [`ferriki`](../../README.md) Rust
runtime and map typed Rust errors to N-API errors. It does not own a separate
grammar, theme, tokenizer, asset, or HTML implementation.

The public Rust highlighter API, lifecycle, asset loading, and Ferromark
adapter contract are documented in [`docs/rust-api.md`](../../docs/rust-api.md).
The Node API contract remains in
[`docs/ferriki-1.0-api-contract.md`](../../docs/ferriki-1.0-api-contract.md).

## Development

From the repository root (materialize test payloads first; see
[`CONTRIBUTING.md`](../../CONTRIBUTING.md)):

```sh
node scripts/materialize-assets.mjs --payloads
cargo check -p ferriki-core
cargo test -p ferriki-core
```

Standalone Rust tests resolve Node-API symbols dynamically through `napi`'s
`dyn-symbols` dev-dependency feature in `Cargo.toml`.

To install Node workspace dependencies, build the release `.node` addon, and
copy it into `node/ferriki/` and the host's platform package under
`node/platforms/`:

```sh
cd node && pnpm install --ignore-scripts && pnpm run build:native
```

The optional `profiling` Cargo feature (`--features profiling`) adds
`profileTokenBoundary` and a counting allocator for
`node/scripts/profile-native-boundary.mjs`. Release addons never enable it.

## License

Licensed under either of [MIT](../../LICENSE-MIT) or
[Apache-2.0](../../LICENSE-APACHE) at your option.
