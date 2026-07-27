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

## Validation Outcome

Issue #30 implements this decision against two immutable upstream references:

- vscode-textmate v9.3.2, pinned by
  `node/compat/upstream/vscode-textmate/.source.json`
- Shiki v4.3.1, pinned by `node/compat/upstream/shiki/.source.json`

The inner gate is `cargo test -p ferriki-textmate`. It passes the Rust unit
suite and all mirrored tokenization cases: 91 First Mate cases, 20 Suite 1
cases, and 9 while-rule cases.

The outer gate is `pnpm run test:ferriki-compat:textmate` from `node/`. It runs
unchanged Shiki tests with `FERRIKI_HONEST_ALIAS=1`; 20 behavior tests pass and
7 API- and error-contract tests are outside this structural gate. The passing
behavior set covers:

- ancestor-scope theme and `fontStyle` inheritance
- begin/end, while, capture, and persistent state stacks
- JavaScript/TypeScript and Markdown embedded grammars
- Vue external injections and explicitly loaded lazy SCSS embeddings
- language aliases, dependencies, dynamic loading, HTML, HAST, and token output

The broader mirrored Shiki suite still contains facade requirements owned by
issue #31, including multi-theme output, explanation objects, grammar-state
continuation, ANSI parsing, and transformers. Those exclusions do not change
the interpreter boundary or the zero-structural-failure gate established by
this decision.
