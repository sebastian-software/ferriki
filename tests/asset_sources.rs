use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ferriki::{
    AssetDigest, AssetMetadata, AssetSource, DirectoryAssetSource, EmbeddedAssetSource, ErrorKind,
    Highlighter, StandardAssetCatalogs,
};
use ferriki_asset_gen::{FORMAT_VERSION, decode_language_manifest, decode_theme_manifest};

struct Fixture {
    languages: Vec<u8>,
    themes: Vec<u8>,
    metadata: HashMap<String, AssetMetadata>,
    bytes: HashMap<AssetDigest, Cow<'static, [u8]>>,
}

fn fixture() -> Fixture {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/shiki");
    let languages = std::fs::read(root.join("languages/manifest.fkindex")).unwrap();
    let themes = std::fs::read(root.join("themes/manifest.fkindex")).unwrap();
    let paths = decode_language_manifest(&languages)
        .unwrap()
        .entries
        .into_iter()
        .map(|entry| format!("languages/{}", entry.asset_file))
        .chain(
            decode_theme_manifest(&themes)
                .unwrap()
                .entries
                .into_iter()
                .map(|entry| format!("themes/{}", entry.asset_file)),
        );
    let mut metadata = HashMap::new();
    let mut bytes = HashMap::new();
    for path in paths {
        let payload = std::fs::read(root.join(&path)).unwrap();
        let digest = AssetDigest::of(&payload);
        metadata.insert(
            path,
            AssetMetadata::new(digest.clone(), payload.len() as u64, FORMAT_VERSION),
        );
        bytes.insert(digest, Cow::Owned(payload));
    }
    Fixture {
        languages,
        themes,
        metadata,
        bytes,
    }
}

struct ObservedSource {
    inner: EmbeddedAssetSource,
    reads: Arc<AtomicUsize>,
}

impl AssetSource for ObservedSource {
    fn read(&self, digest: &AssetDigest) -> ferriki::Result<Cow<'_, [u8]>> {
        self.reads.fetch_add(1, Ordering::Relaxed);
        self.inner.read(digest)
    }
}

#[test]
fn verified_catalogs_are_lazy_and_reuse_decoded_assets() {
    let fixture = fixture();
    let reads = Arc::new(AtomicUsize::new(0));
    let source = ObservedSource {
        inner: EmbeddedAssetSource::new(fixture.bytes),
        reads: Arc::clone(&reads),
    };
    let catalogs = StandardAssetCatalogs::from_source(
        &fixture.languages,
        &fixture.themes,
        fixture.metadata,
        source,
    )
    .unwrap();
    assert_eq!(reads.load(Ordering::Relaxed), 0);
    assert_eq!(catalogs.resolve_language("rs"), Some("rust"));
    let mut highlighter = Highlighter::builder()
        .with_assets(catalogs)
        .load_languages(["rust"])
        .load_themes(["nord"])
        .build()
        .unwrap();
    let loaded = reads.load(Ordering::Relaxed);
    assert!(loaded >= 2);
    for _ in 0..2 {
        assert!(
            !highlighter
                .highlight("fn main() {}", "rust", "nord")
                .unwrap()
                .tokens
                .is_empty()
        );
    }
    assert_eq!(reads.load(Ordering::Relaxed), loaded);
}

#[test]
fn manifests_from_another_format_version_fail_with_a_format_error() {
    let fixture = fixture();
    // Every manifest starts with its format version as a one-byte varint.
    let mut older = fixture.languages.clone();
    assert_eq!(u32::from(older[0]), FORMAT_VERSION);
    older[0] = 2;
    // A format 2 file encoded with the previous codec starts `02 00 00 00`.
    let mut legacy = vec![2, 0, 0, 0];
    legacy.extend_from_slice(&fixture.languages[1..]);
    for manifest in [older, legacy] {
        let error = StandardAssetCatalogs::from_source(
            &manifest,
            &fixture.themes,
            fixture.metadata.clone(),
            EmbeddedAssetSource::new(fixture.bytes.clone()),
        )
        .expect_err("a manifest from another format version must fail");
        assert_eq!(error.kind(), ErrorKind::AssetFormat);
        let source = std::error::Error::source(&error).expect("codec error source");
        assert!(
            source
                .to_string()
                .contains(&format!("format version 2; expected {FORMAT_VERSION}")),
            "{source}"
        );
    }
}

#[test]
fn tampered_payloads_are_rejected_before_decoding() {
    let mut fixture = fixture();
    let digest = fixture.metadata["themes/nord.fktheme"].digest().clone();
    fixture.bytes.get_mut(&digest).unwrap().to_mut()[0] ^= 0xff;
    let catalogs = StandardAssetCatalogs::from_source(
        &fixture.languages,
        &fixture.themes,
        fixture.metadata,
        EmbeddedAssetSource::new(fixture.bytes),
    )
    .unwrap();
    let error = Highlighter::builder()
        .with_assets(catalogs)
        .load_themes(["nord"])
        .build()
        .expect_err("corrupt source must fail");
    assert_eq!(error.kind(), ErrorKind::AssetIntegrity);
}

#[test]
fn byte_size_and_format_are_pinned_even_when_digest_matches() {
    for format_mismatch in [false, true] {
        let mut fixture = fixture();
        let meta = &fixture.metadata["themes/nord.fktheme"];
        fixture.metadata.insert(
            "themes/nord.fktheme".into(),
            AssetMetadata::new(
                meta.digest().clone(),
                meta.size() + u64::from(!format_mismatch),
                if format_mismatch {
                    FORMAT_VERSION + 1
                } else {
                    FORMAT_VERSION
                },
            ),
        );
        let result = StandardAssetCatalogs::from_source(
            &fixture.languages,
            &fixture.themes,
            fixture.metadata,
            EmbeddedAssetSource::new(fixture.bytes),
        );
        if format_mismatch {
            assert_eq!(
                result.expect_err("unsupported format").kind(),
                ErrorKind::AssetFormat
            );
        } else {
            let error = Highlighter::builder()
                .with_assets(result.unwrap())
                .load_themes(["nord"])
                .build()
                .expect_err("wrong size");
            assert_eq!(error.kind(), ErrorKind::AssetIntegrity);
        }
    }
}

#[test]
fn missing_metadata_and_offline_payloads_have_distinct_errors() {
    let fixture = fixture();
    let incomplete = StandardAssetCatalogs::from_source(
        &fixture.languages,
        &fixture.themes,
        [],
        EmbeddedAssetSource::default(),
    );
    assert_eq!(
        incomplete.expect_err("missing metadata").kind(),
        ErrorKind::AssetFormat
    );
    let catalogs = StandardAssetCatalogs::from_source(
        &fixture.languages,
        &fixture.themes,
        fixture.metadata,
        EmbeddedAssetSource::default(),
    )
    .unwrap();
    let error = Highlighter::builder()
        .with_assets(catalogs)
        .load_themes(["nord"])
        .build()
        .expect_err("offline miss");
    assert_eq!(error.kind(), ErrorKind::AssetUnavailable);
    assert!(error.to_string().contains("pre-populated cache"));
}

#[test]
fn digest_names_are_normalized_and_cannot_escape_a_directory() {
    let digest = AssetDigest::of(b"abc");
    assert_eq!(
        digest.as_str(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        digest
            .as_str()
            .to_uppercase()
            .parse::<AssetDigest>()
            .unwrap(),
        digest
    );
    assert!("../outside".parse::<AssetDigest>().is_err());
    assert!("z".repeat(64).parse::<AssetDigest>().is_err());
    let root = std::env::temp_dir().join(format!("ferriki-digest-source-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let source = DirectoryAssetSource::new(&root);
    std::fs::write(root.join(digest.as_str()), b"abc").unwrap();
    assert_eq!(source.read(&digest).unwrap().as_ref(), b"abc");
    let missing = source.read(&AssetDigest::of(b"missing")).unwrap_err();
    assert_eq!(missing.kind(), ErrorKind::AssetUnavailable);
    assert!(std::error::Error::source(&missing).is_some());
    std::fs::remove_dir_all(root).unwrap();
}
