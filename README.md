# Ferriki

Ferriki is a Rust-first syntax highlighting runtime with a Node binding and a
strict Shiki compatibility lane.

## Layout

- `crates/ferriki-core`: native runtime and N-API entrypoint
- `node/ferriki`: published npm package
- `node/compat/harness`: Ferriki-specific glue for the mirrored Shiki suite
- `node/compat/upstream/shiki`: strict upstream mirror used for compatibility verification

## Working In This Repo

Rust lives at the repository root:

```sh
cargo check -p ferriki-core
```

Node, npm, and the mirrored Shiki suite live under `node/`:

```sh
cd node
pnpm install
pnpm run build:native
pnpm run test:ferriki-compat:core
```

## Compatibility Policy

- Ferriki verifies against one approved Shiki release tag at a time.
- The mirrored upstream files under `node/compat/upstream/shiki` are not edited in place.
- Ferriki-specific adaptation lives only in `node/compat/harness` and the Ferriki product paths.

## License

[MIT](./LICENSE)
