use crate::generate::{GeneratedCatalog, write_language_catalog, write_theme_catalog};
use crate::import::{load_language_records_from_upstream, load_theme_records_from_upstream};
use crate::release_manifest::{RELEASE_MANIFEST_FILE, ReleaseManifest};
use crate::schema::AssetSourceRef;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct GeneratedCatalogSet {
    pub languages: GeneratedCatalog,
    pub themes: GeneratedCatalog,
    pub languages_dir: PathBuf,
    pub themes_dir: PathBuf,
    pub release_manifest_path: PathBuf,
}

pub fn generate_catalogs_from_upstream(
    upstream_dir: &Path,
    output_dir: &Path,
    source: AssetSourceRef,
) -> io::Result<GeneratedCatalogSet> {
    let language_records = load_language_records_from_upstream(upstream_dir)?;
    let theme_records = load_theme_records_from_upstream(upstream_dir)?;
    let languages_dir = output_dir.join("languages");
    let themes_dir = output_dir.join("themes");

    let languages = write_language_catalog(&languages_dir, source.clone(), &language_records)?;
    let themes = write_theme_catalog(&themes_dir, source, &theme_records)?;
    let release_manifest_path = output_dir.join(RELEASE_MANIFEST_FILE);
    fs::write(
        &release_manifest_path,
        ReleaseManifest::from_catalog_dir(output_dir)?.to_json(),
    )?;

    Ok(GeneratedCatalogSet {
        languages,
        themes,
        languages_dir,
        themes_dir,
        release_manifest_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{decode_language_manifest, decode_theme_manifest};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_output_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("ferriki-{label}-{nanos}"))
    }

    #[test]
    fn generate_catalogs_from_upstream_writes_both_catalogs() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/upstream/textmate-grammars-themes");
        let output_dir = temp_output_dir("catalog-set");
        let source = AssetSourceRef {
            upstream: "textmate-grammars-themes".to_owned(),
            version: Some("1.0.0".to_owned()),
            commit: Some("abc123".to_owned()),
        };

        let generated = generate_catalogs_from_upstream(&upstream_dir, &output_dir, source.clone())
            .expect("generate");

        let language_manifest = decode_language_manifest(
            &fs::read(generated.languages.manifest_path).expect("language manifest"),
        )
        .expect("decode language manifest");
        let theme_manifest = decode_theme_manifest(
            &fs::read(generated.themes.manifest_path).expect("theme manifest"),
        )
        .expect("decode theme manifest");

        assert_eq!(language_manifest.source, source);
        assert_eq!(theme_manifest.source, source);
        assert_eq!(language_manifest.entries.len(), 1);
        assert_eq!(theme_manifest.entries.len(), 1);

        let release = ReleaseManifest::from_json(
            &fs::read_to_string(&generated.release_manifest_path).expect("release manifest"),
        )
        .expect("parse release manifest");
        let expected: Vec<String> = language_manifest
            .entries
            .iter()
            .map(|entry| format!("languages/{}", entry.asset_file))
            .chain(
                theme_manifest
                    .entries
                    .iter()
                    .map(|entry| format!("themes/{}", entry.asset_file)),
            )
            .collect();
        assert_eq!(release.assets.keys().cloned().collect::<Vec<_>>(), expected);
        assert_eq!(release.commit, None);

        fs::remove_dir_all(output_dir).expect("cleanup");
    }
}
