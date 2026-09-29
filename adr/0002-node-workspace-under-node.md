# ADR 0002: Isolate The Node Workspace Under `node/`

## Status

Accepted

Last updated: 2026-09-30

## Context

The repository root should feel like a Rust project. At the same time, Ferriki
still needs a Node package, a compatibility harness, and the mirrored Shiki
test suite.

## Decision

All Node, npm, and compatibility-workspace files live under `node/`.

- `node/ferriki` holds the Node package.
- `node/compat/harness` holds Ferriki-specific compatibility glue.
- `node/compat/upstream/shiki` holds the mirrored upstream suite.
- The repository root is the `ferriki` Rust crate (`src/`, `tests/`) with the
  workspace members under `crates/` and the generated standard assets under
  `assets/`.

Two root directories carry JavaScript without being part of the Node product
workspace:

- `homepage/` is the ferriki.dev documentation site, a standalone Ardo project
  with its own lockfile. It consumes the published package and is not
  published itself.
- `scripts/` holds dependency-free Node scripts for asset generation and
  repository checks. They run with a plain `node`, without installing the
  `node/` workspace.

## Consequences

- The separation between product core and Node compatibility infrastructure is
  visible in the filesystem.
- CI and local commands must explicitly operate inside `node/` for Node-related
  work.
- The root no longer reads like a generic npm monorepo.

## History

- 2026-03-09: Accepted.
- 2026-09-30: Records the root crate layout and the `homepage/` and `scripts/` exceptions.
