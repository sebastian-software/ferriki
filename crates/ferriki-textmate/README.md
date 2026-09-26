# ferriki-textmate

`ferriki-textmate` is Ferriki's pure-Rust TextMate grammar interpreter.

It is a mechanical port of the vscode-textmate release pinned in
[`node/compat/upstream/vscode-textmate/.source.json`](../../node/compat/upstream/vscode-textmate/.source.json).
The upstream source and test mirror is read-only; Rust adaptations and test
harnesses live in this crate.

The crate owns grammar models, selector matching, themes, compiled rules,
tokenization, and state stacks. Asset catalogs and rendering live in the
publishable `ferriki` crate; `ferriki-core` contains the N-API host, as refined
by ADR 0012. The package includes the upstream vscode-textmate license and
third-party notices alongside Ferriki's MIT and Apache-2.0 license texts.
