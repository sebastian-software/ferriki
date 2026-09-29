//! The committed release manifest must pin exactly the committed payloads.
//! ADR 0013 release check: "the manifest digests match the files at the
//! release commit".

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use ferriki::{
    AssetDigest, AssetMetadata, EmbeddedAssetSource, Highlighter, StandardAssetCatalogs,
};
use ferriki_asset_gen::{
    FORMAT_VERSION, RELEASE_MANIFEST_FILE, ReleaseManifest, decode_language_manifest,
    decode_theme_manifest,
};

fn catalog_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/shiki")
}

fn committed_manifest() -> ReleaseManifest {
    let source = std::fs::read_to_string(catalog_dir().join(RELEASE_MANIFEST_FILE))
        .expect("assets/shiki/release-manifest.json exists; regenerate the assets");
    ReleaseManifest::from_json(&source).expect("release manifest parses")
}

#[test]
fn release_manifest_matches_the_committed_payloads() {
    let manifest = committed_manifest();
    assert_eq!(
        manifest.commit, None,
        "the repository copy carries no commit; the release build sets it"
    );
    for (path, asset) in &manifest.assets {
        let bytes = std::fs::read(catalog_dir().join(path))
            .unwrap_or_else(|error| panic!("{path} is pinned but unreadable: {error}"));
        assert_eq!(
            AssetDigest::of(&bytes).as_str(),
            asset.sha256,
            "{path} changed without regenerating the release manifest"
        );
        assert_eq!(bytes.len() as u64, asset.size, "{path} size");
        assert_eq!(asset.format_version, FORMAT_VERSION, "{path} format");
    }
    assert_eq!(
        ReleaseManifest::from_catalog_dir(&catalog_dir()).expect("hash catalog"),
        manifest,
        "payloads on disk and the release manifest differ; regenerate the assets"
    );
}

#[test]
fn release_manifest_pins_every_catalog_entry() {
    let manifest = committed_manifest();
    let languages = decode_language_manifest(
        &std::fs::read(catalog_dir().join("languages/manifest.fkindex")).unwrap(),
    )
    .unwrap();
    let themes = decode_theme_manifest(
        &std::fs::read(catalog_dir().join("themes/manifest.fkindex")).unwrap(),
    )
    .unwrap();
    let referenced: BTreeSet<String> = languages
        .entries
        .iter()
        .map(|entry| format!("languages/{}", entry.asset_file))
        .chain(
            themes
                .entries
                .iter()
                .map(|entry| format!("themes/{}", entry.asset_file)),
        )
        .collect();
    let pinned: BTreeSet<String> = manifest.assets.keys().cloned().collect();
    assert_eq!(pinned, referenced);
}

#[test]
fn release_manifest_serves_as_trusted_source_metadata() {
    let manifest = committed_manifest();
    let mut metadata = HashMap::new();
    let mut payloads = HashMap::new();
    for (path, asset) in &manifest.assets {
        let digest: AssetDigest = asset.sha256.parse().expect("digest parses");
        metadata.insert(
            path.clone(),
            AssetMetadata::new(digest.clone(), asset.size, asset.format_version),
        );
        payloads.insert(
            digest,
            Cow::Owned(std::fs::read(catalog_dir().join(path)).unwrap()),
        );
    }
    let catalogs = StandardAssetCatalogs::from_source(
        &std::fs::read(catalog_dir().join("languages/manifest.fkindex")).unwrap(),
        &std::fs::read(catalog_dir().join("themes/manifest.fkindex")).unwrap(),
        metadata,
        EmbeddedAssetSource::new(payloads),
    )
    .expect("catalogs from release metadata");
    let mut highlighter = Highlighter::builder()
        .with_assets(catalogs)
        .load_languages(["rust"])
        .load_themes(["nord"])
        .build()
        .expect("highlighter");
    let tokens = highlighter
        .highlight("fn main() {}", "rust", "nord")
        .expect("highlight");
    assert!(tokens.tokens[0].len() > 1);
}
