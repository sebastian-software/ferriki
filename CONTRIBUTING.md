# Contributing to Ferriki

## Prerequisites

- Rust (stable toolchain with `cargo`, `clippy`, `rustfmt`)
- Node.js >= 20
- pnpm (the pinned version in `node/package.json` is picked up via corepack)

## The happy path

```sh
# Rust checks (fmt, clippy, tests — all gated in CI)
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Node workspace: install, build the native addon, run the release gate
cd node
pnpm install
pnpm run build:native
pnpm run test:ferriki-compat:core
```

`build:native` compiles `crates/ferriki-core` in release mode and copies
the addon into `node/ferriki/` — rerun it after any Rust change before
running the Node lanes.

## Test lanes

| Lane | Command (from `node/`) | Gates releases? |
| --- | --- | --- |
| Core compat | `pnpm run test:ferriki-compat:core` | Yes |
| Adapter compat | `pnpm run test:ferriki-compat:adapters` | Yes |
| Colorized brackets | `pnpm run test:ferriki-compat:colorized-brackets` | No (manual) |

The lanes run the mirrored upstream Shiki suite with
`FERRIKI_BACKEND=rust`. Additionally, `FERRIKI_HONEST_ALIAS=1` routes the
mirrored tests' remaining upstream imports through Ferriki as well — this
is the honest measurement mode used by the native-only migration (see
`plans/native-only-migration.md`); expect known failures there.

## The mirror is never hand-edited

Everything under `node/compat/upstream/` is a mechanical mirror of an
approved upstream release (currently Shiki v4.0.1; source of truth:
`node/compat/upstream/shiki/.source.json`). Do not edit mirrored files —
Ferriki-specific glue lives in `node/compat/harness/`. To update or
verify the mirror, use `node/scripts/sync-shiki-compat.mjs` (it has a
`--check` mode). ADR 0003 records the policy.

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
