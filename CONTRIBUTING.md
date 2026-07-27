# Contributing to Ferriki

## Prerequisites

- Rust (stable toolchain with `cargo`, `clippy`, `rustfmt`)
- Node.js >= 20
- pnpm (the pinned version in `node/package.json` is picked up via corepack)

## The happy path

```sh
# Rust checks (fmt, clippy, tests — all gated in CI)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Node workspace: install, build the native addon, run the release gate
cd node
pnpm install
pnpm run build:native
pnpm run test:ferriki-compat:textmate
```

`build:native` compiles `crates/ferriki-core` in release mode and copies
the addon into `node/ferriki/` — rerun it after any Rust change before
running the Node lanes.

## Test lanes

| Lane | Command | Purpose |
| --- | --- | --- |
| TextMate inner oracle | `cargo test -p ferriki-textmate` (repository root) | Exact vscode-textmate v9.3.2 grammar semantics |
| Native structural compat | `pnpm run test:ferriki-compat:textmate` (from `node/`) | Issue #30 gate against unchanged Shiki v4.3.1 tests |
| Full core facade | `pnpm run test:ferriki-compat:core` (from `node/`) | Broader issue #31 API parity |
| Adapter compat | `pnpm run test:ferriki-compat:adapters` (from `node/`) | Optional adapter behavior outside the core product boundary |
| Colorized brackets | `pnpm run test:ferriki-compat:colorized-brackets` (from `node/`) | Manual optional-package check |

The TextMate structural lane sets `FERRIKI_HONEST_ALIAS=1`, which routes the
mirrored tests' remaining upstream imports through Ferriki as well. Its
20 selected behavior tests cover core highlighting, loaders, aliases,
Markdown embeddings, lazy Vue/SCSS embeddings, and external injections. The
full core facade lane intentionally has a broader scope and tracks the
remaining work in issue #31.

## The upstream mirrors are never hand-edited

Everything under `node/compat/upstream/` is a mechanical mirror of an approved
upstream release. Do not edit mirrored files; Ferriki-specific glue and Rust
test adapters live outside the mirrors.

- Shiki's source of truth is `node/compat/upstream/shiki/.source.json`; use
  `node/scripts/sync-shiki-compat.mjs` to update or verify it.
- vscode-textmate's source of truth is
  `node/compat/upstream/vscode-textmate/.source.json`; use
  `node/scripts/sync-vscode-textmate-oracle.mjs` with a local upstream checkout
  to update it or with `--check` to verify it.

ADR 0003 records the general strict-mirror policy. ADR 0010 applies it to the
mechanical tokenizer port.

## Commits and releases

Use conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `ci:`,
`chore:` — scopes like `fix(node):` are fine). release-please derives
versions and changelogs from them; the publishable package is
`node/ferriki`, released through the shared ferramenta workflow with
multi-platform binaries and npm Trusted Publishing.

## Where things are decided

- Architectural decisions: [`adr/`](adr/) (see the index in
  [`adr/README.md`](adr/README.md))
- Execution backlog: [`plans/`](plans/), currently centered on
  [`plans/native-only-migration.md`](plans/native-only-migration.md)
- Project language is US English, everywhere.
