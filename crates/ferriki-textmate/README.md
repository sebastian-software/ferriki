# ferriki-textmate

`ferriki-textmate` is Ferriki's pure-Rust TextMate grammar interpreter.

It is a mechanical port of the vscode-textmate release pinned in
[`node/compat/upstream/vscode-textmate/.source.json`](../../node/compat/upstream/vscode-textmate/.source.json).
The upstream source and test mirror is read-only; Rust adaptations and test
harnesses live in this crate.

The crate owns grammar models, selector matching, themes, compiled rules,
tokenization, and state stacks. Asset catalogs, rendering, and N-API remain in
`ferriki-core` as defined by ADR 0010.
