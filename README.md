# Ferriki

Ferriki is a Shiki-compatible highlighter with a leaner Rust core.

It keeps the API shape people already know from Shiki, but removes the old
JS/WASM multi-engine direction from the runtime. The goal is simple: keep the
developer experience familiar, move the heavy lifting into Rust, and end up
with a smaller, cleaner architecture that is easier to reason about and easier
to ship.

## Why Ferriki

- Shiki-compatible where it matters: existing highlighting-oriented Node APIs stay recognizable.
- Rust-first by design: grammar handling, theme application, state management, and rendering belong in the native core.
- Shiki-derived standard assets should ship with Ferriki, but load lazily instead of living as an always-on bundled runtime catalog.
- Leaner runtime shape: no product dependency on the historical JS/WASM engine stack.
- Verifiable compatibility: the Node layer is checked against a strict mirrored Shiki release-tag suite, while the tokenizer is checked against a pinned vscode-textmate oracle.

Ferriki is for teams that like the Shiki contract, but want a cleaner native
foundation under it.

## Product Scope

Ferriki is intentionally narrow right now.

| Area | Status | Notes |
| --- | --- | --- |
| Core highlighting runtime | Integrated | Native Rust core, Node bindings, Shiki-compatible highlighting API |
| Direct outputs like `codeToHtml`, `codeToTokens`, `codeToHast` | Integrated | Part of the main product surface |
| `transformers`, `colorized-brackets` | Not integrated | These may exist in the mirrored compatibility workspace, but they are not part of the Ferriki product boundary |
| `markdown-it`, `rehype`, `VitePress integrations` | Out of scope | These are adapters on top of `codeToHtml` / `codeToHast`, so Ferriki does not treat them as product features |
| Future native extension lanes | Possible later | If Ferriki takes on these areas, the preferred direction is Rust-native ownership, not a permanent JS wrapper stack |

The mirrored Shiki workspace under [`node/compat/upstream/shiki`](node/compat/upstream/shiki) exists to verify compatibility claims. It is not a statement that every mirrored package is a Ferriki feature.

## Products

This repository currently has two primary product surfaces:

- [`crates/ferriki-core`](crates/ferriki-core): the Rust runtime and N-API host layer
- [`node/ferriki`](node/ferriki): the Node-facing package surface

Everything else exists to support validation, compatibility, and repository
maintenance.

## Repository Layout

- [`crates/ferriki-core`](crates/ferriki-core): native runtime
- [`node/ferriki`](node/ferriki): Node package
- [`node/compat/harness`](node/compat/harness): Ferriki-specific compatibility glue
- [`node/compat/upstream/shiki`](node/compat/upstream/shiki): strict upstream Shiki mirror
- [`node/compat/upstream/vscode-textmate`](node/compat/upstream/vscode-textmate): strict tokenizer source and test oracle
- [`adr`](adr): architecture decision records ([index](adr/README.md))

Contributor workflow, test lanes, and the mirror rules are documented in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

User-facing documentation lives in the [`docs/`](docs) directory:

- [Ferriki API reference](docs/ferriki-api.md)
- [Shiki migration guide](docs/migrations/shiki-to-ferriki.md)
- [Compatibility and support policy](docs/compatibility.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Ferromark + Ardo example](docs/examples/ferromark-ardo.mjs)

The repository root is intentionally Rust-first. All Node, npm, and upstream
compatibility machinery lives under [`node`](node).

## Quick Start

Prerequisites: a stable Rust toolchain (`cargo`), Node.js >= 20, and pnpm
(the pinned version in `node/package.json` is picked up via corepack).

Rust:

```sh
cargo check -p ferriki-core
```

Node (`build:native` compiles the Rust core and copies the addon into the
package):

```sh
cd node
pnpm install --ignore-scripts
pnpm run prepare:compat
pnpm run build:native
pnpm run test:ferriki-compat:textmate
```

The compatibility workspace contains upstream `prepare` scripts that rewrite
generated files. Installs intentionally skip package lifecycle scripts; the
explicit `prepare:compat` command runs those generators in a temporary
checkout and keeps the tracked mirror immutable.

The TextMate compatibility lane runs selected, unchanged Shiki tests with
honest aliases so every highlighted result passes through the native addon.
The broader `test:ferriki-compat:core` lane also covers facade work tracked in
issue #31.

## Compatibility

Ferriki tracks one approved Shiki release tag at a time — currently
**Shiki v4.4.3** (machine-readable source of truth:
[`node/compat/upstream/shiki/.source.json`](node/compat/upstream/shiki/.source.json)).

- Upstream-derived files under [`node/compat/upstream/shiki`](node/compat/upstream/shiki) are mirrored, not hand-edited.
- vscode-textmate source and tests under [`node/compat/upstream/vscode-textmate`](node/compat/upstream/vscode-textmate) are likewise pinned and never hand-edited.
- Ferriki-specific behavior lives outside that mirror, mainly in [`node/compat/harness`](node/compat/harness) and the Ferriki product paths.
- “Shiki-compatible” in this repository means compatibility is intended to be checked, not just claimed.
- Compatibility coverage is broader than product scope. Ferriki may still test selected optional upstream adapters separately, but that does not make them first-class Ferriki features.

## Status

The native TextMate runtime from issue #30 is implemented. It is a mechanical
port of pinned vscode-textmate v9.3.2 onto ferroni's Scanner API, integrated
with Ferriki's asset catalogs, native renderer, N-API host, and focused Node
surface. Its inner vscode-textmate oracle and honest Shiki v4.4.3 structural
gate are green.

Issues #47 and #51 own the remaining token/state and lifecycle breadth of the
Shiki facade. Transformer/decorator behavior remains deliberately outside the
core runtime until its contract is accepted. The current core direction is:

- Rust owns runtime behavior
- Node is the thin facade and compatibility layer
- optional ecosystem adapters do not define the core product boundary or release gate

## License

[MIT](./LICENSE)

<!-- ferramenta-family:start -->
## The Ferramenta family

This project is part of [Ferramenta](https://ferramenta.dev) — the family of Rust-native developer tools by [Sebastian Software](https://oss.sebastian-software.com) that keep the APIs the ecosystem already knows:

| Tool | Job |
| --- | --- |
| [ferroni](https://github.com/sebastian-software/ferroni) | Oniguruma-compatible regex engine |
| **[ferriki](https://github.com/sebastian-software/ferriki)** | Shiki-compatible syntax highlighting |
| [ferromark](https://github.com/sebastian-software/ferromark) | CommonMark/GFM Markdown to HTML |
| [ferrovia](https://github.com/sebastian-software/ferrovia) | SVGO-compatible SVG optimizer |
| [ferrocat](https://github.com/sebastian-software/ferrocat) | Translation catalog engine |
| [ferrolex](https://github.com/sebastian-software/ferrolex) | Spell, dictionary, and brand validation |
| [ferrugo](https://github.com/sebastian-software/ferrugo) | Rust-native PDF previews |
<!-- ferramenta-family:end -->
