# Architecture Decision Records

Accepted decisions, in order. Each record is self-contained; later
records refine earlier ones where noted.

| ADR | Decision |
| --- | --- |
| [0001](0001-rust-first-architecture.md) | Rust-first runtime architecture |
| [0002](0002-node-workspace-under-node.md) | Isolate the Node workspace under `node/` |
| [0003](0003-strict-shiki-compat-mirror.md) | Strict mirrored Shiki compatibility suite |
| [0004](0004-core-vs-adapter-scope.md) | Core product scope vs. optional adapter lanes |
| [0005](0005-ferroni-stays-external.md) | Ferroni stays an external dependency |
| [0006](0006-lazy-shiki-asset-loading.md) | Lazy loading for Shiki-derived assets |
| [0007](0007-adapter-integrations-stay-outside-ferriki.md) | Adapter integrations stay outside Ferriki |
| [0008](0008-transformers-and-decorations-stay-in-js.md) | Transformers and decorations stay in the JS layer |
| [0009](0009-native-only-runtime.md) | Native-only runtime — JS is a facade, WASM is the future fallback |

## Adding a record

Copy [`template.md`](template.md) to the next number, keep the
`Status / Context / Decision / Consequences` structure, write in US
English, and link related records. Execution details belong in
[`plans/`](../plans/), not here.
