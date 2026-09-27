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

From the repository root:

```sh
cargo check -p ferriki-core
```

## License

Licensed under either of [MIT](../../LICENSE-MIT) or
[Apache-2.0](../../LICENSE-APACHE) at your option.
