# RFC 0001: Twoslash Via A TS7 Sidecar

## Status

Draft

## Summary

Ferriki should not integrate `Twoslash` as a thick JavaScript layer around the
Rust highlighter.

If Ferriki adopts `Twoslash`, the preferred direction is:

- Rust owns orchestration
- a TypeScript service runs out of process
- Ferriki talks to that service over a stable IPC/RPC boundary
- rendered output is still owned by Ferriki, not by the TypeScript side

This RFC proposes that the first serious design target should be a TS7-based
sidecar architecture, not a direct in-process binding.

## Why This RFC Exists

Ferriki is intentionally narrowing its product boundary around a Rust-native
highlighting runtime.

At the same time, `Twoslash` remains the most compelling higher-level extension
candidate:

- it is the dominant convention for type-aware TypeScript code examples
- it is already the main ecosystem expectation around Shiki-style annotated
  examples
- it is more interesting than smaller adapter packages because it adds real
  semantic value, not just output wiring

However, the current `Twoslash` model depends heavily on the TypeScript compiler
and language service. Recreating that naively in JavaScript on top of Ferriki
would pull the architecture back toward exactly the JS-heavy layering Ferriki is
trying to leave behind.

This RFC documents a cleaner future path instead.

## Problem Statement

Ferriki currently does not integrate `Twoslash` as part of its product scope.

That is the right short-term decision, but the medium-term question remains:

how can Ferriki support type-aware annotated examples without turning Rust into
just a token renderer under a JavaScript orchestration layer?

The design needs to satisfy all of these constraints:

- Ferriki remains Rust-first
- Node stays a host layer, not the semantic center
- TypeScript analysis stays accurate enough for `Twoslash`-class behavior
- the integration can survive TypeScript toolchain evolution
- the result can eventually support more than one host surface

## Why Twoslash Specifically

This RFC is intentionally narrow.

There are many wrappers and ecosystem integrations around type-aware code
examples, but the dominant underlying model is still `Twoslash`. The existing
VitePress, Nuxt, Vue, and related integrations are mostly packaging around that
same semantic idea rather than fundamentally different systems.

Because of that, Ferriki does not need a generic “any type-aware extension”
RFC yet. It needs a concrete answer for `Twoslash`.

## Constraints

### Product constraints

- Ferriki core scope is highlighting plus direct outputs
- optional adapters do not define the release boundary
- if Ferriki expands, the expansion should strengthen the Rust-first design

### Technical constraints

- `Twoslash` depends on TypeScript compiler and language-service behavior
- the current TypeScript 7 / Corsa direction is still evolving
- official API surface for the native TypeScript implementation is not yet a
  stable target for direct embedding

### Maintenance constraints

- Ferriki should avoid depending on unstable internal APIs where possible
- Ferriki should avoid building a permanent JS compatibility tower
- Ferriki should not commit to an implementation that only works inside Node

## Non-Goals

This RFC does not propose:

- immediate `Twoslash` integration
- keeping `@shikijs/twoslash` as a permanent Ferriki dependency path
- reimplementing TypeScript analysis in Rust
- direct Go FFI as the first integration path
- solving every possible future type-aware feature in one design

## Design Options

### Option A: Keep the existing JS/Twoslash stack above Ferriki

Description:

- Ferriki provides highlighting
- JavaScript hosts continue to run `Twoslash` much like they do today
- Ferriki only supplies highlighted output and related primitives

Pros:

- fastest path to something working
- minimal initial research cost

Cons:

- moves semantic ownership back into JS
- weak fit for Ferriki's architecture
- hard to call this a native Ferriki capability

Assessment:

Useful only as a temporary compatibility bridge. Not a good end state.

### Option B: Direct binding to a future TS7 native API

Description:

- Ferriki links directly to a Go-based TypeScript implementation
- Rust calls it in process through a binding layer

Pros:

- potentially lowest call overhead
- architecturally compact if the API were mature

Cons:

- depends on an API surface that is not yet a stable target
- tighter coupling to toolchain internals
- more difficult portability and lifecycle management

Assessment:

Attractive in theory, but too early and too brittle as the first design target.

### Option C: TS7 sidecar service with Rust-owned orchestration

Description:

- Ferriki spawns or connects to a TypeScript analysis sidecar
- requests and responses cross an explicit IPC/RPC protocol
- Rust owns request shaping, caching, mapping, and render integration
- TypeScript returns semantic data, not final HTML

Pros:

- fits current TypeScript-native tool direction better
- keeps Rust as the semantic center of the Ferriki product
- allows process isolation, caching, pooling, and host-independent reuse
- can evolve from Node-first to editor/server use cases later

Cons:

- more moving parts than a pure in-process design
- protocol design and service lifecycle add complexity
- higher latency than in-process calls unless carefully cached

Assessment:

This is the recommended direction.

## Recommended Direction

Ferriki should treat future `Twoslash` support as a two-runtime system:

- Ferriki core in Rust
- TypeScript analysis as a sidecar capability

Ferriki should own:

- snippet preparation
- include handling
- request normalization
- language/theme/highlighter lifecycle
- mapping semantic annotations onto Ferriki's internal output model
- final rendering into HTML or other direct outputs

The TypeScript sidecar should own:

- compilation context
- language-service queries
- diagnostics
- hover/query/completion extraction
- file graph and TS config interpretation

This keeps the TypeScript dependency where it belongs without letting it become
the actual application architecture.

## Architectural Sketch

### Components

1. Ferriki host
   - Rust API surface
   - optional Node binding
   - request/result types

2. Twoslash orchestration layer
   - Rust-owned
   - prepares source, metadata, includes, and request identity
   - manages caching and session reuse

3. TS7 sidecar
   - separate process
   - long-lived project/session model
   - exposes semantic operations over IPC/RPC

4. Ferriki render pipeline
   - merges semantic spans into Ferriki-owned output
   - produces HTML and future native output forms

### Protocol shape

The protocol should stay narrow and semantic.

Suggested request classes:

- initialize project/session
- update virtual files
- analyze snippet
- fetch hovers
- fetch completions
- fetch diagnostics
- close session

Suggested response classes:

- normalized diagnostics
- semantic span ranges
- hover payloads
- completion payloads
- emitted metadata needed for line/query/render behavior

The sidecar should not return final markup.

## Why Not Direct Binding First

The main reason is not ideology, but timing and stability.

Today, the most realistic path around TypeScript 7 native tooling is still a
service boundary, not an embedded library boundary. Existing early adopters in
the ecosystem are already treating the new TypeScript-native stack as a
separate backend rather than as a simple in-process dependency.

Ferriki should learn from that instead of forcing a tighter coupling too early.

## Suggested Phases

### Phase 0: Research and protocol draft

- confirm which `Twoslash` features are essential for Ferriki
- define the minimum semantic payload needed from the TS side
- model Ferriki-native output integration without JS-first assumptions

### Phase 1: Sidecar proof of concept

- create a minimal sidecar runner
- support diagnostics and basic query/hover extraction
- prove IPC contract shape and lifecycle

### Phase 2: Rust orchestration layer

- add request/response types in Rust
- implement session pooling and caching
- integrate result mapping into Ferriki output structures

### Phase 3: Ferriki-native rendering

- render `Twoslash` annotations from Rust-owned structures
- avoid depending on JS renderers for semantic behavior

### Phase 4: Host exposure

- decide whether Node exposes this as:
  - an optional package
  - a feature-flagged capability
  - or a later first-party surface

## Risks

- the TypeScript 7 native surface may still move substantially
- sidecar lifecycle and caching may become complex quickly
- parity with current `Twoslash` behavior may require more metadata than
  expected
- editor-style workloads and static-doc workloads may want different session
  models

## Open Questions

- Which `Twoslash` features are required for a first useful Ferriki-native cut?
- Should the sidecar be bundled, downloaded separately, or discovered on the
  system?
- Should Ferriki support both TS5/JS `Twoslash` and TS7 sidecar paths during a
  transition, or skip directly to the sidecar design?
- Should the sidecar protocol be Ferriki-specific or intentionally reusable?

## Graduation Criteria

This RFC should become an ADR only when all of the following are true:

- TypeScript 7 native tooling has stabilized enough for serious integration work
- Ferriki still wants `Twoslash` inside product scope
- the sidecar architecture has been validated with a proof of concept
- the intended product surface and maintenance burden are understood

## References

- TypeScript native preview and IPC direction:
  [https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/](https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/)
- TypeScript 7 progress and tooling caveats:
  [https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/)
- `typescript-go` project status:
  [https://github.com/microsoft/typescript-go](https://github.com/microsoft/typescript-go)
- Oxc type-aware architecture with `tsgolint`:
  [https://oxc.rs/docs/guide/usage/linter/type-aware.html](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
- Oxc alpha post:
  [https://oxc.rs/blog/2025-12-08-type-aware-alpha.html](https://oxc.rs/blog/2025-12-08-type-aware-alpha.html)
- `tsgolint` repository:
  [https://github.com/oxc-project/tsgolint](https://github.com/oxc-project/tsgolint)
