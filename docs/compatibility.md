# Compatibility and support policy

## Baseline

Ferriki's compatibility reference is the pinned **Shiki v4.3.1** mirror at
[`node/compat/upstream/shiki`](../node/compat/upstream/shiki). The source commit
and imported paths are recorded in
[`node/compat/upstream/shiki/.source.json`](../node/compat/upstream/shiki/.source.json).
The tokenizer oracle is the pinned vscode-textmate source under
[`node/compat/upstream/vscode-textmate`](../node/compat/upstream/vscode-textmate).

The mirror is immutable during tests. Ferriki-specific aliases, native
registration, and compatibility shims live in `node/compat/harness`; upstream
files are never edited to make a test pass.

## What is covered

The mandatory core gate covers the native TextMate oracle, standard catalogs,
language aliases, themes, HAST/HTML/tokens, lazy embedded grammars, injections,
custom registrations, multi-theme output, ANSI rejection, public exports, and
the current docs contract. Adapter suites for transformers, Twoslash,
Markdown, and colorized brackets are separate because those packages are not
Ferriki's core product boundary.

The root README's “Product Scope” table is the authoritative feature boundary.
Passing a mirrored adapter test does not promote that adapter to a Ferriki
export.

## Running the gates

From the repository root:

```sh
cargo test --workspace
cd node
pnpm install --frozen-lockfile --ignore-scripts
pnpm run test:ferriki-compat:textmate
pnpm run test:ferriki-compat:core
pnpm run check:boundary
pnpm run typecheck
pnpm run lint
```

`test:ferriki-compat:core` builds the pinned compatibility packages, builds the
native addon, runs the catalog/export/native-boundary/docs/API checks, executes
the supported native suite, and reports deferred contracts with their owning
issue. `check:boundary` is also safe to run without a native build; it guards
the package manifest and source tree against legacy runtime dependencies,
fallback loaders, and forbidden runtime files. A clean working tree is
required after compatibility preparation.

## Platform support

The current CI smoke matrix exercises Node 20 on Ubuntu and Node 22 on Ubuntu,
macOS, and Windows. Ferriki requires Node 20 or newer and a matching native
binary. libc variants and additional architectures are not implied by a green
CI run; they require an explicit support-matrix decision and a packed-artifact
smoke test before being documented as supported.

## Reporting a compatibility gap

Include the Ferriki version, Node version, OS/architecture/libc, exact public
call, and whether the failure reproduces from a packed tarball. Attach the
smallest source/grammar/theme registration that reproduces the behavior. Do
not patch `node/compat/upstream`; open or update an issue with the upstream
baseline and the Ferriki contract involved.
