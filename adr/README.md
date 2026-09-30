# Architecture Decision Records

These records explain why Ferriki is built the way it is. Read the accepted
ones as constraints: work that conflicts with a record either follows it or
changes the record first.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-rust-first-architecture.md) | Rust-first runtime architecture | Accepted |
| [0002](0002-node-workspace-under-node.md) | Isolate the Node workspace under `node/` | Accepted |
| [0003](0003-strict-shiki-compat-mirror.md) | Strict mirrored Shiki compatibility suite | Accepted |
| [0004](0004-core-vs-adapter-scope.md) | Core product scope vs. optional adapter lanes | Accepted |
| [0005](0005-ferroni-stays-external.md) | Ferroni stays an external dependency | Accepted |
| [0006](0006-lazy-shiki-asset-loading.md) | Lazy loading for Shiki-derived assets | Accepted |
| [0007](0007-adapter-integrations-stay-outside-ferriki.md) | Adapter integrations stay outside Ferriki | Accepted |
| [0008](0008-transformers-and-decorations-stay-in-js.md) | Transformers and decorations stay in the JS layer | Accepted |
| [0009](0009-native-only-runtime.md) | Native-only runtime — JS is a facade, WASM is the future fallback | Accepted |
| [0010](0010-mechanical-vscode-textmate-port.md) | Mechanically port vscode-textmate into a separate Rust crate | Accepted |
| [0011](0011-ferriki-1.0-api-contract.md) | Freeze the Ferriki 1.0 Node API contract | Accepted |
| [0012](0012-publishable-rust-highlighter.md) | Publishable Rust highlighter and external Ferromark adapter | Accepted |
| [0013](0013-cdn-loaded-standard-assets.md) | Standard assets loaded from a release-pinned CDN mirror | Accepted |
| [0014](0014-rust-crate-semver-surface.md) | Semver surface of the published Rust crates | Accepted |
| [0015](0015-postcard-asset-codec.md) | Encode binary assets with postcard, format version first | Accepted |
| [0016](0016-optional-nested-scope-class-output.md) | Optional nested scope classes with resolved theme CSS | Accepted |

Other decision records:

- [README theme composition](../docs/adr/readme-theme-composition.md) —
  how mdtheme composes the root README (living record in `docs/adr/`).

## Living records

Records are living documents. Each file states the **current** decision, not
the decision as it was first written:

- When a decision changes, edit its record in place, in the same pull request
  as the change. Update `Last updated` and add one dated line to `History`
  that says what changed and why. Git history keeps the earlier wording.
- When a choice replaces a record wholesale, write a new record, set the old
  one to `Superseded by ADR NNNN`, and link both ways.
- A record that no longer applies and has no successor becomes `Deprecated`.
- Dated evidence, such as a `Validation Outcome` measured for one release,
  stays as recorded. Label it with its date instead of rewriting it.

Status values: `Proposed`, `Accepted`, `Superseded by ADR NNNN`, `Deprecated`.

## When to write or update a record

Write a record for a choice that is durable, cross-cutting, costly to reverse,
or that several people, repositories or future sessions must follow: a crate
or package boundary, a public API or semver rule, a file format, a runtime or
distribution policy. Do not write one for a local refactor or an exact value
that code or configuration already owns; link to that source instead.

Update a record when implementation makes a statement in it false, when an
issue settles one of its open questions, or when a pull request changes the
behavior it describes. The pull request template asks for this.

## Adding a record

Copy [`template.md`](template.md) to the next number, write in US English,
link related records, and add the row to the table above.
`scripts/check-adrs.mjs` (CI `lint` job) fails when a record is missing from
the table, the table disagrees with a record's status, or a record lacks its
`Status`, `Last updated` or `History`. Delivery tasks and sequencing belong in
GitHub issues, not in records.
