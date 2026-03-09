# ferriki-core

Ferriki's Rust runtime crate.

This crate will own:

- grammar loading and registry logic
- theme registration and lookup
- state handling and serialization
- highlighter orchestration on top of Ferroni

Current state:

- the native Rust implementation now lives here
- `packages/shiki-rust` still points at these sources as a temporary compatibility shell
