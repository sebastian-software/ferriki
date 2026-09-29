//! Encoder and decoder for Ferriki's binary grammar and theme catalogs, plus
//! the generator that builds them from an upstream grammar collection.
//!
//! The format is versioned by [`FORMAT_VERSION`]. The schema types are
//! `#[non_exhaustive]`: read them through their public fields and create
//! catalogs with [`generate_catalogs_from_upstream`].

mod generate;
mod import;
mod pipeline;
mod release_manifest;
mod schema;

pub use generate::GeneratedCatalog;
pub use pipeline::{GeneratedCatalogSet, generate_catalogs_from_upstream};
pub use release_manifest::{
    RELEASE_MANIFEST_FILE, RELEASE_MANIFEST_VERSION, ReleaseAsset, ReleaseManifest,
};
pub use schema::{
    AssetSourceRef, CodecError, FORMAT_VERSION, LanguageAsset, LanguageAssetEntry,
    LanguageManifest, ThemeAsset, ThemeAssetEntry, ThemeManifest, decode_language_asset,
    decode_language_manifest, decode_theme_asset, decode_theme_manifest, encode_language_asset,
    encode_language_manifest, encode_theme_asset, encode_theme_manifest,
};
