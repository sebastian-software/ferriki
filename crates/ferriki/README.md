# ferriki

`ferriki` is the reusable Rust highlighter used by Ferriki's Node addon and
native Rust consumers. It loads TextMate grammar and theme catalogs from an
explicit asset root, then tokenizes code synchronously. No Node.js or N-API
dependency is part of this crate.

The asset format and sample usage are documented in the repository's
[`docs/rust-api.md`](https://github.com/sebastian-software/ferriki/blob/main/docs/rust-api.md).

Licensed under MIT or Apache-2.0.
