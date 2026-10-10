# ADR 0011: Freeze the Ferriki 1.0 Node API Contract

## Status

Accepted

Last updated: 2026-10-10

## Context

Ferriki exposes a deliberately small native runtime behind a Shiki-shaped Node
facade. The current declarations still describe several partial projections,
compatibility stubs, and catch-all options. Implementing individual parity gaps
before deciding the supported surface would make the API, types, and Ardo
integration drift again.

## Decision

Adopt [`docs/ferriki-1.0-api-contract.md`](../docs/ferriki-1.0-api-contract.md)
as the normative 1.0 Node API matrix. It classifies every public export,
factory input, highlight option, output shape, lifecycle rule, and error policy
as Stable, Shim, Remove, Deferred, or Non-goal.

The factory-only `regexPrefilter` boolean defaults to `true`, allowing the
native scanner's automatic warm-up policy. `false` disables prefilter
construction for all grammars in that highlighter. It changes performance
policy without exposing Ferroni types or changing highlighting semantics.

The contract prioritizes the synchronous reusable HTML-rendering path, keeps
transformers/decorations in the JavaScript layer, and keeps ecosystem adapters
outside the public Ferriki package. Before 1.0, public Node HAST and token
output methods are removed; the internal callback pipeline retains typed token
and HAST data, and the public Rust token APIs remain available. The npm package
exposes no Rust API; Rust consumers use the published crates of
[ADR 0012](0012-publishable-rust-highlighter.md).

The contract lists the `assets` option, its environment variables and the
sync/async download boundary of
[ADR 0013](0013-cdn-loaded-standard-assets.md). The CI typecheck checks the
hand-written declarations against mirrored Shiki types; the API contract
documents the intentional native-state, structured-output, and
transformer-context boundaries (#158, #207).

The contract is the decision point for the API work tracked in issues: #10
generates the typed surface, #43–#51 cover the retained highlighting behavior,
#44 supplies catalog enumeration, and #53/#54/#52 prove the packaged platform
boundary. #207 removes the public Node HAST/token output methods while
retaining callback data and Rust token APIs. #55 tracks the Ardo/Ferromark
handoff without changing the package's publication status. #39 is the
mandatory compatibility gate that keeps unsupported or deferred rows from
being mistaken for parity.

## Consequences

- API implementation and declaration work now has an explicit acceptance target.
- Compatibility tests can distinguish supported contracts from deferred Shiki
  behavior without inflating a parity score.
- Some currently exported stubs are intentionally removed before 1.0.
- Public Node HAST/token output methods are deliberately removed before 1.0;
  transformer callback data remains part of the HTML hook contract.
- Multi-theme output, enumerable catalogs, custom registrations, errors, and
  lifecycle behavior are required work rather than accidental extensions.

## History

- 2026-09-05: Accepted.
- 2026-09-30: Lists the ADR 0013 options and the type conformance check the contract must cover before the freeze.
- 2026-09-30: The contract now lists the `assets` option and the download boundary (#141).
- 2026-10-01: Adds Shiki type drift checks with explicit native API boundaries (#158).
- 2026-10-01: Classifies `colorReplacements` as deferred until runtime support is implemented (#190).
- 2026-10-03: Removes public Node HAST and token output methods before 1.0 while retaining transformer callback data and Rust token APIs (#207).
- 2026-10-04: Takes over the mapping of child issues to the contract, which now states only the contract itself.
- 2026-10-10: Adds the factory-only regex prefilter switch for one-shot workloads.
