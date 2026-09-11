# Contributing to Ferriki

## Prerequisites

- Rust (stable toolchain with `cargo`, `clippy`, `rustfmt`)
- Node.js >= 22.13.0 (the floor declared by `node/ferriki/package.json`)
- pnpm (the pinned version in `node/package.json` is picked up via corepack)

## The happy path

```sh
# Rust checks (fmt, clippy, tests — all gated in CI)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Published package family block (needs network)
node scripts/sync-readme-family.mjs --check

# Node workspace: install, build the native addon, run the release gate
cd node
pnpm install --ignore-scripts
pnpm run prepare:compat
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
| Native structural compat | `pnpm run test:ferriki-compat:textmate` (from `node/`) | Issue #30 gate against unchanged Shiki v4.4.3 tests (baseline pinned in `node/compat/upstream/shiki/.source.json`) |
| Full supported core facade | `pnpm run test:ferriki-compat:core` (from `node/`) | Honest mandatory lane; resolver sentinel plus supported contracts |
| Full core audit | `pnpm run test:ferriki-compat:core:full` (from `node/`) | Diagnostic issue #31 parity run; deferred failures are expected and classified |
| Adapter compat | `pnpm run test:ferriki-compat:adapters` (from `node/`) | Optional adapter behavior outside the core product boundary |
| Colorized brackets | `pnpm run test:ferriki-compat:colorized-brackets` (from `node/`) | Manual optional-package check |

The TextMate structural lane sets `FERRIKI_HONEST_ALIAS=1`, which routes the
mirrored tests' remaining upstream imports through Ferriki as well. Its
20 selected behavior tests cover core highlighting, loaders, aliases,
Markdown embeddings, lazy Vue/SCSS embeddings, and external injections. The
supported core lane adds the core sync/singleton contracts and a resolver
sentinel; its deferred file list is maintained in
`node/compat/harness/core-compat-manifest.mjs` and links each current gap to
issue #31. Use `test:ferriki-compat:core:full` when auditing the complete
upstream core suite; it must not be mistaken for the mandatory parity score.

The accepted 1.0 API matrix is
[`docs/ferriki-1.0-api-contract.md`](docs/ferriki-1.0-api-contract.md) and
its decision record is
[`ADR 0011`](adr/0011-ferriki-1.0-api-contract.md). Changes to exports,
options, errors, lifecycle, or compatibility classifications update that
contract and the corresponding tests together.

## Coverage

CI measures line coverage over the whole workspace and fails the `coverage`
job when it falls below the gate. The gate is one whole percent in
`coverage-threshold` at the repository root — the single source the workflow,
the README badge and the command below all read. Raise it when coverage grows;
never lower it to make a run pass.

```sh
cargo llvm-cov --workspace --all-features --locked --lcov --output-path lcov.info \
  --fail-under-lines "$(cat coverage-threshold)"
```

This needs the `llvm-tools-preview` component (`rustup component add
llvm-tools-preview`) and `cargo-llvm-cov` (`cargo install cargo-llvm-cov`). CI
runs exactly this command and appends `Line coverage: X% (gate: ≥ N%)` to the
run summary, so a failed gate still reports the number it measured.

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

## Facts with a single source

Three facts are contract-checked instead of repeated by hand:

- the Shiki baseline, whose source is
  `node/compat/upstream/shiki/.source.json`
- the Node floor, whose source is `engines.node` in
  `node/ferriki/package.json`
- the line-coverage gate, whose source is `coverage-threshold`

`node/scripts/check-docs-drift.mjs` (`pnpm run check:docs-drift` from `node/`,
also part of the mandatory core lane) fails when a documented baseline or floor
disagrees with those files. Change the source of truth first, then the prose.
Dated records under `plans/` and `adr/` keep the version that was pinned when
they were written and are deliberately outside the check.
`node/scripts/test-docs-drift.mjs` runs the same check against fixture copies
of the documents with stale versions injected, so a change to the checker that
stops detecting drift fails alongside it.

The gate is the one fact a badge has to repeat, so
`node/scripts/check-docs-contract.mjs` fails when the README badge names a
percent other than the one in `coverage-threshold`.

## The Ferramenta family block

The root README is generated by native mdtheme from `README.md.src`. Sebastian
Software is the outer frame and Ferramenta the inner frame. Edit project prose
in the source, then run `mise run readme:write`; `mise run readme:check` checks
the entire result. See [README themes](docs/readme-theme.md) for installation,
CI, and the pre-push command. Standards 0.11.0 explicitly delegates README
ownership to mdtheme and does not append a company footer.

Published subpackage READMEs retain compact, plain-Markdown family blocks.
They use the pinned Ferramenta registry generator and require Node, pnpm, and
network access:

```sh
node scripts/sync-readme-family.mjs
node scripts/sync-readme-family.mjs --check
```

Update `REGISTRY_PIN` in the generator script to adopt a new family revision.
For the root README, update `mdtheme.yaml` and regenerate separately. Commit
pins and outputs together. Never edit generated family text by hand.

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

#
