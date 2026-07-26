# Ferriki - Claude Code Guidelines

## Orientation

- Read [`adr/README.md`](adr/README.md) for the decision index. The two
  load-bearing ones: ADR 0003 (the upstream mirror is never hand-edited)
  and ADR 0009 (native-only runtime; the bundled JS engine is deprecated).
- The execution backlog lives in
  [`plans/native-only-migration.md`](plans/native-only-migration.md) —
  including the measured decision to re-port the tokenizer (#30) and the
  cut-over scope (#31).

## Hard rules

- **Never edit anything under `node/compat/upstream/`** — it is a
  mechanical mirror of Shiki v4.0.1. Glue goes in `node/compat/harness/`.
- `crates/ferriki-core`'s tokenizer is a frozen reference implementation
  pending the #30 re-port — fix bugs only when a release needs it, do not
  invest in polish there.
- Project language is US English (code, comments, commits, docs).
- Conventional commits without exception; release-please depends on them.

## Build and test

```sh
cargo test --workspace                       # Rust (also: fmt --check, clippy -D warnings)
cd node && pnpm install && pnpm run build:native
pnpm run test:ferriki-compat:core            # release gate, FERRIKI_BACKEND=rust
pnpm run test:ferriki-compat:adapters        # release gate
FERRIKI_HONEST_ALIAS=1 ...                   # honest mode: routes ALL mirrored imports through ferriki (known failures)
```

Rerun `build:native` after any Rust change before Node lanes. The
compat lanes without `FERRIKI_HONEST_ALIAS` do NOT fully exercise the
native path (see plan, Finding 0).

## Package facts

- Publishable package: `node/ferriki` (npm `ferriki`), ESM-only,
  Node >= 20. `dist/` is currently a checked-in bundle without sources
  (#10) — edit it only via scripted, verifiable transformations.
- Backend selection: `FERRIKI_BACKEND=rust|js` (default: rust when the
  addon loads). `SHIKI_BACKEND` is a deprecated alias.
- Publishing runs `pnpm publish` (catalog: specifiers must be rewritten;
  plain `npm publish` would leak them).
