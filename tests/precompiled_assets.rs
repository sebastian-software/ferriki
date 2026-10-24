//! Differential coverage for standard bytecode, including verification and fallback.

use ferriki::{
    AssetDigest, AssetMetadata, EmbeddedAssetSource, Highlighter, StandardAssetCatalogs,
    TokenizeOptions,
};
use ferriki_asset_gen::ReleaseManifest;
use std::borrow::Cow;
use std::path::Path;

fn highlighter(mode: &str, prefilter: bool) -> Highlighter {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/standard");
    let release = ReleaseManifest::from_json(
        &std::fs::read_to_string(root.join("release-manifest.json")).unwrap(),
    )
    .unwrap();
    let mut metadata = Vec::new();
    let mut payloads = Vec::new();
    for (path, asset) in release.assets {
        let bytecode = path.ends_with(".fkbc");
        if bytecode && mode == "source" {
            continue;
        }
        let mut bytes = std::fs::read(root.join(&path)).unwrap();
        let mut digest: AssetDigest = asset.sha256.parse().unwrap();
        let mut size = asset.size;
        let mut version = asset.format_version;
        if bytecode {
            match mode {
                "malformed" => {
                    bytes = vec![0; 16];
                    digest = AssetDigest::of(&bytes);
                    size = bytes.len() as u64;
                }
                "tampered" => bytes[0] ^= 0xff,
                "version" => version += 1,
                _ => {}
            }
        }
        metadata.push((path, AssetMetadata::new(digest.clone(), size, version)));
        if !bytecode || mode != "missing" {
            payloads.push((digest, Cow::Owned(bytes)));
        }
    }
    let catalogs = StandardAssetCatalogs::from_source(
        &std::fs::read(root.join("languages/manifest.fkindex")).unwrap(),
        &std::fs::read(root.join("themes/manifest.fkindex")).unwrap(),
        metadata,
        EmbeddedAssetSource::new(payloads),
    )
    .unwrap();
    Highlighter::builder()
        .with_assets(catalogs)
        .with_regex_prefilter(prefilter)
        .build()
        .unwrap()
}

#[test]
fn standard_bytecode_matches_source_for_curated_and_tiobe_fixtures() {
    // Compare complete tokenization. A wall-clock cutoff can stop only one
    // lane on a loaded debug runner; budget behavior has separate coverage.
    let options = TokenizeOptions::default().with_time_limit_millis(0);
    for prefilter in [false, true] {
        let mut source = highlighter("source", prefilter);
        let mut prepared = highlighter("prepared", prefilter);
        for corpus in ["curated", "tiobe"] {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("node/benchmarks")
                .join(corpus);
            let manifest: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(root.join("manifest.json")).unwrap())
                    .unwrap();
            for fixture in manifest["languages"].as_array().unwrap() {
                let Some(language) = fixture["textmate"].as_str() else {
                    continue;
                };
                // TIOBE also imports custom grammars outside the standard catalog;
                // those have no standard bytecode sidecar to compare.
                if corpus == "tiobe"
                    && [
                        "vb",
                        "fortran-free-form",
                        "pascal",
                        "asm",
                        "ada",
                        "objective-c",
                        "cobol",
                    ]
                    .contains(&language)
                {
                    continue;
                }
                let code = std::fs::read_to_string(
                    root.join("fixtures")
                        .join(fixture["file"].as_str().unwrap()),
                )
                .unwrap();
                let expected = source
                    .highlight_with_options(&code, language, "nord", &options)
                    .unwrap();
                let actual = prepared
                    .highlight_with_options(&code, language, "nord", &options)
                    .unwrap();
                assert_eq!(
                    serde_json::to_value(actual).unwrap(),
                    serde_json::to_value(expected).unwrap(),
                    "{corpus}/{language}, prefilter={prefilter}"
                );
                assert_eq!(
                    prepared.backtracking_warnings(language).unwrap(),
                    source.backtracking_warnings(language).unwrap()
                );
            }
        }
    }
}

#[test]
fn optional_bytecode_failure_preserves_source_highlighting() {
    let expected = serde_json::to_value(
        highlighter("source", true)
            .highlight("fn main() { println!(\"😀\"); }", "rust", "nord")
            .unwrap(),
    )
    .unwrap();
    for mode in ["missing", "tampered", "malformed", "version"] {
        let actual = highlighter(mode, true)
            .highlight("fn main() { println!(\"😀\"); }", "rust", "nord")
            .unwrap();
        assert_eq!(serde_json::to_value(actual).unwrap(), expected, "{mode}");
    }
}
