# Ferriki Asset Pipeline Design

Last updated: 2026-10-13

Ferriki owns its standard grammar selection, metadata, pinned original sources,
and generated binary catalogs. The native TextMate tokenizer and asset loaders
serve both standard and user-provided grammars. Shiki remains a compatibility
test reference; grammar sync does not read its generated modules.

The durable decisions are [ADR 0006](../adr/0006-lazy-shiki-asset-loading.md),
[ADR 0013](../adr/0013-cdn-loaded-standard-assets.md),
[ADR 0015](../adr/0015-postcard-asset-codec.md), and
[ADR 0020](../adr/0020-curated-grammar-sources.md).

## Sources and generation

1. `assets/grammars/repositories.json` configures two maintained collections
   and six justified exceptions. `catalog.json` owns language selectors, stable
   IDs and aliases, scope variants, embedding policy, and scope patches.
2. `prepare-grammar-update.mjs` resolves each repository ref once, discovers
   TextMate grammars through editor manifests or Linguist's pinned modules,
   converts JSON/YAML/XML PLIST/data-only CSON, and writes a separate candidate
   plus report. `sources.json` is the generated repository/file lock. Regex
   expressions remain as authored. Required supported dependencies are included
   transitively; newly discovered primary languages are reported for selection.
3. The normalized JSON lives under
   `assets/upstream/curated/`. This historical directory also
   retains the existing theme snapshots. Both are ignored local data materialized
   from immutable Bunny objects or verified pinned sources.
4. `ferriki-asset-gen` writes the two versioned binary catalogs and the release
   manifest under the ignored `assets/standard/` build directory. `scripts/generate-ferriki-catalog.mjs` derives enumerable
   Node metadata from the binary manifests without including payloads.
5. `scripts/sync-grammars.mjs --check` verifies materialized sources against committed locks, dependency
   metadata, and grammar notices without network access. The compatibility
   gate exercises all standard grammars through native compilation and checks
   external imports.

Native candidate validation precedes `apply-grammar-update.mjs`. Preparation
with `--locked` reproduces accepted repository snapshots. The weekly/manual
Grammar updates workflow validates the candidate and compatibility gate before
uploading immutable source/payload objects, verifying the public CDN, and
opening a draft PR containing metadata and pins. Normalized diffs and full
candidate data remain workflow artifacts. Failures retain diagnostic artifacts.

The old Shiki bootstrap and `textmate-grammars-themes` sync scripts target
`assets/compat/` by default and are compatibility-reference tools.

## Runtime and distribution

The catalogs contain one `.fkgram` or `.fktheme` per item, one `.fkindex` manifest
per kind, a metadata-only `catalog.mjs`, and a `release-manifest.json` pinning
payload digest, size, and format version. `GRAMMAR-NOTICES.md` contains the
original source links and archived grammar license notices.

Published packages contain catalog metadata and notices. Payloads are fetched
asynchronously from language/theme hash URLs selected by the release catalog, verified by digest, and cached.
Rust can also use directory or embedded sources and has an optional `remote`
feature. Asset decoding and native compilation happen only when needed.

Required embedded languages load with their host. Lazy embeddings use languages
that the application loads explicitly. The standard catalog has a deliberate
scope; unsupported external scopes do not trigger arbitrary downloads.

## External grammars

The npm package's `ferriki grammar fetch` command accepts JSON TextMate data
from a file, URL, or commit-pinned GitHub file. It produces a native-validated
registration plus a source lock. Existing `langs` and `loadLanguage` APIs
consume the registration. Rust callers can use `register_language_json` or a
typed `LanguageRegistration`. Themes use the existing registration APIs.

The importer executes no downloaded extension code. Users register external
embedded languages and injections explicitly. It does not discover VS Code
extensions, convert CSON, or promise exhaustive static backtracking analysis.

See [the grammar guide](grammars.md) for the standard coverage, source
maintenance commands, importer options, and migration from the former catalog.
