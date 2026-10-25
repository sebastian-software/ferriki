//! Cache planning for the Node host. Network I/O stays in Node's fetch runtime.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use ferriki_asset_gen::{ReleaseManifest, decode_language_manifest, decode_theme_manifest};

use crate::asset_settings::{AssetSettingsInput, ResolvedAssetSettings, resolve_asset_settings};
use crate::{
    AssetDigest, AssetMetadata, AssetSource, Error, ErrorKind, Result, StandardAssetCatalogs,
};

/// Settings supplied by the private N-API host. Unset fields use the same
/// environment and platform defaults as the Rust `remote` feature.
#[derive(Clone, Debug, Default)]
pub struct NodeAssetOptions {
    pub regex_prefilter: Option<bool>,
    pub regex_mode: Option<crate::RegexMode>,
    pub remote: Option<bool>,
    pub base_url: Option<String>,
    pub cache_dir: Option<PathBuf>,
}

#[derive(Debug)]
pub struct PlannedAsset {
    pub path: String,
    pub digest: String,
    pub size: u64,
    pub url: String,
}

/// Manifest-backed Node asset host. It only plans downloads and reads the
/// digest-addressed cache; JavaScript owns transport and cache writes.
pub struct NodeAssetHost {
    precompiled: bool,
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
            precompiled: options.regex_mode.unwrap_or_else(|| {
                crate::RegexMode::from_prefilter(options.regex_prefilter.unwrap_or(true))
            }) == crate::RegexMode::Prepared,
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
        let assets_by_digest = self
            .release
            .assets
            .iter()
            .map(|(path, asset)| {
                Ok((
                    asset.sha256.parse::<AssetDigest>()?,
                    NodeCachedAsset {
                        path: path.clone(),
                        size: asset.size,
                    },
                ))
            })
            .collect::<Result<HashMap<_, _>>>()?;
        StandardAssetCatalogs::from_release_manifest(
            &self.language_manifest,
            &self.theme_manifest,
            &self.release,
            NodeAssetSource {
                cache_dir: self.settings.cache_dir.clone(),
                assets_by_digest,
            },
        )
    }

    pub fn cache_dir(&self) -> &Path {
        &self.settings.cache_dir
    }

    /// Plans cache misses without network access or payload decoding.
    pub fn plan(&self, languages: &[String], themes: &[String]) -> Result<Vec<PlannedAsset>> {
        let prepared_roots: BTreeSet<&str> = languages
            .iter()
            .map(|requested| {
                self.language_aliases
                    .get(requested.as_str())
                    .map_or(requested.as_str(), String::as_str)
            })
            .collect();
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
            paths.insert(path.clone());
            let bytecode = path.replace(".fkgram", ".fkbc");
            if self.precompiled
                && prepared_roots.contains(id)
                && self.release.assets.get(&bytecode).is_some_and(|asset| {
                    asset.format_version == ferriki_textmate::PRECOMPILED_PATTERNS_VERSION
                })
            {
                paths.insert(bytecode);
            }
            pending.extend(embedded.iter().map(String::as_str));
        }
        paths.extend(
            themes
                .iter()
                .filter_map(|theme| self.themes.get(theme).cloned()),
        );

        let mut result = Vec::new();
        for path in paths {
            let optional = path.ends_with(".fkbc");
            let asset = self.release.assets.get(&path).ok_or_else(|| {
                Error::new(
                    ErrorKind::AssetFormat,
                    format!("Release metadata is missing `{path}`."),
                )
            })?;
            let digest = AssetDigest::from_str(&asset.sha256)?;
            let metadata = AssetMetadata::new(digest.clone(), asset.size, asset.format_version);
            let cache_path = self.settings.cache_dir.join(digest.as_str());
            let cached = match read_cache_entry(&cache_path, digest.as_str(), asset.size) {
                Ok(cached) => cached,
                Err(_) if optional => continue,
                Err(error) => return Err(error),
            };
            let corrupt = match cached {
                CacheRead::Bytes(bytes) => match if optional {
                    metadata.verify_bytes(&bytes)
                } else {
                    metadata.verify(&bytes)
                } {
                    Ok(()) => continue,
                    Err(error) if error.kind() == ErrorKind::AssetIntegrity => true,
                    Err(error) => return Err(error),
                },
                CacheRead::Missing => false,
                CacheRead::WrongSize => true,
            };
            if corrupt && let Err(error) = remove_corrupt_cache_entry(&cache_path) {
                if optional {
                    continue;
                }
                return Err(error);
            }

            if !self.settings.remote {
                if optional {
                    continue;
                }
                return Err(Error::new(
                    ErrorKind::AssetUnavailable,
                    format!(
                        "Asset {path} is not cached in {} and remote assets are turned off. \
                         Allow remote assets, point FERRIKI_ASSETS_BASE_URL at a mirror, or pre-populate the cache.",
                        self.settings.cache_dir.display()
                    ),
                ));
            }
            result.push(PlannedAsset {
                path: path.to_owned(),
                digest: digest.as_str().to_owned(),
                size: asset.size,
                url: crate::asset_settings::asset_url(
                    self.release.storage_layout.as_deref(),
                    &self.settings,
                    &path,
                    digest.as_str(),
                )?,
            });
        }
        Ok(result)
    }
}

struct NodeCachedAsset {
    path: String,
    size: u64,
}

struct NodeAssetSource {
    cache_dir: PathBuf,
    assets_by_digest: HashMap<AssetDigest, NodeCachedAsset>,
}

impl AssetSource for NodeAssetSource {
    fn read(&self, digest: &AssetDigest) -> Result<Cow<'_, [u8]>> {
        let Some(asset) = self.assets_by_digest.get(digest) else {
            return Err(Error::new(
                ErrorKind::AssetUnavailable,
                format!("Asset {} is not part of this release.", digest.as_str()),
            ));
        };
        let cache_path = self.cache_dir.join(digest.as_str());
        match read_cache_entry(&cache_path, digest.as_str(), asset.size)? {
            CacheRead::Bytes(bytes) => Ok(Cow::Owned(bytes)),
            CacheRead::WrongSize => Err(Error::new(
                ErrorKind::AssetIntegrity,
                format!(
                    "Asset {} failed its SHA-256 or byte-size check.",
                    digest.as_str()
                ),
            )),
            CacheRead::Missing => Err(Error::new(
                ErrorKind::AssetUnavailable,
                format!(
                    "Asset {} is not cached in {}. Load it through the asynchronous \
                     createHighlighter, loadLanguage or loadTheme path first, or pre-populate the cache.",
                    asset.path,
                    self.cache_dir.display()
                ),
            )),
        }
    }
}

enum CacheRead {
    Missing,
    WrongSize,
    Bytes(Vec<u8>),
}

/// Checks the opened file's manifest-pinned size before allocating its bytes,
/// then caps the read in case the cache entry grows after the metadata check.
fn read_cache_entry(path: &Path, digest: &str, expected_size: u64) -> Result<CacheRead> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CacheRead::Missing);
        }
        Err(source) => {
            return Err(Error::new(
                ErrorKind::AssetIo,
                format!("Cannot read asset {digest} from the cache."),
            )
            .with_source(source));
        }
    };
    let file_metadata = file.metadata().map_err(|source| {
        Error::new(
            ErrorKind::AssetIo,
            format!("Cannot read asset {digest} from the cache."),
        )
        .with_source(source)
    })?;
    if !file_metadata.is_file() {
        return Err(Error::new(
            ErrorKind::AssetIo,
            format!("Cannot read asset {digest} from the cache: expected a regular file."),
        ));
    }
    if file_metadata.len() != expected_size {
        drop(file);
        return Ok(CacheRead::WrongSize);
    }

    let capacity = usize::try_from(expected_size).map_err(|source| {
        Error::new(
            ErrorKind::AssetIo,
            format!("Cannot read asset {digest} from the cache."),
        )
        .with_source(source)
    })?;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(capacity).map_err(|source| {
        Error::new(
            ErrorKind::AssetIo,
            format!("Cannot allocate cached asset {digest}."),
        )
        .with_source(source)
    })?;
    let mut reader = file.take(expected_size.saturating_add(1));
    reader.read_to_end(&mut bytes).map_err(|source| {
        Error::new(
            ErrorKind::AssetIo,
            format!("Cannot read asset {digest} from the cache."),
        )
        .with_source(source)
    })?;
    drop(reader);
    if bytes.len() as u64 != expected_size {
        return Ok(CacheRead::WrongSize);
    }
    Ok(CacheRead::Bytes(bytes))
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
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/standard");
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
                regex_prefilter: None,
                regex_mode: None,
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
        for mode in [
            crate::RegexMode::Off,
            crate::RegexMode::Auto,
            crate::RegexMode::Eager,
        ] {
            let disabled = NodeAssetHost::from_root(
                &root,
                &NodeAssetOptions {
                    regex_mode: Some(mode),
                    remote: Some(true),
                    cache_dir: Some(cache.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(
                disabled
                    .plan(&["vue".to_owned()], &[])
                    .unwrap()
                    .iter()
                    .all(|asset| !asset.path.ends_with(".fkbc")),
                "source modes must not download prepared images"
            );
        }

        assert!(paths.contains("languages/vue.fkgram"));
        assert!(paths.contains("languages/typescript.fkgram"));
        let vue_only = host.plan(&["vue".to_owned()], &[]).expect("root-only plan");
        assert!(
            vue_only
                .iter()
                .any(|asset| asset.path == "languages/typescript.fkgram")
        );
        assert!(
            !vue_only
                .iter()
                .any(|asset| asset.path == "languages/typescript.fkbc"),
            "the root archive already carries dependency groups"
        );
        assert!(paths.contains("languages/vue.fkbc"));
        assert!(paths.contains("languages/typescript.fkbc"));
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
        for asset in &plan {
            let file = asset.path.strip_prefix("languages/").unwrap();
            let (prefix, id) = if let Some(id) = file.strip_suffix(".fkbc") {
                ("", id)
            } else {
                ("", file.strip_suffix(".fkgram").unwrap())
            };
            assert_eq!(
                asset.url,
                format!(
                    "https://mirror.example/{prefix}{id}/{}",
                    crate::asset_settings::short_hash(&asset.digest).unwrap()
                )
            );
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&cache);
    }

    #[cfg(unix)]
    #[test]
    fn optional_corruption_in_a_read_only_cache_keeps_valid_grammar_usable() {
        use std::os::unix::fs::PermissionsExt;
        let (source, root) = fixture_root();
        let cache = temp_dir("read-only-optional");
        std::fs::create_dir_all(&cache).unwrap();
        let host = host(&root, &cache);
        let grammar = &host.release.assets["languages/json.fkgram"];
        let bytecode = &host.release.assets["languages/json.fkbc"];
        std::fs::copy(
            source.join("languages/json.fkgram"),
            cache.join(&grammar.sha256),
        )
        .unwrap();
        let expected = std::fs::read(source.join("languages/json.fkbc")).unwrap();
        let mut same_size_corrupt = expected;
        same_size_corrupt[0] ^= 0xff;
        for invalid in [b"truncated".to_vec(), same_size_corrupt] {
            let entry = cache.join(&bytecode.sha256);
            std::fs::write(&entry, invalid).unwrap();
            std::fs::set_permissions(&cache, std::fs::Permissions::from_mode(0o555)).unwrap();
            let result = host.plan(&["json".to_owned()], &[]);
            std::fs::set_permissions(&cache, std::fs::Permissions::from_mode(0o755)).unwrap();
            let plan = result.expect("an unusable optional entry must not block a valid grammar");
            if entry.exists() {
                assert!(
                    plan.is_empty(),
                    "an unrepairable optional entry falls back to source"
                );
            } else {
                // Privileged test processes can repair even mode-0555 directories.
                assert_eq!(plan.len(), 1);
                assert!(plan[0].path.ends_with(".fkbc"));
            }
        }
        std::fs::remove_dir_all(cache).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn planner_rejects_wrong_size_cache_entries_before_reading_them() {
        let (source, root) = fixture_root();
        let cache = temp_dir("wrong-size-cache");
        std::fs::create_dir_all(&cache).expect("cache directory");
        let host = host(&root, &cache);
        let asset = host
            .release
            .assets
            .get("themes/nord.fktheme")
            .expect("nord metadata");
        let cache_path = cache.join(&asset.sha256);

        let sparse = std::fs::File::create(&cache_path).expect("cache entry");
        sparse
            .set_len(asset.size + 64 * 1024 * 1024)
            .expect("sparse oversized cache entry");
        drop(sparse);

        let plan = host
            .plan(&[], &["nord".to_owned()])
            .expect("oversized cache entry becomes a miss");
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].path, "themes/nord.fktheme");
        assert!(
            !cache_path.exists(),
            "oversized entry is removed for refetch"
        );

        let expected = std::fs::read(source.join("themes/nord.fktheme")).expect("theme bytes");
        std::fs::write(&cache_path, &expected[..expected.len() - 1])
            .expect("truncated cache entry");
        let plan = host
            .plan(&[], &["nord".to_owned()])
            .expect("truncated cache entry becomes a miss");
        assert_eq!(plan.len(), 1);
        assert!(
            !cache_path.exists(),
            "truncated entry is removed for refetch"
        );

        let mut same_size_corrupt = expected;
        same_size_corrupt[0] ^= 0xff;
        std::fs::write(&cache_path, &same_size_corrupt).expect("same-size corrupt cache entry");
        let plan = host
            .plan(&[], &["nord".to_owned()])
            .expect("digest mismatch becomes a miss");
        assert_eq!(plan.len(), 1);
        assert!(
            !cache_path.exists(),
            "digest-mismatched entry is removed for refetch"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&cache);
    }

    #[test]
    fn synchronous_node_cache_reads_bound_size_and_load_valid_assets() {
        let (source, root) = fixture_root();
        let valid_cache = temp_dir("sync-valid-cache");
        std::fs::create_dir_all(&valid_cache).expect("valid cache directory");
        let asset_path = "themes/nord.fktheme";
        let bytes = std::fs::read(source.join(asset_path)).expect("theme bytes");
        let asset = host(&root, &valid_cache)
            .release
            .assets
            .get(asset_path)
            .expect("nord metadata")
            .clone();
        std::fs::write(valid_cache.join(&asset.sha256), &bytes).expect("valid cache entry");

        let catalogs = host(&root, &valid_cache).catalogs().expect("catalogs");
        catalogs
            .themes
            .load_asset("nord")
            .expect("verified cached theme");

        let oversized_cache = temp_dir("sync-oversized-cache");
        std::fs::create_dir_all(&oversized_cache).expect("oversized cache directory");
        let cache_path = oversized_cache.join(&asset.sha256);
        let sparse = std::fs::File::create(&cache_path).expect("cache entry");
        sparse
            .set_len(asset.size + 64 * 1024 * 1024)
            .expect("sparse oversized cache entry");
        drop(sparse);

        let catalogs = host(&root, &oversized_cache).catalogs().expect("catalogs");
        let error = catalogs
            .themes
            .load_asset("nord")
            .expect_err("oversized cache entry fails before decoding");
        assert_eq!(error.kind(), ErrorKind::AssetIntegrity);
        assert!(
            cache_path.exists(),
            "synchronous loads leave cache repair to planning"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&valid_cache);
        let _ = std::fs::remove_dir_all(&oversized_cache);
    }
}
