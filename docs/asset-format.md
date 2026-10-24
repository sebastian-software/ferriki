# Ferriki Asset Format

Ferriki stores generated standard language and theme catalogs in a compact
binary format in the ignored local `assets/standard/` build directory.
The reviewed metadata lock is [`assets/catalog.json`](../assets/catalog.json);
payloads live on Bunny under language/theme IDs and eight-character Base62 names.

This format is currently an internal Ferriki implementation detail. It exists
to decouple the runtime from upstream JS build artifacts and to give the Rust
core a stable generator/loader contract.

## Status

- File extensions:
  - `.fkgram`: one language asset
  - `.fktheme`: one theme asset
  - `.fkindex`: one manifest for a catalog
  - `.fkbc`: optional Zstd-compressed Ferroni prepared archive (separate format)
- Encoding: `serde` + [`postcard`](https://docs.rs/postcard): unsigned
  integers and lengths are LEB128 varints, strings are length-prefixed UTF-8,
  `Option` is a `0`/`1` tag followed by the value
- Current format version: `3` (format `2` used `bincode` 1.x, which is
  unmaintained, RUSTSEC-2025-0141)
- Source of truth for structs and roundtrip tests:
  - [`crates/ferriki-asset-gen/src/schema.rs`](../crates/ferriki-asset-gen/src/schema.rs)
  - [`src/asset_catalog.rs`](../src/asset_catalog.rs)

The postcard files have no magic header. Every postcard manifest and asset starts with its
`format_version`, so the decoder reads that varint first and reports a file
from another format version as `unsupported asset format version N` before it
looks at the payload. A format `2` file starts with `02 00 00 00`, whose first
byte decodes to the same version, so old files get the same clear error. Bytes
left over after the encoded value are rejected. Integrity against the release
manifest is checked separately by the `AssetSource` layer (SHA-256).

## Catalog Layout

Language catalog:

- `assets/standard/languages/manifest.fkindex`
- one `.fkgram` file per language
- one optional `.fkbc` file per language

Theme catalog:

- `assets/standard/themes/manifest.fkindex`
- one `.fktheme` file per theme

The generated `assets/standard/catalog.mjs` is the
Node-facing metadata projection of both manifests. It is intentionally kept
separate from the binary payloads so catalog enumeration remains lazy.

The manifest is loaded first. It maps logical IDs to asset filenames and carries
enough metadata for lazy lookup.

## Optional Precompiled Patterns

The generator writes `<id>.fkbc` alongside each grammar. This is a deterministic,
checksummed Zstd level-19 frame with an 8 MiB maximum window. Its decoded layout is:

| Field            | Encoding                                  |
| ---------------- | ----------------------------------------- |
| Magic            | `FKBC002\0` (8 bytes)                     |
| Combined version | `u32`, little endian                      |
| Scope length     | `u32`, little endian                      |
| Program length   | `u64`, little endian                      |
| Group length     | `u64`, little endian                      |
| Scope            | UTF-8 bytes                               |
| Programs         | Ferroni program archive v2                |
| Groups           | Matched Ferroni portable Eager archive v3 |

`SyncRegistry::add_precompiled_patterns` also accepts ordinary uncompressed
program archives from `export_precompiled_patterns`; their raw version is
`PRECOMPILED_PATTERNS_FORMAT_VERSION`. They retain registry-wide program reuse
without selecting prepared Eager groups. Standard `.fkbc` objects use the
versioned container described here.

The payload uses direct byte slices, without postcard's element-by-element byte
vector codec. The runtime opens the matched pair once and lets Ferroni lazily
validate and decode requested records. It bounds the decoded payload to 512 MiB,
the decoder window to 8 MiB, and rejects inconsistent sizes or trailing frames.
The trusted release manifest pins the compressed bytes by SHA-256 and size.
`ReleaseAsset::format_version` identifies
`ferriki_textmate::PRECOMPILED_PATTERNS_VERSION`; its 8/12/12-bit fields identify
the container, program and group formats. Grammar/theme/catalog postcard schemas
remain at format 3.

Standard generation prepares statically known ordered scanner lists with Eager,
including dependencies, external injections, end placement and anchor variants.
`SyncRegistry::precompile_patterns(scope, samples)` uses the same producer; empty
samples enumerate static lists, while nonempty samples prepare encountered lists
only. Attaching a pair selects Eager for that root when prefiltering is enabled.
Missing groups use ordinary Eager preparation. Per-pattern helpers, scratch space
and input-dependent transition caches remain local. The performance objective is
lower startup cost than rebuilding source Eager, with ordinary Eager execution
from first use. Restoring the archive has an accepted cost; source Off provides
a diagnostic reference rather than a loading-parity requirement. A persistent
digest-addressed cache reuses downloaded packages across builds and deployments.
Each fresh process restores its runtime state from those packages. Existing
in-process caches already reuse scanners across repeated highlights and edits.

Both prefilter settings and every anchor variant are generated from the same
normalization as runtime scanners. Captured end/while patterns remain dynamic.
With prefiltering enabled, only explicitly requested roots download/open sidecars;
Node Off mode skips their download and every Off highlighter skips their opening; each root pair already
includes its dependency scanner groups. Missing, corrupt or incompatible sidecars,
and scanner assembly failures with mixed decoded/source programs, fall back to
source compilation. The [current diagnostic](benchmarks/precompiled-patterns/prepared-eager.md)
confirms lower startup cost than source Eager and comparable Eager execution on
the measured workloads. It excludes network/file I/O and complete build processes.
Bytecode must come from a trusted producer; validation cannot prove that a
program implements its claimed pattern. See [ADR 0021](../adr/0021-precompiled-pattern-sidecars.md).

Regenerate with `node scripts/generate-ferriki-assets.mjs`, then update the lock
with `node scripts/write-asset-lock.mjs`. Run
`cargo test --release --test precompiled_assets` and the mandatory native
compatibility gate before publishing new immutable objects. The grammar updater
also runs when tokenizer/dependency changes introduce a new bytecode version.

## Common Metadata

Both manifests include:

- `format_version: u32`
- `source.upstream: String`
- `source.version: Option<String>`
- `source.commit: Option<String>`

`source` describes the upstream import source used during generation, for
example `textmate-grammars-themes`.

## `.fkindex`

Language manifest payload:

```rust
pub struct LanguageManifest {
  pub format_version: u32,
  pub source: AssetSourceRef,
  pub entries: Vec<LanguageAssetEntry>,
}

pub struct LanguageAssetEntry {
  pub id: String,
  pub scope_name: String,
  pub asset_file: String,
  pub display_name: Option<String>,
  pub aliases: Vec<String>,
  pub embedded_langs: Vec<String>,
  pub embedded_langs_lazy: Vec<String>,
  pub inject_to: Vec<String>,
}
```

Theme manifest payload:

```rust
pub struct ThemeManifest {
  pub format_version: u32,
  pub source: AssetSourceRef,
  pub entries: Vec<ThemeAssetEntry>,
}

pub struct ThemeAssetEntry {
  pub id: String,
  pub asset_file: String,
  pub display_name: Option<String>,
  pub theme_type: Option<String>,
}
```

Manifest invariants:

- `id` is the logical lookup key.
- `asset_file` is a filename relative to the catalog directory.
- language aliases are resolved through the manifest before loading a `.fkgram`
  file.
- manifests are expected to be deterministic for the same upstream input.

## `.fkgram`

Language asset payload:

```rust
pub struct LanguageAsset {
  pub format_version: u32,
  pub id: String,
  pub scope_name: String,
  pub display_name: Option<String>,
  pub aliases: Vec<String>,
  pub embedded_langs: Vec<String>,
  pub embedded_langs_lazy: Vec<String>,
  pub inject_to: Vec<String>,
  pub grammar_json: String,
}
```

Notes:

- `grammar_json` contains the upstream TextMate grammar JSON, compactly
  serialized after validation, not upstream JS module code.
- Generation does not rewrite grammar rules. Regex compatibility belongs in
  the mechanical vscode-textmate runtime adapter so the same grammar reaches
  Ferriki and the upstream oracle.
- Embedded-language and injection metadata is duplicated here intentionally so a
  loaded asset is self-describing.

## `.fktheme`

Theme asset payload:

```rust
pub struct ThemeAsset {
  pub format_version: u32,
  pub id: String,
  pub display_name: Option<String>,
  pub theme_type: Option<String>,
  pub theme_json: String,
}
```

Notes:

- `theme_json` preserves the upstream VS Code/TextMate theme object, including
  `colors`, `tokenColors`, and string-valued `fontStyle` declarations.
- Generation validates and compactly serializes the JSON. It only supplies the
  manifest ID as `name` when the source omits one.
- Theme interpretation belongs to the vscode-textmate-compatible runtime; the
  asset layer must not flatten selectors or collapse inherited font styles.

## Release Manifest

`assets/standard/release-manifest.json`
pins every payload for the CDN loading of
[ADR 0013](../adr/0013-cdn-loaded-standard-assets.md). The generator writes it
next to the two catalogs:

```json
{
  "manifestVersion": 1,
  "storageLayout": "language-hash-v2",
  "assets": {
    "languages/typescript.fkgram": {
      "sha256": "<lowercase hex>",
      "size": 123456,
      "formatVersion": 3
    }
  }
}
```

- Keys identify language/theme files in a local materialized catalog. With
  `storageLayout: "language-hash-v2"`, remote URLs use
  `https://assets.ferriki.dev/<language-id>/<short-hash>` or
  `https://assets.ferriki.dev/themes/<theme-id>/<short-hash>`. An absent layout
  resolves legacy `<commit>/assets/shiki/<key>` URLs for custom mirrors; the
  public CDN [no longer hosts them](./migrations/legacy-cdn.md). `language-hash-v1` uses
  full SHA-256 names; v2 encodes the first 64 digest bits modulo `62^8` in
  `0-9A-Za-z`, padded to eight characters. The complete digest remains the
  cache identity and integrity check.
- `manifestVersion` versions this JSON layout, independently of the binary
  `FORMAT_VERSION`.
- The reviewed metadata lives in `assets/catalog.json`; binary indexes and
  payloads are generated or downloaded local artifacts. A packaged `commit`
  records release provenance and does not select the content-addressed URL.
- The binary manifests keep the language and theme metadata (aliases,
  embedded languages, injections); the release manifest adds only what is
  needed to fetch and verify a payload. A consumer turns each entry into
  `AssetMetadata::new(digest, size, format_version)` for
  `StandardAssetCatalogs::from_source`.
- `tests/release_manifest.rs` fails when a payload changes without the
  manifest, when an entry is missing or stale, or when a digest does not match.

## Loader Behavior

Current runtime behavior in
[`src/asset_catalog.rs`](../src/asset_catalog.rs):

- read manifest bytes from disk
- check the format version, then decode
- resolve `id` or alias
- lazy-load the requested asset file
- check the format version, then decode
- cache the decoded Rust struct in memory

The same catalog API also accepts embedded manifest and asset bytes. Both
providers preserve lazy decoding and caching. A format change must explicitly
bump `format_version` and regenerate the files.

## Stability Rules

Format changes should follow these rules:

- If a field is added, removed, renamed, or reinterpreted, bump
  `FORMAT_VERSION`.
- Update generator and loader together, including the manifest reader in
  [`scripts/generate-ferriki-catalog.mjs`](../scripts/generate-ferriki-catalog.mjs).
- Regenerate `assets/standard/*`.
- Keep roundtrip tests green.
- Add or update targeted compatibility tests when semantic normalization
  changes.

This format is not yet a public interchange format. Backward compatibility is
useful inside the repo, but explicit versioning is more important than silent
best-effort decoding.

## Validation

Current test coverage includes:

- schema roundtrip stability in
  [`crates/ferriki-asset-gen/src/schema.rs`](../crates/ferriki-asset-gen/src/schema.rs)
- catalog load and cache behavior in
  [`src/asset_catalog.rs`](../src/asset_catalog.rs)
- generator normalization tests in
  [`crates/ferriki-asset-gen/src/import.rs`](../crates/ferriki-asset-gen/src/import.rs)

If the format becomes externally consumed later, the next step should be adding
an explicit binary header and stronger compatibility guarantees.
