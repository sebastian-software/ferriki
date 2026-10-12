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
language aliases, themes, HTML rendering and its internal token/HAST callback
pipeline, lazy embedded grammars, injections, custom registrations,
multi-theme output, ANSI rejection, public exports, and the current docs
contract. Adapter suites for transformers, Twoslash,
Markdown, and colorized brackets are separate because those packages are not
Ferriki's core product boundary.

The [API contract](ferriki-1.0-api-contract.md) is the authoritative feature
boundary. Passing a mirrored adapter test does not promote that adapter to a
Ferriki export.

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
the package manifest and source tree against Shiki, WebAssembly, and regex
engine dependencies, fallback loaders, and forbidden runtime files. A clean
working tree is required after compatibility preparation.

Ferriki maintains its own curated standard catalog (including embedded
dependencies) and the existing 65 themes. The source list is independent of
Shiki's catalog. Shiki's `bundle-full` and `bundle-web` count snapshots are
explicitly excluded in the compatibility manifest (#152, ADR 0020). The core
gate checks the owned source hashes, catalog enumeration, every grammar's
native compilation, and external importing instead. See [grammar coverage and
importing](grammars.md). `getLoadedLanguages()` reports canonical IDs and aliases.
Six upstream tests also assume historical dependency lists. The compatibility
harness replaces only those metadata assertions with reviewed Ferriki ID/alias
sets or counts from `compat/harness/fixtures/loaded-languages.json`. All of their
HTML and theme snapshots still run unchanged; loaded-key order is not promised.

The immutable YAML color/merging snapshots use their pinned grammar data in
the native test adapter. Corpus comparisons use the current Ferriki grammar
data in both tokenizer engines. This keeps grammar-source updates independent
of the upstream snapshot colors while retaining native renderer assertions.

External TextMate grammars can contain two less common shapes: captures written
as arrays, a legacy TextMate form, and repository entries represented as rule
arrays. Ferriki normalizes both at the raw-grammar boundary, with focused Rust
tests covering the conversion.

## Platform support

Ferriki requires Node.js 22.13.0 or newer. The CI smoke matrix exercises every
target in the release map:

| Target | OS/architecture | libc/runtime | Status |
| --- | --- | --- | --- |
| `linux-x64-gnu` | Linux x64 | glibc | Supported |
| `linux-arm64-gnu` | Linux arm64 | glibc | Supported |
| `linux-x64-musl` | Linux x64 (Alpine and other musl systems) | musl | Supported |
| `linux-arm64-musl` | Linux arm64 (Alpine and other musl systems) | musl | Supported |
| `darwin-arm64` | macOS arm64 | system | Supported |
| `darwin-x64` | macOS Intel | system | Unsupported (Apple Silicon only) |
| `win32-x64-msvc` | Windows x64 | MSVC | Supported |
| `win32-arm64-msvc` | Windows arm64 | MSVC | Supported |

The target map is maintained in [`node/ferriki/platforms.mjs`](../node/ferriki/platforms.mjs)
and checked by `pnpm run check:platform-matrix`. A green CI run does not imply
support for an unlisted libc or architecture. The sidecar manifests live
under `node/platforms/*` and are declared as optional dependencies. The
publish workflow assembles and publishes those sidecars before the main
package, then verifies public npm metadata, provenance, and a clean consumer
install.

The native smoke jobs build with an explicit Rust target for each supported
platform. This catches a host versus target mismatch before release artifacts
are assembled. The musl addons are cross-compiled with `cargo zigbuild` on a
glibc runner of the same architecture; their packed-consumer, sidecar, and
import checks then run in a `node:22-alpine` container, because a glibc host
cannot load a musl addon.

## Packaging baseline

The main package ships no native addon; each platform's addon comes from its
`@ferriki/<platform>` sidecar. It ships no grammar or theme payloads either:
only the catalog manifests and the release manifest that pins every payload,
which the runtime downloads and caches on first use (ADR 0013). The core gate
asserts that no payload is packaged. The size is measured on every run of the
core gate rather than quoted here:
`node/scripts/check-packed-consumer.mjs` packs the package, installs the
tarball in a clean consumer, and prints the tarball name, unpacked size, and
file count for the tree it ran against. The release workflow also validates
each sidecar tarball before publication.

## Reporting a compatibility gap

Include the Ferriki version, Node version, OS/architecture/libc, exact public
call, and whether the failure reproduces from a packed tarball. Attach the
smallest source/grammar/theme registration that reproduces the behavior. Do
not patch `node/compat/upstream`; open or update an issue with the upstream
baseline and the Ferriki contract involved.
