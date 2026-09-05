# Compatibility and support policy

## Baseline

Ferriki's compatibility reference is the pinned **Shiki v4.4.3** mirror at
[`node/compat/upstream/shiki`](../node/compat/upstream/shiki). The source commit
and imported paths are recorded in
[`node/compat/upstream/shiki/.source.json`](../node/compat/upstream/shiki/.source.json).
The tokenizer oracle is the pinned vscode-textmate source under
[`node/compat/upstream/vscode-textmate`](../node/compat/upstream/vscode-textmate).

The mirror is immutable during tests. Ferriki-specific aliases, native
registration, and compatibility shims live in `node/compat/harness`; upstream
files are never edited to make a test pass. The mirror's `.manifest.sha256`
records the SHA-256 digest of every tracked upstream file and is checked before
and after compatibility preparation.

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

The core gate also runs Shiki's `bundle-full` and `bundle-web` smoke tests. The
current pinned baseline expects 364 and 96 loaded languages respectively. The
audit found two grammar-shape gaps that had been hidden by the old exclusion:
legacy capture arrays (for example, `jinja`) and repository entries represented
as rule arrays (for example, `racket`). Ferriki normalizes both forms at the
raw-grammar boundary, with focused Rust tests covering the conversion.

## Platform support

The 1.0 floor is Node.js 22.13.0. The CI smoke matrix exercises every target
in the current release map:

| Target | OS/architecture | libc/runtime | Status |
| --- | --- | --- | --- |
| `linux-x64-gnu` | Linux x64 | glibc | Supported |
| `linux-arm64-gnu` | Linux arm64 | glibc | Supported |
| `darwin-arm64` | macOS arm64 | system | Supported |
| `darwin-x64` | macOS x64 | system | Supported |
| `win32-x64-msvc` | Windows x64 | MSVC | Supported |
| Linux x64/arm64 musl | Alpine and other musl systems | musl | Explicitly unsupported |

The target map is maintained in [`node/ferriki/platforms.mjs`](../node/ferriki/platforms.mjs)
and checked by `pnpm run check:platform-matrix`. A green CI run does not imply
support for an unlisted libc or architecture. The five sidecar manifests now
live under `node/platforms/*` and are declared as optional dependencies. The
publish workflow assembles and publishes those sidecars before the main
package, then verifies public npm metadata, provenance, and a clean consumer
install.

The native smoke jobs build with an explicit Rust target for each supported
platform, including macOS Intel (`x86_64-apple-darwin`). This catches a host
versus target mismatch before release artifacts are assembled.

## Packaging baseline

The packed `ferriki@0.2.1` main package measured **11,372,892 bytes
unpacked** on 2026-09-05 (`npm pack --json`). This is the main-package
baseline; the release workflow also validates each sidecar tarball before
publication.

## Reporting a compatibility gap

Include the Ferriki version, Node version, OS/architecture/libc, exact public
call, and whether the failure reproduces from a packed tarball. Attach the
smallest source/grammar/theme registration that reproduces the behavior. Do
not patch `node/compat/upstream`; open or update an issue with the upstream
baseline and the Ferriki contract involved.
