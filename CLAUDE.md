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
- The fork-era tokenizer and the vendored JS engine were removed
  (teardown per ADR 0009); the last full state is commit `e9c01db` in
  main's history. The npm package is a placeholder until the #30 re-port
  lands. Behavioral reference is the upstream mirror, not old code.
- Project language is US English (code, comments, commits, docs).
- Conventional commits without exception; release-please depends on them.

## Build and test

```sh
cargo test --workspace                       # Rust (also: fmt --check, clippy -D warnings)
cd node && pnpm install && pnpm run build:native
# Compat lanes are suspended until the #30 port produces a runtime;
# they then run with FERRIKI_HONEST_ALIAS=1 as the honest gate.
```

Rerun `build:native` after any Rust change before Node checks.

## Package facts

- Publishable package: `node/ferriki` (npm `ferriki`), ESM-only,
  Node >= 20 — currently a placeholder exposing only `ferrikiVersion()`.
- Publishing runs `pnpm publish` (catalog: specifiers must be rewritten;
  plain `npm publish` would leak them).
