# ADR 0008: JavaScript Transformer Callbacks and Native Decoration Policy

## Status

Accepted

Last updated: 2026-10-10

## Context

Ferriki's Node HTML pipeline exposes two different contracts. Transformers
are user-supplied JavaScript callbacks at defined token and HAST stages.
Decorations describe source ranges, wrapping, tags, and properties, with an
optional JavaScript `transform` callback. Their callback payloads are internal
HTML render data, not public token or HAST result methods (ADR 0011).

The original implementation kept both features in JavaScript to preserve
ordering. The existing Node consumer now needs native decoration policy
(#122), independently of whether a Rust-only consumer requests the same API.
`colorReplacements` remains unsupported and not planned (#190); themes and
CSS-class styling cover current presentation needs.

## Decision

- Transformer callbacks and `DecorationItem.transform` stay in JavaScript.
  They receive the existing objects and opaque callback metadata. No user
  callback, HTML property, or callback payload is serialized into Rust.
- The `ferriki` crate owns typed decoration range resolution and validation,
  token-boundary splitting, stable nesting order, section selection, and the
  decision to target a line, token, or wrapper. `ferriki-core` only converts
  the private N-API inputs and outputs. The Node facade slices JavaScript
  strings and replays Rust's edits on the existing objects, retaining property
  references, class normalization, and callback identities. Token metadata and
  node shapes use checked numeric buffers rather than an object per entry;
  slices return as four-word `Uint32Array` records. The layout is private
  transport, not a public token or HAST schema.
- Ordering stays explicit: preprocess callbacks, native tokenization, token
  callbacks and merging, native decoration splitting, span/line/code/pre
  callbacks, native decoration planning and host replay, root callbacks,
  scope nesting and class extraction, serialization, then postprocess.
  Source ranges are resolved against the preprocessed source; selection uses
  the current tree after HAST callbacks.
- Declarative-only application batches all sections into one native plan.
  If a decoration callback can mutate the tree or its own resolved bounds, or
  a transformer shares child arrays, the facade replans each section after the preceding edit. Completed
  edits remain observable if a later boundary fails. This preserves the
  existing callback contract; it is not a general transaction API.
- Node ranges count UTF-16 code units, including boundaries inside surrogate
  pairs. The bridge carries source text and numeric metadata; final token
  string slicing stays in JavaScript. The typed Rust policy also supports UTF-8 byte
  coordinates. Native transport requires finite integer coordinates.
- These primitives are exposed only through the semver-exempt
  `ferriki::__private` bridge (ADR 0014). This is an explicit API decision:
  adopting them for the existing Node consumer does not establish a stable
  Rust HAST, decoration, or callback API. A future Rust consumer needs a
  separate proposal based on its renderer and ownership requirements.
- Async and sync constructors retain transformer defaults for
  `codeToHtml` and `codeToHtmlWithCss`. Explicit per-call lists replace them,
  including an empty list. Stable pre/normal/post enforcement tiers remain.
- The optional Vite adapter forwards callbacks into this same pipeline.
  Supported Shiki notation helpers remain opt-in JavaScript callbacks; no
  parallel code-comment annotation parser is introduced.

## Consequences

- Decoration policy has one Rust implementation. JavaScript retains callback
  dispatch, object transport and edit replay; it does not independently resolve
  ranges or select boundaries.
- Transformers using shared fields can run through Ferriki's hook pipeline;
  full Shiki context type interchangeability is not promised (ADR 0011).
  Constructor defaults and context types are separate from native decoration
  ownership; their remaining contract work is tracked in #241.
- Public Node methods return HTML or HTML/CSS. Token and HAST structures remain
  callback data; nested `codeToHast`/`codeToTokens` helpers remain absent.
- Three extra native calls serve a normal decorated render: token splitting,
  range/section preparation, and tree planning. Callback-heavy cases can need
  more plans. Moving policy into Rust does not imply a speed improvement;
  measurements must include transport and allocation costs.
- The stable Rust API remains token- and render-oriented. Ferromark still owns
  its line wrappers, titles, line numbers, and annotations and receives escaped
  line fragments (ADR 0012).

## History

- 2026-07-25: Accepted.
- 2026-09-30: Records the Rust side of the boundary and the open question in #122.
- 2026-10-01: Constructor transformer defaults and per-call replacement are explicit facade contracts (#182).
- 2026-10-01: Clarifies the Ferriki-typed transformer boundary and that `colorReplacements` remains deferred (#190).
- 2026-10-03: Records Vite's forwarding of caller-supplied JS transformers for Shiki notation without adding a second annotation dialect (#166).
- 2026-10-03: Limits public Node transformer defaults to HTML calls while retaining internal token/HAST callback payloads and removing structured-output methods (#207).
- 2026-10-10: Closes the native color-replacement backlog as not planned (#190); the explicit unsupported contract remains in place, and future support requires a concrete consumer need beyond theme/CSS-class styling.
- 2026-10-10: Moves declarative decoration policy into Rust through the private typed bridge, preserving JS callbacks and object identities; explicitly defers a stable Rust decoration API (#122).
