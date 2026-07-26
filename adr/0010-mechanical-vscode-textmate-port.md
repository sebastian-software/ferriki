# ADR 0010: Mechanically Port vscode-textmate Into A Separate Rust Crate

## Status

Accepted

## Context

The native-only migration gate found structural tokenization failures in the
fork-era core: ancestor-scope theme matching, `fontStyle` inheritance,
while-rule and capture stacks, and embedded-language delegation all differed
from vscode-textmate. The measured result triggered the re-port condition in
`plans/native-only-migration.md`, and the old tokenizer was removed.

Issue #30 therefore needs a behavioral source of truth that prevents Ferriki
from re-deriving TextMate semantics case by case. It also needs a boundary
between grammar interpretation and Ferriki's asset catalogs, N-API host, and
Shiki-compatible facade.

## Decision

Ferriki ports vscode-textmate mechanically into a separate pure-Rust crate
named `ferriki-textmate`.

- The approved upstream release is pinned by
  `node/compat/upstream/vscode-textmate/.source.json`. Its source and tests are
  a strict, read-only mirror; Ferriki-specific harness code lives outside the
  mirror.
- The Rust module structure and algorithm order follow the upstream source
  layout closely. Rust type-system adaptations are allowed, but semantic
  shortcuts and unrelated redesigns are not.
- Ferroni remains the external regex implementation from ADR 0005.
  `ferriki-textmate` adapts vscode-textmate's Oniguruma calls to ferroni's
  Scanner API and does not add another regex engine.
- `ferriki-textmate` owns raw grammar models, selector matching, themes, rules,
  grammar compilation, tokenization, and state stacks. `ferriki-core` owns
  Ferriki asset catalogs, runtime orchestration, rendering, and N-API.
- The mirrored vscode-textmate suite is the inner oracle. The honestly aliased
  Shiki suite is the end-to-end oracle. Optimizations start only after both are
  green and the four structural gate failure classes have explicit coverage.

## Consequences

- Grammar semantics can be tested without Node or N-API, and `ferriki-core`
  cannot silently become a second grammar interpreter.
- Upstream diffs remain reviewable because module boundaries and algorithm
  order have recognizable counterparts.
- The port may initially retain upstream naming or shapes that are less
  idiomatic in Rust. Cleanup must preserve oracle parity and happen after the
  mechanical port.
- Updating vscode-textmate is a deliberate mirror refresh followed by a Rust
  parity audit; tracking upstream `main` directly is ruled out.
- The repository carries the upstream test corpus as development-only data.
  It is not included in the published Node package.
