//! Cache planning for the Node host. Network I/O stays in Node's fetch runtime.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use ferriki_asset_gen::{ReleaseManifest, decode_language_manifest, decode_theme_manifest};
use serde::Serialize;

use crate::asset_settings::{AssetSettingsInput, ResolvedAssetSettings, resolve_asset_settings};
use crate::{
    AssetDigest, AssetMetadata, AssetSource, DirectoryAssetSource, Error, ErrorKind, Result,
    StandardAssetCatalogs,
};

/// Settings supplied by the private N-API host. Unset fields use the same
/// environment and platform defaults as the Rust `remote` feature.
#[derive(Clone, Debug, Default)]
pub struct NodeAssetOptions {
    pub remote: Option<bool>,
    pub base_url: Option<String>,
    pub cache_dir: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlannedAsset {
    path: String,
    digest: String,
    size: u64,
    url: String,
}

/// Manifest-backed Node asset host. It only plans downloads and reads the
/// digest-addressed cache; JavaScript owns transport and cache writes.
pub struct NodeAssetHost {
    release: ReleaseManifest,
    settings: ResolvedAssetSettings,
    language_manifest: Vec<u8>,
    theme_manifest: Vec<u8>,
    languages: HashMap<String, (String, Vec<String>)>,
    language_aliases: HashMap<String, String>,
    themes: HashMap<String, String>,
}

impl NodeAssetHost {
    /// Reads the packaged catalog manifests and release manifest below `root`.
    pub fn from_root(root: &Path, options: &NodeAssetOptions) -> Result<Self> {
        let read = |relative: &str| {
            std::fs::read(root.join(relative)).map_err(|source| {
                Error::new(
                    ErrorKind::AssetIo,
                    format!("Cannot read `{}`.", root.join(relative).display()),
                )
                .with_source(source)
            })
        };
        let language_manifest = read("languages/manifest.fkindex")?;
        let theme_manifest = read("themes/manifest.fkindex")?;
        let release = ReleaseManifest::from_json(&String::from_utf8_lossy(&read(
            ferriki_asset_gen::RELEASE_MANIFEST_FILE,
        )?))
        .map_err(|source| {
            Error::new(
                ErrorKind::AssetFormat,
                "Failed to parse the release manifest.",
            )
            .with_source(source)
        })?;
        let format = |source| {
            Error::new(
                ErrorKind::AssetFormat,
                "Failed to decode a catalog manifest.",
            )
            .with_source(source)
        };
        let mut languages = HashMap::new();
        let mut language_aliases = HashMap::new();
        for entry in decode_language_manifest(&language_manifest)
            .map_err(format)?
            .entries
        {
            let path = catalog_path("languages", &entry.asset_file)?;
            for alias in &entry.aliases {
                language_aliases.insert(alias.clone(), entry.id.clone());
            }
            languages.insert(entry.id, (path, entry.embedded_langs));
        }
        let themes = decode_theme_manifest(&theme_manifest)
            .map_err(format)?
            .entries
            .into_iter()
            .map(|entry| Ok((entry.id, catalog_path("themes", &entry.asset_file)?)))
            .collect::<Result<_>>()?;
        let settings = resolve_asset_settings(
            AssetSettingsInput {
                remote: options.remote,
                base_url: options.base_url.clone(),
                cache_dir: options.cache_dir.clone(),
                commit: None,
                release_commit: release.commit.clone(),
                compiled_commit: option_env!("FERRIKI_RELEASE_COMMIT"),
                cache_hint: "set FERRIKI_CACHE_DIR or pass an explicit Node assets.cacheDir",
            },
            |key| std::env::var(key).ok(),
        )?;

        Ok(Self {
            release,
            settings,
            language_manifest,
            theme_manifest,
            languages,
            language_aliases,
            themes,
        })
    }

    /// Catalogs read only the verified digest-addressed cache. Missing bytes
    /// stay an `AssetUnavailable` error on synchronous Node paths.
    pub fn catalogs(&self) -> Result<StandardAssetCatalogs> {
        let paths_by_digest = self
            .release
            .assets
            .iter()
            .map(|(path, asset)| Ok((asset.sha256.parse::<AssetDigest>()?, path.clone())))
            .collect::<Result<HashMap<_, _>>>()?;
        StandardAssetCatalogs::from_release_manifest(
            &self.language_manifest,
            &self.theme_manifest,
            &self.release,
            NodeAssetSource {
                directory: DirectoryAssetSource::new(self.settings.cache_dir.clone()),
                paths_by_digest,
            },
        )
    }

    /// Returns JSON descriptors for cache misses. This runs in the N-API
    /// worker pool; no network access or payload decoding happens here.
    pub fn plan_json(&self, languages: &[String], themes: &[String]) -> Result<String> {
        serde_json::to_string(&self.plan(languages, themes)?).map_err(|source| {
            Error::new(
                ErrorKind::Internal,
                "Failed to serialize asset download plan.",
            )
            .with_source(source)
        })
    }

    pub fn cache_dir(&self) -> &Path {
        &self.settings.cache_dir
    }

    fn plan(&self, languages: &[String], themes: &[String]) -> Result<Vec<PlannedAsset>> {
        let mut paths = BTreeSet::new();
        let mut pending: Vec<&str> = languages.iter().map(String::as_str).collect();
        let mut visited = BTreeSet::new();
        while let Some(requested) = pending.pop() {
            let id = self
                .language_aliases
                .get(requested)
                .map_or(requested, String::as_str);
            let Some((path, embedded)) = self.languages.get(id) else {
                continue;
            };
            if !visited.insert(id) {
                continue;
            }
            paths.insert(path.as_str());
            pending.extend(embedded.iter().map(String::as_str));
        }
        paths.extend(
            themes
                .iter()
                .filter_map(|theme| self.themes.get(theme).map(String::as_str)),
        );

        let mut result = Vec::new();
        for path in paths {
            let asset = self.release.assets.get(path).ok_or_else(|| {
                Error::new(
                    ErrorKind::AssetFormat,
                    format!("Release metadata is missing `{path}`."),
                )
            })?;
            let digest = AssetDigest::from_str(&asset.sha256)?;
            let metadata = AssetMetadata::new(digest.clone(), asset.size, asset.format_version);
            let cache_path = self.settings.cache_dir.join(digest.as_str());
            match std::fs::read(&cache_path) {
                Ok(bytes) => match metadata.verify(&bytes) {
                    Ok(()) => continue,
                    Err(error) if error.kind() == ErrorKind::AssetIntegrity => {
                        remove_corrupt_cache_entry(&cache_path)?;
                    }
                    Err(error) => return Err(error),
                },
                Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(Error::new(
                        ErrorKind::AssetIo,
                        format!("Cannot read asset {} from the cache.", digest.as_str()),
                    )
                    .with_source(source));
                }
            }

            if !self.settings.remote {
                return Err(Error::new(
                    ErrorKind::AssetUnavailable,
                    format!(
                        "Asset {path} is not cached in {} and remote assets are turned off. \
                         Allow remote assets, point FERRIKI_ASSETS_BASE_URL at a mirror, or pre-populate the cache.",
                        self.settings.cache_dir.display()
                    ),
                ));
            }
            let commit = self.settings.commit.as_deref().ok_or_else(|| {
                Error::new(
                    ErrorKind::AssetUnavailable,
                    format!(
                        "Asset {path} is not cached, and this build has no release commit to download it from. \
                         Set FERRIKI_RELEASE_COMMIT, or pre-populate {}.",
                        self.settings.cache_dir.display()
                    ),
                )
            })?;
            result.push(PlannedAsset {
                path: path.to_owned(),
                digest: digest.as_str().to_owned(),
                size: asset.size,
                url: format!("{}/{commit}/assets/shiki/{path}", self.settings.base_url),
            });
        }
        Ok(result)
    }
}

struct NodeAssetSource {
    directory: DirectoryAssetSource,
    paths_by_digest: HashMap<AssetDigest, String>,
}

impl AssetSource for NodeAssetSource {
    fn read(&self, digest: &AssetDigest) -> Result<Cow<'_, [u8]>> {
        match self.directory.read(digest) {
            Ok(bytes) => Ok(bytes),
            Err(error) if error.kind() == ErrorKind::AssetUnavailable => {
                let path = self
                    .paths_by_digest
                    .get(digest)
                    .map_or(digest.as_str(), String::as_str);
                Err(Error::new(
                    ErrorKind::AssetUnavailable,
                    format!(
                        "Asset {path} is not cached in {}. Load it through the asynchronous \
                         createHighlighter, loadLanguage or loadTheme path first, or pre-populate the cache.",
                        self.directory.root().display()
                    ),
                ))
            }
            Err(error) => Err(error),
        }
    }
}

fn catalog_path(catalog: &str, file: &str) -> Result<String> {
    if file.is_empty() || file == "." || file == ".." || file.contains('/') || file.contains('\\') {
        return Err(Error::new(
            ErrorKind::AssetFormat,
            format!("Invalid Ferriki asset filename `{file}`."),
        ));
    }
    Ok(format!("{catalog}/{file}"))
}

fn remove_corrupt_cache_entry(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        // Concurrent planners may both observe the same corrupt entry before
        // either removes it. The first removal is enough for both to refetch.
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(Error::new(
            ErrorKind::AssetIo,
            format!("Cannot replace corrupt cached asset `{}`.", path.display()),
        )
        .with_source(source)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ferriki-node-assets-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn fixture_root() -> (PathBuf, PathBuf) {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/shiki");
        let root = temp_dir("root");
        std::fs::create_dir_all(root.join("languages")).expect("language directory");
        std::fs::create_dir_all(root.join("themes")).expect("theme directory");
        for relative in ["languages/manifest.fkindex", "themes/manifest.fkindex"] {
            std::fs::copy(source.join(relative), root.join(relative)).expect("copy manifest");
        }
        let mut release: Value = serde_json::from_slice(
            &std::fs::read(source.join(ferriki_asset_gen::RELEASE_MANIFEST_FILE))
                .expect("release manifest"),
        )
        .expect("release JSON");
        release["commit"] = Value::String("0123456789abcdef0123456789abcdef01234567".to_owned());
        std::fs::write(
            root.join(ferriki_asset_gen::RELEASE_MANIFEST_FILE),
            serde_json::to_vec(&release).expect("serialize release"),
        )
        .expect("write release manifest");
        (source, root)
    }

    fn host(root: &Path, cache_dir: &Path) -> NodeAssetHost {
        NodeAssetHost::from_root(
            root,
            &NodeAssetOptions {
                remote: Some(true),
                base_url: Some("https://mirror.example/".to_owned()),
                cache_dir: Some(cache_dir.to_path_buf()),
            },
        )
        .expect("asset host")
    }

    #[test]
    fn plans_embedded_alias_assets_and_skips_verified_cache_entries() {
        let (source, root) = fixture_root();
        let cache = temp_dir("cache");
        std::fs::create_dir_all(&cache).expect("cache directory");
        let host = host(&root, &cache);

        let nord = host
            .release
            .assets
            .get("themes/nord.fktheme")
            .expect("nord metadata");
        std::fs::copy(source.join("themes/nord.fktheme"), cache.join(&nord.sha256))
            .expect("seed verified cache entry");
        let vue = host
            .release
            .assets
            .get("languages/vue.fkgram")
            .expect("vue metadata");
        std::fs::write(cache.join(&vue.sha256), b"corrupt").expect("write corrupt cache entry");

        let plan = host
            .plan(
                &["vue".to_owned(), "vue".to_owned(), "ts".to_owned()],
                &["nord".to_owned()],
            )
            .expect("download plan");
        let paths: BTreeSet<_> = plan.iter().map(|asset| asset.path.as_str()).collect();

        assert!(paths.contains("languages/vue.fkgram"));
        assert!(paths.contains("languages/typescript.fkgram"));
        assert!(!paths.contains("themes/nord.fktheme"));
        assert_eq!(
            plan.len(),
            paths.len(),
            "aliases and repeat requests deduplicate"
        );
        assert!(
            !cache.join(&vue.sha256).exists(),
            "corrupt bytes are removed for refetch"
        );
        assert!(plan.iter().all(|asset| asset.url.starts_with(
            "https://mirror.example/0123456789abcdef0123456789abcdef01234567/assets/shiki/"
        )));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&cache);
    }
}
