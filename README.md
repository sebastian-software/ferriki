# Ferriki

Ferriki is a Shiki-compatible highlighter with a leaner Rust core.

It keeps the API shape people already know from Shiki, but removes the old
JS/WASM multi-engine direction from the runtime. The goal is simple: keep the
developer experience familiar, move the heavy lifting into Rust, and end up
with a smaller, cleaner architecture that is easier to reason about and easier
to ship.

## Why Ferriki

- Shiki-compatible where it matters: existing highlighting-oriented Node APIs stay recognizable.
- Rust-first by design: grammar handling, theme application, state management, and rendering belong in the native core.
- Leaner runtime shape: no product dependency on the historical JS/WASM engine stack.
- Verifiable compatibility: the Node layer is checked against a strict mirrored Shiki release-tag suite.

Ferriki is for teams that like the Shiki contract, but want a cleaner native
foundation under it.

## Products

This repository currently has two primary product surfaces:

- [`crates/ferriki-core`](/Users/sebastian/Workspace/oss-released/ferriki/crates/ferriki-core): the Rust runtime and N-API host layer
- [`node/ferriki`](/Users/sebastian/Workspace/oss-released/ferriki/node/ferriki): the Node-facing package surface

Everything else exists to support validation, compatibility, and repository
maintenance.

## Repository Layout

- [`crates/ferriki-core`](/Users/sebastian/Workspace/oss-released/ferriki/crates/ferriki-core): native runtime
- [`node/ferriki`](/Users/sebastian/Workspace/oss-released/ferriki/node/ferriki): Node package
- [`node/compat/harness`](/Users/sebastian/Workspace/oss-released/ferriki/node/compat/harness): Ferriki-specific compatibility glue
- [`node/compat/upstream/shiki`](/Users/sebastian/Workspace/oss-released/ferriki/node/compat/upstream/shiki): strict upstream Shiki mirror
- [`adr`](/Users/sebastian/Workspace/oss-released/ferriki/adr): architecture decision records

The repository root is intentionally Rust-first. All Node, npm, and upstream
compatibility machinery lives under [`node`](/Users/sebastian/Workspace/oss-released/ferriki/node).

## Quick Start

Rust:

```sh
cargo check -p ferriki-core
```

Node:

```sh
cd node
pnpm install
pnpm run build:native
pnpm run test:ferriki-compat:core
```

Optional ecosystem checks stay outside the release gate:

```sh
cd node
pnpm run test:ferriki-compat:adapters
```

## Compatibility

Ferriki tracks one approved Shiki release tag at a time.

- Upstream-derived files under [`node/compat/upstream/shiki`](/Users/sebastian/Workspace/oss-released/ferriki/node/compat/upstream/shiki) are mirrored, not hand-edited.
- Ferriki-specific behavior lives outside that mirror, mainly in [`node/compat/harness`](/Users/sebastian/Workspace/oss-released/ferriki/node/compat/harness) and the Ferriki product paths.
- “Shiki-compatible” in this repository means compatibility is intended to be checked, not just claimed.

## Status

Ferriki is in active restructuring. The core direction is fixed:

- Rust owns runtime behavior
- Node is the compatibility and host layer
- optional ecosystem adapters do not define the core product boundary or release gate

## License

[MIT](./LICENSE)
