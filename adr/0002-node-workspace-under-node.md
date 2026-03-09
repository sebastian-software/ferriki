# ADR 0002: Isolate The Node Workspace Under `node/`

## Status

Accepted

## Context

The repository root should feel like a Rust project. At the same time, Ferriki
still needs a Node package, a compatibility harness, and the mirrored Shiki
test suite.

## Decision

All Node, npm, and compatibility-workspace files live under `node/`.

- `node/ferriki` holds the Node package.
- `node/compat/harness` holds Ferriki-specific compatibility glue.
- `node/compat/upstream/shiki` holds the mirrored upstream suite.
- The repository root remains focused on Rust and high-level repository
  metadata.

## Consequences

- The separation between product core and Node compatibility infrastructure is
  visible in the filesystem.
- CI and local commands must explicitly operate inside `node/` for Node-related
  work.
- The root no longer reads like a generic npm monorepo.
