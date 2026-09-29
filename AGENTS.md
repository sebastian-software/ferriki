# Ferriki - Agent Guidelines

## Orientation

- Read [`adr/README.md`](adr/README.md) for the decision index. The
  load-bearing ones: ADR 0003 (the upstream mirror is never hand-edited),
  ADR 0009 (native-only runtime), ADR 0010 (the mechanical vscode-textmate
  port), ADR 0012 (crate boundaries and release), ADR 0013 (CDN-loaded
  assets) and ADR 0014 (what the crates promise under semver).
- [`plans/native-only-migration.md`](plans/native-only-migration.md) records
  the migration history, including the measured decision to re-port the
  tokenizer (#30) and the cut-over scope (#31). It is context, not the
  backlog; see "Delivery source of truth" below.

## Hard rules

- **Never edit anything under `node/compat/upstream/`** — it contains
  mechanical mirrors of Shiki and vscode-textmate. Glue and Rust test adapters
  stay outside the mirrors.
- The fork-era tokenizer and vendored JS engine were removed (teardown per
  ADR 0009). The native TextMate port, Rust renderer, N-API binding, asset
  catalogs, and Node facade are the current runtime. Behavioral reference is
  the upstream mirror, not old code.
- Project language is US English (code, comments, commits, docs).
- Conventional commits without exception; release-please depends on them.
- ADRs are living documents. A change that makes a statement in an ADR false,
  or settles one of its open questions, updates that ADR in the same pull
  request (`Last updated` plus a dated `History` line). A new durable,
  cross-cutting decision gets a new ADR. `scripts/check-adrs.mjs` checks the
  index and the dates, not the content.
- `rust-version` in `Cargo.toml` is the only MSRV; every other mention is a
  derived copy.
- Record a cargo-deny finding as a narrow, commented exception in `deny.toml`.

## Build and test

```sh
cargo test --workspace                       # Rust (also: fmt --check, clippy -D warnings)
cd node && pnpm install && pnpm run build:native
# Mandatory release gate (includes the honest native compatibility checks)
pnpm run test:ferriki-compat:core
```

Rerun `build:native` after any Rust change before Node checks.

## Package facts

- Publishable package: `node/ferriki` (npm `@ferriki/core`, platform sidecars
  `@ferriki/<platform>`), ESM-only, Node >= 22.13.0, backed by the native Rust
  runtime and platform addon.
- Publishable crates: `ferriki` (the repository root package),
  `ferriki-textmate` and `ferriki-asset-gen`. They share one version with the
  npm package; Release Please (`release-type: rust`) bumps all of them and
  `publish.yml` publishes both registries via Trusted Publishing (ADR 0012).
  `ferriki-core` stays private.
- Publishing runs `pnpm publish` (catalog: specifiers must be rewritten;
  plain `npm publish` would leak them).

## Delivery source of truth

Current API and release work is tracked in the GitHub issues and epics for
Ferriki 1.0. Historical migration plans remain useful context, but they are
not a status ledger; check the linked issue before relying on an old finding.
