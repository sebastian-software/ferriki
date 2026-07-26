# ADR 0008: Transformers And Decorations Stay In The JS Layer

## Status

Accepted

## Context

Rendering behavior such as `colorReplacements`, `mergeWhitespaces`,
`mergeSameStyleTokens`, and the `codeToHast` render options has moved into the
Rust core (see ADR 0001). Two features were still unassigned to either side of
the native/JS boundary:

- `transformers`: user-supplied callback hooks that receive hast nodes and
  token structures at defined pipeline points. The Shiki ecosystem
  (`@shikijs/transformers`, twoslash, colorized-brackets, and downstream
  consumers such as Ardo's line-number/line-highlight transformers) depends on
  this callback contract.
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
  break the ecosystem contract that makes Ferriki a drop-in Shiki replacement.
- `decorations` stay in JS for now. They interleave with transformers during
  `codeToHast`, so applying them natively while transformers run in JS would
  risk ordering drift against Shiki semantics. Because decorations are
  declarative, native ownership remains possible later — but only as a
  deliberate follow-up with compat coverage, not as a side effect of other
  native migrations.

## Consequences

- The Rust core's public surface is token- and render-oriented; it does not
  need to model callbacks or hast mutation.
- Shiki ecosystem transformers keep working unchanged, which keeps the
  drop-in story credible for consumers like Ardo.
- The JS layer retains a bounded amount of runtime logic (transformer
  dispatch, decoration application). This is a deliberate exception to the
  "runtime behavior belongs in Rust" default of ADR 0001.
- How much of the render pipeline can go native is now bounded: everything up
  to hast construction may move down; hast mutation stays up.
