# Ferriki - Claude Code Guidelines

## Orientation

- Read [`adr/README.md`](adr/README.md) for the decision index. The two
  load-bearing ones: ADR 0003 (the upstream mirror is never hand-edited)
  and ADR 0009 (native-only runtime; the bundled JS engine is deprecated).
  ADR 0010 defines the mechanical vscode-textmate port and crate boundary.
- The execution backlog lives in
  [`plans/native-only-migration.md`](plans/native-only-migration.md) —
  including the measured decision to re-port the tokenizer (#30) and the
  cut-over scope (#31).

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

## Build and test

```sh
cargo test --workspace                       # Rust (also: fmt --check, clippy -D warnings)
cd node && pnpm install && pnpm run build:native
# Mandatory release gate (includes the honest native compatibility checks)
pnpm run test:ferriki-compat:core
```

Rerun `build:native` after any Rust change before Node checks.

## Package facts

- Publishable package: `node/ferriki` (npm `ferriki`), ESM-only, Node >= 20,
  backed by the native Rust runtime and platform addon.
- Publishing runs `pnpm publish` (catalog: specifiers must be rewritten;
  plain `npm publish` would leak them).

## Delivery source of truth

Current API and release work is tracked in the GitHub issues and epics for
Ferriki 1.0. Historical migration plans remain useful context, but they are
not a status ledger; check the linked issue before relying on an old finding.
