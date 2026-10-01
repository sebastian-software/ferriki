# ADR 0008: Transformers And Decorations Stay In The JS Layer

## Status

Accepted

Last updated: 2026-10-01

## Context

Whitespace and same-style token merging and the `codeToHast` render options
live in the Rust core (see ADR 0001). `colorReplacements` is not implemented
by Ferriki and remains deferred under #190. Two features were still
unassigned to either side of the native/JS boundary:

- `transformers`: user-supplied callback hooks that receive Ferriki HAST nodes
  and token structures at defined pipeline points. Some Shiki ecosystem
  transformers can use the shared fields and payloads, but the full Shiki
  transformer context is not type-interchangeable with Ferriki's (ADR 0011).
- `decorations`: declarative offset ranges with classes/properties, applied to
  the rendered output. Unlike transformers they carry data, not code.

Today both are implemented entirely in the JS layer; the Rust core has no
notion of either.

## Decision

The hast-level transformation surface stays in JavaScript. The native core
owns tokenization, theme application, and rendering primitives, and exposes
stable hast-shaped output for the JS layer to transform.

- `transformers` stay in JS permanently. They are a JS-callback API by nature;
  crossing the native boundary per hook invocation would add FFI overhead and
  break Ferriki's supported JS hook pipeline.
- Async and sync highlighter constructors retain transformer defaults for
  HTML, HAST, and token calls. A call's explicit list replaces the defaults,
  including an empty list to disable them. Both use the existing stable
  `pre`/normal/`post` enforcement tiers.
- `decorations` stay in JS for now. They interleave with transformers during
  `codeToHast`, so applying them natively while transformers run in JS would
  risk ordering drift against Shiki semantics. Because decorations are
  declarative, native ownership remains possible later — but only as a
  deliberate follow-up with compat coverage, not as a side effect of other
  native migrations.

## Consequences

- The Rust core's public surface is token- and render-oriented; it does not
  need to model callbacks or hast mutation.
- Transformers using the shared callback fields and payloads can run through
  Ferriki's hook pipeline; full Shiki context interchangeability is not
  promised (ADR 0011).
- The JS layer retains a bounded amount of runtime logic (transformer
  dispatch, decoration application). This is a deliberate exception to the
  "runtime behavior belongs in Rust" default of ADR 0001.
- How much of the render pipeline can go native is now bounded: everything up
  to hast construction may move down; hast mutation stays up.
- The Rust API has no callback transform surface. Its Markdown consumer,
  Ferromark, owns line wrappers, titles, line numbers and code annotations
  and receives escaped line fragments ([ADR 0012](0012-publishable-rust-highlighter.md)).
  Whether Rust needs a typed, declarative decoration layer is an open design
  question in #122; until it is decided, no such layer is added.

## History

- 2026-07-25: Accepted.
- 2026-09-30: Records the Rust side of the boundary and the open question in #122.
- 2026-10-01: Constructor transformer defaults and per-call replacement are explicit facade contracts (#182).
- 2026-10-01: Clarifies the Ferriki-typed transformer boundary and that `colorReplacements` remains deferred (#190).
