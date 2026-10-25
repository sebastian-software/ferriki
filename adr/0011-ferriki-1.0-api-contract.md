# ADR 0011: Freeze the Ferriki 1.0 Node API Contract

## Status

Accepted

Last updated: 2026-10-25

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

`tokenizeTimeLimit` is a best-effort per-line budget. The tokenizer checks it
between matching passes and after each pass returns, but Ferroni's synchronous
scanner cannot interrupt a regex search already in progress. A search can
therefore exceed the configured duration; Ferriki reports the overrun through
stopped-early tokenization.

The factory-only `regexPrefilter` boolean defaults to `true`, allowing the
native scanner's prefilter. Prepared standard assets use Eager for static groups
from first use; source-only and captured dynamic scanners retain Auto. `false` disables prefilter
construction for all grammars in that highlighter. It changes performance
policy without exposing Ferroni types or changing highlighting semantics.

`colorReplacements` is a non-goal for the current contract (#190). Themes and
CSS-class styling cover current presentation needs. The option stays outside
the public types and is rejected with `ERR_UNSUPPORTED`; a future proposal
requires a concrete consumer need beyond the supported theming path.

The contract prioritizes the synchronous reusable HTML-rendering path, keeps
transformer callbacks in JavaScript and decoration policy in Rust, and keeps ecosystem adapters
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

Grammar-state continuation keeps the stable `version: 1` and required
`source: string` fields. New results may add the optional
`stateFormat: "textmate-stack-v1"`; their opaque `source` field contains a
serializable tokenizer stack rather than the full input. Dynamic backreferences
and captured scope names may retain matched input fragments. Older v1 states
without that discriminator continue to use their raw-source context. The first
use as `grammarState` in `getLastGrammarState` replays that source and returns a
compact state; `codeToHtml` replays a legacy source for that call and returns
only HTML. This compatibility replay retains the existing unbounded
source-size behavior.

The initial React `Code` macro presentation transition targets 1.1.0 as the
one-time early-1.x exception recorded in
[ADR 0019](0019-shadow-dom-code-elements.md#release-scope). Its DOM and CSS
scoping changes require migration for consumers of the previous presentation;
the existing call syntax, HTML API, prepared descriptor, and custom renderer
retain their contracts. This exception does not relax other Stable rows or
future semver guarantees.

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

## Explicit regex policies

Repository builds add `regexMode` and `getRegexDiagnostics()` as additive
configuration/diagnostic extensions. The existing boolean option and product
default retain their behavior. [ADR 0021](0021-precompiled-pattern-sidecars.md#regex-mode-isolation-october-25-2026)
owns the mode semantics and benchmark separation.

## History

- 2026-10-25: Separate source Off/Auto/Eager from Prepared in configuration and
  benchmark contenders; retain default and legacy boolean behavior. Record
  policy and archive-use diagnostics without claiming complete coverage.

- 2026-10-24: Clarify that enabled prefiltering consumes prepared standard static
  groups in Eager mode; source-only and dynamic scanners retain Auto (ADR 0021).

- 2026-09-05: Accepted.
- 2026-09-30: Lists the ADR 0013 options and the type conformance check the contract must cover before the freeze.
- 2026-09-30: The contract now lists the `assets` option and the download boundary (#141).
- 2026-10-01: Adds Shiki type drift checks with explicit native API boundaries (#158).
- 2026-10-01: Classifies `colorReplacements` as deferred until runtime support is implemented (#190).
- 2026-10-03: Removes public Node HAST and token output methods before 1.0 while retaining transformer callback data and Rust token APIs (#207).
- 2026-10-04: Takes over the mapping of child issues to the contract, which now states only the contract itself.
- 2026-10-10: Adds the factory-only regex prefilter switch for one-shot workloads.
- 2026-10-10: Classifies native color replacements as a non-goal after closing #190 as not planned; preserves explicit rejection and requires a concrete consumer need for any future proposal.

- 2026-10-10: Clarifies native decoration ownership without changing public Node output methods (#122).
- 2026-10-11: Records the one-time 1.1.0 React macro presentation transition while preserving other stable contracts (#263).
- 2026-10-21: Clarifies the best-effort `tokenizeTimeLimit` contract and scanner interruption limit (#292).
- 2026-10-21: Records the additive portable tokenizer-stack format for grammar-state continuation while retaining the v1 required fields and legacy inputs (#291).
