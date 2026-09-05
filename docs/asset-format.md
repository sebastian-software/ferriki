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
- Encoding: `serde` + `bincode`
- Current format version: `2`
- Source of truth for structs and roundtrip tests:
  - [`crates/ferriki-asset-gen/src/schema.rs`](../crates/ferriki-asset-gen/src/schema.rs)
  - [`crates/ferriki-core/src/asset_catalog.rs`](../crates/ferriki-core/src/asset_catalog.rs)

There is currently no custom magic header or checksum layer. The loader relies
on the file extension, the enclosing catalog path, and successful `bincode`
decode into the expected Rust structs.

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
[`crates/ferriki-core/src/asset_catalog.rs`](../crates/ferriki-core/src/asset_catalog.rs):

- read manifest bytes from disk
- decode with `bincode`
- resolve `id` or alias
- lazy-load the requested asset file
- decode with `bincode`
- cache the decoded Rust struct in memory

The current implementation is file-based. Future embedding or packaging changes
may change how bytes are sourced, but should preserve the logical asset schema
or explicitly bump `format_version`.

## Stability Rules

Format changes should follow these rules:

- If a field is added, removed, renamed, or reinterpreted, bump
  `FORMAT_VERSION`.
- Update generator and loader together.
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
  [`crates/ferriki-core/src/asset_catalog.rs`](../crates/ferriki-core/src/asset_catalog.rs)
- generator normalization tests in
  [`crates/ferriki-asset-gen/src/import.rs`](../crates/ferriki-asset-gen/src/import.rs)

If the format becomes externally consumed later, the next step should be adding
an explicit binary header and stronger compatibility guarantees.
