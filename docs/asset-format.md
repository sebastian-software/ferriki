# Ferriki Asset Format

Ferriki stores generated standard language and theme catalogs in a compact
binary format under [`assets/shiki`](../assets/shiki).

This format is currently an internal Ferriki implementation detail. It exists
to decouple the runtime from upstream JS build artifacts and to give the Rust
core a stable generator/loader contract.

## Status

- File extensions:
  - `.fkgram`: one language asset
  - `.fktheme`: one theme asset
  - `.fkindex`: one manifest for a catalog
- Encoding: `serde` + [`postcard`](https://docs.rs/postcard): unsigned
  integers and lengths are LEB128 varints, strings are length-prefixed UTF-8,
  `Option` is a `0`/`1` tag followed by the value
- Current format version: `3` (format `2` used `bincode` 1.x, which is
  unmaintained, RUSTSEC-2025-0141)
- Source of truth for structs and roundtrip tests:
  - [`crates/ferriki-asset-gen/src/schema.rs`](../crates/ferriki-asset-gen/src/schema.rs)
  - [`src/asset_catalog.rs`](../src/asset_catalog.rs)

There is no magic header. Every manifest and asset starts with its
`format_version`, so the decoder reads that varint first and reports a file
from another format version as `unsupported asset format version N` before it
looks at the payload. A format `2` file starts with `02 00 00 00`, whose first
byte decodes to the same version, so old files get the same clear error. Bytes
left over after the encoded value are rejected. Integrity against the release
manifest is checked separately by the `AssetSource` layer (SHA-256).

## Catalog Layout

Language catalog:

- [`assets/shiki/languages/manifest.fkindex`](../assets/shiki/languages/manifest.fkindex)
- one `.fkgram` file per language

Theme catalog:

- [`assets/shiki/themes/manifest.fkindex`](../assets/shiki/themes/manifest.fkindex)
- one `.fktheme` file per theme

The generated [`assets/shiki/catalog.mjs`](../assets/shiki/catalog.mjs) is the
Node-facing metadata projection of both manifests. It is intentionally kept
separate from the binary payloads so catalog enumeration remains lazy.

The manifest is loaded first. It maps logical IDs to asset filenames and carries
enough metadata for lazy lookup.

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
- Regenerate `assets/shiki/*`.
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
