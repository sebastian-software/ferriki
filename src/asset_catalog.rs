#[cfg(all(feature = "remote", not(target_arch = "wasm32")))]
use crate::remote::{RemoteAssetSource, RemoteAssets};
use ferriki_asset_gen::ReleaseManifest;
use ferriki_asset_gen::{
    FORMAT_VERSION, LanguageAsset, LanguageAssetEntry, LanguageManifest, ThemeAsset,
    ThemeAssetEntry, ThemeManifest, decode_language_asset, decode_language_manifest,
    decode_theme_asset, decode_theme_manifest,
};
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::{AssetMetadata, AssetSource, Error, ErrorKind, Result};

pub struct StandardAssetCatalogs {
    pub(crate) languages: LanguageAssetCatalog,
    pub(crate) themes: ThemeAssetCatalog,
}

impl std::fmt::Debug for StandardAssetCatalogs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StandardAssetCatalogs")
            .field("languages", &self.languages.entries_by_id.len())
            .field("themes", &self.themes.entries_by_id.len())
            .finish_non_exhaustive()
    }
}

impl StandardAssetCatalogs {
    pub fn load_from_root(root_dir: &Path) -> Result<Self> {
        Ok(Self {
            languages: LanguageAssetCatalog::load_from_dir(&root_dir.join("languages"))?,
            themes: ThemeAssetCatalog::load_from_dir(&root_dir.join("themes"))?,
        })
    }

    /// Builds lazy catalogs from embedded binary manifests and asset bytes.
    ///
    /// The binary format is versioned and validated on load. Applications can
    /// use `include_bytes!` for the manifests and chosen assets, without a
    /// filesystem or a Node package at runtime.
    pub fn from_embedded(
        language_manifest: &[u8],
        language_assets: impl IntoIterator<Item = (String, Cow<'static, [u8]>)>,
        theme_manifest: &[u8],
        theme_assets: impl IntoIterator<Item = (String, Cow<'static, [u8]>)>,
    ) -> Result<Self> {
        Ok(Self {
            languages: LanguageAssetCatalog::from_embedded(
                language_manifest,
                language_assets.into_iter().collect(),
            )?,
            themes: ThemeAssetCatalog::from_embedded(
                theme_manifest,
                theme_assets.into_iter().collect(),
            )?,
        })
    }

    /// Creates lazy, verified catalogs from binary manifests, a release manifest
    /// that pins every payload, and a digest-addressed source. This is
    /// [`Self::from_source`] with the metadata taken from the release manifest.
    pub fn from_release_manifest(
        language_manifest: &[u8],
        theme_manifest: &[u8],
        release: &ReleaseManifest,
        source: impl AssetSource + 'static,
    ) -> Result<Self> {
        let metadata = release
            .assets
            .iter()
            .map(|(path, asset)| {
                Ok((
                    path.clone(),
                    AssetMetadata::new(asset.sha256.parse()?, asset.size, asset.format_version),
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        Self::from_source(language_manifest, theme_manifest, metadata, source)
    }

    /// Loads this release's standard catalogs, downloading each payload from the
    /// release-pinned CDN on first use and caching it by digest (ADR 0013).
    ///
    /// The catalog manifests and the release manifest are compiled in, so
    /// language and theme resolution works offline. See [`RemoteAssets`] for
    /// the mirror, cache, commit and download settings and their environment
    /// variables.
    #[cfg(all(feature = "remote", not(target_arch = "wasm32")))]
    pub fn remote(settings: RemoteAssets) -> Result<Self> {
        const LANGUAGES: &[u8] = include_bytes!("../assets/shiki/languages/manifest.fkindex");
        const THEMES: &[u8] = include_bytes!("../assets/shiki/themes/manifest.fkindex");
        const RELEASE: &str = include_str!("../assets/shiki/release-manifest.json");
        let release = ReleaseManifest::from_json(RELEASE).map_err(|source| {
            Error::new(
                ErrorKind::AssetFormat,
                "Failed to parse the release manifest.",
            )
            .with_source(source)
        })?;
        let resolved = settings.resolve(&release, |key| std::env::var(key).ok())?;
        let source = RemoteAssetSource::new(&release, resolved)?;
        Self::from_release_manifest(LANGUAGES, THEMES, &release, source)
    }

    /// Creates lazy, verified catalogs from binary manifests and a digest-addressed source.
    /// Metadata keys are `languages/<asset_file>` and `themes/<asset_file>`.
    /// The manifests and metadata must come from the same trusted release.
    /// No payload is read until its language or theme is loaded.
    pub fn from_source(
        language_manifest: &[u8],
        theme_manifest: &[u8],
        metadata: impl IntoIterator<Item = (String, AssetMetadata)>,
        source: impl AssetSource + 'static,
    ) -> Result<Self> {
        let languages = decode_language_manifest(language_manifest).map_err(|source| {
            Error::new(
                ErrorKind::AssetFormat,
                "Failed to decode language manifest.",
            )
            .with_source(source)
        })?;
        let themes = decode_theme_manifest(theme_manifest).map_err(|source| {
            Error::new(ErrorKind::AssetFormat, "Failed to decode theme manifest.")
                .with_source(source)
        })?;
        let metadata: HashMap<_, _> = metadata.into_iter().collect();
        for path in languages
            .entries
            .iter()
            .map(|entry| format!("languages/{}", entry.asset_file))
            .chain(
                themes
                    .entries
                    .iter()
                    .map(|entry| format!("themes/{}", entry.asset_file)),
            )
        {
            metadata
                .get(&path)
                .ok_or_else(|| {
                    Error::new(
                        ErrorKind::AssetFormat,
                        format!("Release metadata is missing `{path}`."),
                    )
                })?
                .validate_format()?;
        }
        let metadata = Arc::new(metadata);
        let source: Arc<dyn AssetSource> = Arc::new(source);
        Ok(Self {
            languages: LanguageAssetCatalog::from_manifest(
                languages,
                AssetStore::Verified {
                    prefix: "languages",
                    metadata: Arc::clone(&metadata),
                    source: Arc::clone(&source),
                },
            )?,
            themes: ThemeAssetCatalog::from_manifest(
                themes,
                AssetStore::Verified {
                    prefix: "themes",
                    metadata,
                    source,
                },
            )?,
        })
    }

    /// Enumerates bundled language IDs without decoding grammar payloads.
    pub fn language_ids(&self) -> impl Iterator<Item = &str> {
        self.languages
            .manifest()
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
    }

    /// Enumerates bundled theme IDs without decoding theme payloads.
    pub fn theme_ids(&self) -> impl Iterator<Item = &str> {
        self.themes
            .manifest()
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
    }

    /// Resolves a standard language ID, alias, or scope name.
    pub fn resolve_language(&self, requested: &str) -> Option<&str> {
        self.languages.resolve_id(requested)
    }
}

enum AssetStore {
    Directory(PathBuf),
    Embedded(HashMap<String, Cow<'static, [u8]>>),
    Verified {
        prefix: &'static str,
        metadata: Arc<HashMap<String, AssetMetadata>>,
        source: Arc<dyn AssetSource>,
    },
}

impl AssetStore {
    fn read(&self, file: &str) -> Result<Cow<'_, [u8]>> {
        if Path::new(file).components().count() != 1
            || Path::new(file).file_name().and_then(|name| name.to_str()) != Some(file)
            || file == "."
            || file == ".."
        {
            return Err(Error::new(
                ErrorKind::AssetFormat,
                format!("Invalid Ferriki asset filename `{file}`."),
            ));
        }
        match self {
            Self::Verified {
                prefix,
                metadata,
                source,
            } => {
                let metadata = metadata.get(&format!("{prefix}/{file}")).ok_or_else(|| {
                    Error::new(
                        ErrorKind::AssetFormat,
                        format!("Release metadata is missing `{prefix}/{file}`."),
                    )
                })?;
                let bytes = source.read(metadata.digest())?;
                metadata.verify(&bytes)?;
                Ok(bytes)
            }
            Self::Directory(dir) => read_bytes(&dir.join(file)).map(Cow::Owned),
            Self::Embedded(assets) => assets
                .get(file)
                .map(|bytes| Cow::Borrowed(bytes.as_ref()))
                .ok_or_else(|| {
                    Error::new(
                        ErrorKind::AssetIo,
                        format!("Embedded Ferriki asset `{file}` is missing."),
                    )
                }),
        }
    }
}

pub(crate) struct LanguageAssetCatalog {
    asset_store: AssetStore,
    manifest: LanguageManifest,
    entries_by_id: HashMap<String, LanguageAssetEntry>,
    ids_by_scope: HashMap<String, String>,
    aliases: HashMap<String, String>,
    cache: RefCell<HashMap<String, Arc<LanguageAsset>>>,
}

impl LanguageAssetCatalog {
    pub(crate) fn load_from_dir(asset_dir: &Path) -> Result<Self> {
        let manifest_path = asset_dir.join("manifest.fkindex");
        let manifest = decode_language_manifest(&read_bytes(&manifest_path)?).map_err(|err| {
            Error::new(
                ErrorKind::AssetFormat,
                format!("Failed to decode language manifest: {err}"),
            )
        })?;
        Self::from_manifest(manifest, AssetStore::Directory(asset_dir.to_path_buf()))
    }

    /// Creates a catalog from an embedded manifest and lazy asset byte map.
    pub(crate) fn from_embedded(
        manifest_bytes: &[u8],
        assets: HashMap<String, Cow<'static, [u8]>>,
    ) -> Result<Self> {
        let manifest = decode_language_manifest(manifest_bytes).map_err(|err| {
            Error::new(
                ErrorKind::AssetFormat,
                format!("Failed to decode language manifest: {err}"),
            )
        })?;
        Self::from_manifest(manifest, AssetStore::Embedded(assets))
    }

    fn from_manifest(manifest: LanguageManifest, asset_store: AssetStore) -> Result<Self> {
        validate_format_version("language manifest", manifest.format_version)?;
        let mut entries_by_id = HashMap::with_capacity(manifest.entries.len());
        let mut ids_by_scope = HashMap::with_capacity(manifest.entries.len());
        let mut aliases = HashMap::new();

        for entry in &manifest.entries {
            for alias in &entry.aliases {
                aliases.insert(alias.clone(), entry.id.clone());
            }
            ids_by_scope.insert(entry.scope_name.clone(), entry.id.clone());
            entries_by_id.insert(entry.id.clone(), entry.clone());
        }

        Ok(Self {
            asset_store,
            manifest,
            entries_by_id,
            ids_by_scope,
            aliases,
            cache: RefCell::new(HashMap::new()),
        })
    }

    pub(crate) fn manifest(&self) -> &LanguageManifest {
        &self.manifest
    }

    pub(crate) fn resolve_id(&self, requested: &str) -> Option<&str> {
        if let Some((resolved_id, _entry)) = self.entries_by_id.get_key_value(requested) {
            return Some(resolved_id.as_str());
        }
        if let Some(resolved_id) = self.ids_by_scope.get(requested) {
            return Some(resolved_id);
        }
        self.aliases.get(requested).map(String::as_str)
    }

    pub(crate) fn load_asset(&self, requested: &str) -> Result<Option<Arc<LanguageAsset>>> {
        let Some(resolved_id) = self.resolve_id(requested) else {
            return Ok(None);
        };

        if let Some(cached) = self.cache.borrow().get(resolved_id) {
            return Ok(Some(cached.clone()));
        }

        let entry = self.entries_by_id.get(resolved_id).ok_or_else(|| {
            Error::from_reason("Ferriki language asset entry missing after resolution.")
        })?;
        let asset =
            decode_language_asset(&self.asset_store.read(&entry.asset_file)?).map_err(|err| {
                Error::new(
                    ErrorKind::AssetFormat,
                    format!("Failed to decode language asset `{resolved_id}`: {err}"),
                )
            })?;
        validate_format_version(
            &format!("language asset `{resolved_id}`"),
            asset.format_version,
        )?;
        let asset = Arc::new(asset);
        self.cache
            .borrow_mut()
            .insert(resolved_id.to_owned(), asset.clone());
        Ok(Some(asset))
    }
}

pub(crate) struct ThemeAssetCatalog {
    asset_store: AssetStore,
    manifest: ThemeManifest,
    entries_by_id: HashMap<String, ThemeAssetEntry>,
    cache: RefCell<HashMap<String, Arc<ThemeAsset>>>,
}

impl ThemeAssetCatalog {
    pub(crate) fn load_from_dir(asset_dir: &Path) -> Result<Self> {
        let manifest_path = asset_dir.join("manifest.fkindex");
        let manifest = decode_theme_manifest(&read_bytes(&manifest_path)?).map_err(|err| {
            Error::new(
                ErrorKind::AssetFormat,
                format!("Failed to decode theme manifest: {err}"),
            )
        })?;
        Self::from_manifest(manifest, AssetStore::Directory(asset_dir.to_path_buf()))
    }

    /// Creates a catalog from an embedded manifest and lazy asset byte map.
    pub(crate) fn from_embedded(
        manifest_bytes: &[u8],
        assets: HashMap<String, Cow<'static, [u8]>>,
    ) -> Result<Self> {
        let manifest = decode_theme_manifest(manifest_bytes).map_err(|err| {
            Error::new(
                ErrorKind::AssetFormat,
                format!("Failed to decode theme manifest: {err}"),
            )
        })?;
        Self::from_manifest(manifest, AssetStore::Embedded(assets))
    }

    fn from_manifest(manifest: ThemeManifest, asset_store: AssetStore) -> Result<Self> {
        validate_format_version("theme manifest", manifest.format_version)?;
        let mut entries_by_id = HashMap::with_capacity(manifest.entries.len());
        for entry in &manifest.entries {
            entries_by_id.insert(entry.id.clone(), entry.clone());
        }

        Ok(Self {
            asset_store,
            manifest,
            entries_by_id,
            cache: RefCell::new(HashMap::new()),
        })
    }

    pub(crate) fn manifest(&self) -> &ThemeManifest {
        &self.manifest
    }

    pub(crate) fn load_asset(&self, requested: &str) -> Result<Option<Arc<ThemeAsset>>> {
        if let Some(cached) = self.cache.borrow().get(requested) {
            return Ok(Some(cached.clone()));
        }

        let Some(entry) = self.entries_by_id.get(requested) else {
            return Ok(None);
        };
        let asset =
            decode_theme_asset(&self.asset_store.read(&entry.asset_file)?).map_err(|err| {
                Error::new(
                    ErrorKind::AssetFormat,
                    format!("Failed to decode theme asset `{requested}`: {err}"),
                )
            })?;
        validate_format_version(&format!("theme asset `{requested}`"), asset.format_version)?;
        let asset = Arc::new(asset);
        self.cache
            .borrow_mut()
            .insert(requested.to_owned(), asset.clone());
        Ok(Some(asset))
    }
}

fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|err| {
        Error::new(
            ErrorKind::AssetIo,
            format!("Failed to read `{}`: {err}", path.display()),
        )
    })
}

fn validate_format_version(kind: &str, actual: u32) -> Result<()> {
    if actual == FORMAT_VERSION {
        return Ok(());
    }
    Err(Error::new(
        ErrorKind::AssetFormat,
        format!("Unsupported Ferriki {kind} format version {actual}; expected {FORMAT_VERSION}."),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferriki_asset_gen::{AssetSourceRef, generate_catalogs_from_upstream};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_output_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("ferriki-{label}-{nanos}"))
    }

    #[test]
    fn language_catalog_resolves_alias_and_caches_asset() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let output_dir = temp_output_dir("language-catalog-loader");
        generate_catalogs_from_upstream(
            &upstream_dir,
            &output_dir,
            AssetSourceRef::new(
                "textmate-grammars-themes".to_owned(),
                Some("1.0.0".to_owned()),
                Some("abc123".to_owned()),
            ),
        )
        .expect("generate");

        let catalog =
            LanguageAssetCatalog::load_from_dir(&output_dir.join("languages")).expect("catalog");
        assert_eq!(catalog.resolve_id("js"), Some("javascript"));
        assert_eq!(catalog.resolve_id("source.js"), Some("javascript"));

        let first = catalog.load_asset("js").expect("asset").expect("present");
        let second = catalog
            .load_asset("javascript")
            .expect("asset")
            .expect("present");
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(first.scope_name, "source.js");

        fs::remove_dir_all(output_dir).expect("cleanup");
    }

    #[test]
    fn language_catalog_finds_external_injections_by_target_scope() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let output_dir = temp_output_dir("language-catalog-injections");
        generate_catalogs_from_upstream(
            &upstream_dir,
            &output_dir,
            AssetSourceRef::new(
                "textmate-grammars-themes".to_owned(),
                Some("1.0.0".to_owned()),
                Some("abc123".to_owned()),
            ),
        )
        .expect("generate");

        let catalog =
            LanguageAssetCatalog::load_from_dir(&output_dir.join("languages")).expect("catalog");
        let injecting = catalog
            .manifest()
            .entries
            .iter()
            .filter(|entry| {
                entry
                    .inject_to
                    .iter()
                    .any(|scope| scope == "text.html.markdown")
            })
            .collect::<Vec<_>>();

        assert_eq!(injecting.len(), 1);
        assert_eq!(injecting[0].id, "javascript");

        fs::remove_dir_all(output_dir).expect("cleanup");
    }

    #[test]
    fn theme_catalog_loads_and_caches_asset() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let output_dir = temp_output_dir("theme-catalog-loader");
        generate_catalogs_from_upstream(
            &upstream_dir,
            &output_dir,
            AssetSourceRef::new(
                "textmate-grammars-themes".to_owned(),
                Some("1.0.0".to_owned()),
                Some("abc123".to_owned()),
            ),
        )
        .expect("generate");

        let catalog =
            ThemeAssetCatalog::load_from_dir(&output_dir.join("themes")).expect("catalog");
        let first = catalog
            .load_asset("vitesse-light")
            .expect("asset")
            .expect("present");
        let second = catalog
            .load_asset("vitesse-light")
            .expect("asset")
            .expect("present");
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(first.theme_type.as_deref(), Some("light"));

        fs::remove_dir_all(output_dir).expect("cleanup");
    }

    #[test]
    fn standard_catalogs_load_both_catalogs_from_root() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let output_dir = temp_output_dir("standard-asset-catalogs");
        generate_catalogs_from_upstream(
            &upstream_dir,
            &output_dir,
            AssetSourceRef::new(
                "textmate-grammars-themes".to_owned(),
                Some("1.0.0".to_owned()),
                Some("abc123".to_owned()),
            ),
        )
        .expect("generate");

        let catalogs = StandardAssetCatalogs::load_from_root(&output_dir).expect("catalogs");
        assert_eq!(catalogs.languages.resolve_id("js"), Some("javascript"));
        assert!(
            catalogs
                .themes
                .load_asset("vitesse-light")
                .expect("theme")
                .is_some()
        );

        fs::remove_dir_all(output_dir).expect("cleanup");
    }

    #[test]
    fn embedded_catalogs_work_after_the_filesystem_source_is_removed() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let output_dir = temp_output_dir("embedded-catalogs");
        generate_catalogs_from_upstream(
            &upstream_dir,
            &output_dir,
            AssetSourceRef::new(
                "textmate-grammars-themes".to_owned(),
                Some("1.0.0".to_owned()),
                Some("abc123".to_owned()),
            ),
        )
        .expect("generate");

        let language_dir = output_dir.join("languages");
        let theme_dir = output_dir.join("themes");
        let language_manifest = fs::read(language_dir.join("manifest.fkindex")).expect("manifest");
        let theme_manifest = fs::read(theme_dir.join("manifest.fkindex")).expect("manifest");
        let language_entries = decode_language_manifest(&language_manifest).expect("decode");
        let theme_entries = decode_theme_manifest(&theme_manifest).expect("decode");
        let language_assets: HashMap<String, Cow<'static, [u8]>> = language_entries
            .entries
            .iter()
            .map(|entry| {
                (
                    entry.asset_file.clone(),
                    Cow::Owned(
                        fs::read(language_dir.join(&entry.asset_file)).expect("language asset"),
                    ),
                )
            })
            .collect();
        let theme_assets: HashMap<String, Cow<'static, [u8]>> = theme_entries
            .entries
            .iter()
            .map(|entry| {
                (
                    entry.asset_file.clone(),
                    Cow::Owned(fs::read(theme_dir.join(&entry.asset_file)).expect("theme asset")),
                )
            })
            .collect();

        let catalogs = StandardAssetCatalogs::from_embedded(
            &language_manifest,
            language_assets,
            &theme_manifest,
            theme_assets,
        )
        .expect("embedded catalogs");
        fs::remove_dir_all(output_dir).expect("cleanup");

        let mut highlighter = crate::Highlighter::builder()
            .with_assets(catalogs)
            .load_languages(["js"])
            .load_themes(["vitesse-light"])
            .build()
            .expect("highlighter");
        let result = highlighter
            .highlight("const x = 1;", "js", "vitesse-light")
            .expect("highlight");
        assert!(!result.tokens[0].is_empty());
    }

    #[test]
    fn missing_embedded_asset_is_a_typed_io_error() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let output_dir = temp_output_dir("missing-embedded-asset");
        generate_catalogs_from_upstream(
            &upstream_dir,
            &output_dir,
            AssetSourceRef::new("textmate-grammars-themes".to_owned(), None, None),
        )
        .expect("generate");
        let language_manifest =
            fs::read(output_dir.join("languages/manifest.fkindex")).expect("manifest");
        let catalog = LanguageAssetCatalog::from_embedded(&language_manifest, HashMap::new())
            .expect("catalog");
        let error = catalog.load_asset("js").expect_err("missing asset");
        assert_eq!(error.kind(), ErrorKind::AssetIo);
        fs::remove_dir_all(output_dir).expect("cleanup");
    }

    #[test]
    fn borrowed_embedded_bytes_are_not_copied() {
        static ASSET: &[u8] = b"embedded";
        let store = AssetStore::Embedded(HashMap::from([(
            "asset.fkgram".to_owned(),
            Cow::Borrowed(ASSET),
        )]));
        let loaded = store.read("asset.fkgram").expect("borrowed asset");
        assert!(matches!(loaded, Cow::Borrowed(_)));
        assert_eq!(loaded.as_ptr(), ASSET.as_ptr());
    }
}
