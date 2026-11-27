//! Cache planning for the Node host. Network I/O stays in Node's fetch runtime.

use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use ferriki_asset_gen::{ReleaseManifest, decode_language_manifest, decode_theme_manifest};

use crate::asset_settings::{
    AssetSettingsInput, ResolvedAssetSettings, catalog_path, resolve_asset_settings,
};
use crate::asset_source::{
    InternalVerifiedSource, SharedVerifiedPayloadCache, VerifiedBytes, VerifiedPayloadCache,
    open_nonblocking,
};
use crate::{AssetDigest, AssetMetadata, Error, ErrorKind, Result, StandardAssetCatalogs};

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
    language_scopes: HashMap<String, String>,
    themes: HashMap<String, String>,
    /// Bounded one-shot handoff of verified cached bytes from `plan` to the
    /// immediate synchronous catalog load, avoiding redundant disk+SHA-256 passes.
    verified_cache: Arc<SharedVerifiedPayloadCache>,
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
        let mut language_scopes = HashMap::new();
        for entry in decode_language_manifest(&language_manifest)
            .map_err(format)?
            .entries
        {
            let path = catalog_path("languages", &entry.asset_file)?;
            for alias in &entry.aliases {
                language_aliases.insert(alias.clone(), entry.id.clone());
            }
            language_scopes.insert(entry.scope_name, entry.id.clone());
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
            language_scopes,
            themes,
            verified_cache: Arc::new(SharedVerifiedPayloadCache::new()),
        })
    }

    /// Releases any unconsumed verified payloads held between `plan` and load.
    pub fn clear_verified_cache(&self) {
        self.verified_cache.clear();
    }

    /// Permanently empties and closes the verified payload handoff cache so
    /// in-flight background `plan()` tasks cannot repopulate it after disposal.
    pub fn close_verified_cache(&self) {
        self.verified_cache.close();
    }

    /// Drops any unconsumed verified payloads for the single standard language
    /// `requested` (its grammar and optional bytecode sidecar) once a load
    /// settles. Embedded dependencies are evicted individually by the host only
    /// when their own pending refcounts reach zero.
    pub fn evict_verified_language(&self, requested: &str) {
        if self.verified_cache.is_empty() {
            return;
        }
        let id = self
            .language_aliases
            .get(requested)
            .or_else(|| self.language_scopes.get(requested))
            .map_or(requested, String::as_str);
        let Some((path, _)) = self.languages.get(id) else {
            return;
        };
        let bytecode = path.replace(".fkgram", ".fkbc");
        let mut digests = Vec::with_capacity(2);
        for asset_path in [path.as_str(), bytecode.as_str()] {
            if let Some(asset) = self.release.assets.get(asset_path)
                && let Ok(digest) = AssetDigest::from_str(&asset.sha256)
            {
                digests.push(digest);
            }
        }
        self.verified_cache.take_many(&digests);
    }

    /// Drops any unconsumed verified payload for `requested` once a theme load
    /// settles.
    pub fn evict_verified_theme(&self, requested: &str) {
        if self.verified_cache.is_empty() {
            return;
        }
        let Some(path) = self.themes.get(requested) else {
            return;
        };
        let Some(asset) = self.release.assets.get(path) else {
            return;
        };
        let Ok(digest) = AssetDigest::from_str(&asset.sha256) else {
            return;
        };
        let _ = self.verified_cache.take(&digest);
    }

    #[cfg(test)]
    fn verified_cache_stats(&self) -> (usize, usize) {
        self.verified_cache.stats()
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
        StandardAssetCatalogs::from_verified_release_manifest(
            &self.language_manifest,
            &self.theme_manifest,
            &self.release,
            NodeAssetSource {
                cache_dir: self.settings.cache_dir.clone(),
                assets_by_digest,
                verified_cache: Arc::clone(&self.verified_cache),
            },
        )
        .map(|catalogs| catalogs.with_decoded_cache(self.settings.cache_dir.clone()))
    }

    pub fn cache_dir(&self) -> &Path {
        &self.settings.cache_dir
    }

    /// Plans cache misses without network access or payload decoding.
    pub fn plan(&self, languages: &[String], themes: &[String]) -> Result<Vec<PlannedAsset>> {
        let mut paths = BTreeSet::new();
        let mut pending: Vec<(&str, bool)> = languages
            .iter()
            .map(|id| (id.as_str(), self.precompiled))
            .collect();
        let mut visited = BTreeSet::new();
        while let Some((requested, prepared)) = pending.pop() {
            let id = self
                .language_aliases
                .get(requested)
                .map_or(requested, String::as_str);
            let Some((path, embedded)) = self.languages.get(id) else {
                continue;
            };
            if !visited.insert((id, prepared)) {
                continue;
            }
            paths.insert(path.clone());
            let bytecode = path.replace(".fkgram", ".fkbc");
            let delegated = self.precompiled
                && prepared
                && self
                    .release
                    .assets
                    .get(&bytecode)
                    .is_some_and(|asset| asset.format_version >> 24 >= 3);
            if self.precompiled
                && prepared
                && self.release.assets.get(&bytecode).is_some_and(|asset| {
                    ferriki_textmate::supports_precompiled_patterns_version(asset.format_version)
                })
            {
                paths.insert(bytecode);
            }
            pending.extend(embedded.iter().map(|id| (id.as_str(), delegated)));
        }
        paths.extend(
            themes
                .iter()
                .filter_map(|theme| self.themes.get(theme).cloned()),
        );

        let mut result = Vec::new();
        let mut staged = VerifiedPayloadCache::new();
        for path in paths {
            let optional = path.ends_with(".fkbc");
            let asset = self.release.assets.get(&path).ok_or_else(|| {
                Error::new(
                    ErrorKind::AssetFormat,
                    format!("Release metadata is missing `{path}`."),
                )
            })?;
            let digest = AssetDigest::from_str(&asset.sha256)?;
            let metadata = AssetMetadata::from_release_asset(asset)?;
            if optional && crate::precompiled_cache::available(&self.settings.cache_dir, &metadata)
            {
                continue;
            }
            let cache_path = self.settings.cache_dir.join(digest.as_str());
            let cached = match read_cache_entry(&cache_path, digest.as_str(), asset.size) {
                Ok(cached) => cached,
                Err(_) if optional => continue,
                Err(error) => return Err(error),
            };
            let corrupt = match cached {
                CacheRead::Bytes(bytes) => {
                    if !optional {
                        metadata.validate_format()?;
                    }
                    match VerifiedBytes::verify(bytes, &digest, asset.size) {
                        Ok(verified) => {
                            staged.insert(verified);
                            continue;
                        }
                        Err(error) if error.kind() == ErrorKind::AssetIntegrity => true,
                        Err(error) => return Err(error),
                    }
                }
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
            let url = match crate::asset_settings::asset_url(
                self.release.storage_layout.as_deref(),
                &self.settings,
                &path,
                digest.as_str(),
            ) {
                Ok(url) => url,
                Err(_) if optional => continue,
                Err(error) => return Err(error),
            };
            result.push(PlannedAsset {
                path: path.to_owned(),
                digest: digest.as_str().to_owned(),
                size: asset.size,
                url,
            });
        }
        if !staged.is_empty() {
            self.verified_cache.insert_batch(staged.into_payloads());
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
    verified_cache: Arc<SharedVerifiedPayloadCache>,
}

impl InternalVerifiedSource for NodeAssetSource {
    fn read_verified(&self, digest: &AssetDigest, expected_size: u64) -> Result<VerifiedBytes> {
        let Some(asset) = self.assets_by_digest.get(digest) else {
            return Err(Error::new(
                ErrorKind::AssetUnavailable,
                format!("Asset {} is not part of this release.", digest.as_str()),
            ));
        };
        if asset.size != expected_size {
            return Err(Error::new(
                ErrorKind::AssetIntegrity,
                format!(
                    "Asset {} failed its SHA-256 or byte-size check.",
                    digest.as_str()
                ),
            ));
        }
        if let Some(verified) = self.verified_cache.take(digest)
            && verified.digest() == digest
            && verified.len() as u64 == expected_size
        {
            return Ok(verified);
        }
        let cache_path = self.cache_dir.join(digest.as_str());
        match read_cache_entry(&cache_path, digest.as_str(), asset.size)? {
            CacheRead::Bytes(bytes) => VerifiedBytes::verify(bytes, digest, asset.size),
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
    let file = match open_nonblocking(path) {
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
        let mut legacy = self::host(&root, &cache);
        for (path, asset) in &mut legacy.release.assets {
            if path.ends_with(".fkbc") {
                asset.format_version = (2 << 24) | (asset.format_version & 0x00ff_ffff);
            }
        }
        let vue_only = legacy
            .plan(&["vue".to_owned()], &[])
            .expect("root-only plan");
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
        let mut delegated = self::host(&root, &cache);
        for (path, asset) in &mut delegated.release.assets {
            if path.ends_with(".fkbc") {
                asset.format_version = ferriki_textmate::PRECOMPILED_PATTERNS_VERSION;
            }
        }
        let delegated_plan = delegated.plan(&["vue".to_owned()], &[]).unwrap();
        assert!(
            delegated_plan
                .iter()
                .any(|asset| asset.path == "languages/typescript.fkbc")
        );
        let markdown = delegated.plan(&["markdown".to_owned()], &[]).unwrap();
        assert!(
            markdown
                .iter()
                .any(|asset| asset.path == "languages/markdown.fkbc")
        );
        assert!(
            !markdown
                .iter()
                .any(|asset| asset.path == "languages/rust.fkbc"),
            "optional fenced-code languages must not be fetched unless registered explicitly"
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

    #[test]
    fn decoded_cache_reuses_file_state_and_rejects_changed_bytes() {
        let (source, root) = fixture_root();
        let cache = temp_dir("decoded-plan");
        let host = host(&root, &cache);
        let name = "angular-expression";
        let path = format!("languages/{name}.fkbc");
        let asset = &host.release.assets[&path];
        let metadata = AssetMetadata::from_release_asset(asset).unwrap();
        let decoded = crate::precompiled_cache::prepare(
            &cache,
            metadata.decoded().unwrap(),
            &std::fs::read(source.join(&path)).unwrap(),
        )
        .unwrap();
        assert!(!cache.join(&asset.sha256).exists());
        assert!(
            host.plan(&[name.to_owned()], &[])
                .unwrap()
                .iter()
                .all(|entry| entry.path != path)
        );
        assert_eq!(
            host.catalogs()
                .unwrap()
                .languages
                .load_precompiled(name)
                .unwrap(),
            decoded
        );

        let cached = cache
            .join("decoded")
            .join(metadata.decoded().unwrap().digest().as_str());
        let mut invalid = decoded;
        *invalid.last_mut().unwrap() ^= 1;
        std::fs::write(&cached, invalid).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&cached)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(60))
            .unwrap();
        assert!(
            host.catalogs()
                .unwrap()
                .languages
                .load_precompiled(name)
                .is_none()
        );
        assert!(
            !cached.exists(),
            "the actual read rejects and removes a same-size corrupt entry"
        );
        assert!(
            host.plan(&[name.to_owned()], &[])
                .unwrap()
                .iter()
                .any(|entry| entry.path == path)
        );
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(cache).unwrap();
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

    #[test]
    fn optional_sidecar_url_error_falls_back_to_cached_grammar_while_required_miss_fails() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let root = temp_dir("optional-sidecar-url-fallback");
        let cache = temp_dir("optional-sidecar-url-fallback-cache");
        std::fs::create_dir_all(&cache).expect("cache directory");
        ferriki_asset_gen::generate_catalogs_from_upstream(
            &upstream_dir,
            &root,
            ferriki_asset_gen::AssetSourceRef::new(
                "textmate-grammars-themes".to_owned(),
                None,
                None,
            ),
        )
        .expect("generate catalog fixture");

        let mut release: Value = serde_json::from_slice(
            &std::fs::read(root.join(ferriki_asset_gen::RELEASE_MANIFEST_FILE))
                .expect("release manifest"),
        )
        .expect("parse release manifest");
        let sidecar_bytes = b"optional sidecar bytes";
        let sidecar_digest = AssetDigest::of(sidecar_bytes);
        release["assets"]["languages/javascript.fkbc"] = serde_json::json!({
            "sha256": sidecar_digest.as_str(),
            "size": sidecar_bytes.len(),
            "formatVersion": ferriki_textmate::PRECOMPILED_PATTERNS_VERSION,
        });
        std::fs::write(
            root.join(ferriki_asset_gen::RELEASE_MANIFEST_FILE),
            serde_json::to_vec(&release).expect("serialize release"),
        )
        .expect("write release manifest");

        let host = NodeAssetHost::from_root(
            &root,
            &NodeAssetOptions {
                regex_prefilter: None,
                regex_mode: Some(crate::RegexMode::Prepared),
                remote: Some(true),
                base_url: Some("http://mirror.internal".to_owned()),
                cache_dir: Some(cache.clone()),
            },
        )
        .expect("node asset host");

        // Populate only the required grammar; the optional .fkbc sidecar remains uncached.
        let grammar = &host.release.assets["languages/javascript.fkgram"];
        std::fs::copy(
            root.join("languages/javascript.fkgram"),
            cache.join(&grammar.sha256),
        )
        .expect("seed grammar cache");
        let plan = host
            .plan(&["javascript".to_owned()], &[])
            .expect("optional sidecar URL failure must fall back to cached grammar");
        assert!(plan.is_empty());

        // Evicting the required grammar must still fail planning with the invalid mirror URL.
        std::fs::remove_file(cache.join(&grammar.sha256)).expect("evict grammar");
        let error = host
            .plan(&["javascript".to_owned()], &[])
            .expect_err("required grammar miss must reject invalid mirror URL");
        assert_eq!(error.kind(), ErrorKind::AssetDownload);

        std::fs::remove_dir_all(&cache).expect("cleanup cache");
        std::fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn planned_verified_cache_eliminates_duplicate_sha256_and_disk_reads() {
        let (source, root) = fixture_root();
        let cache = temp_dir("verified-handoff");
        std::fs::create_dir_all(&cache).expect("cache directory");
        let host = NodeAssetHost::from_root(
            &root,
            &NodeAssetOptions {
                regex_prefilter: None,
                regex_mode: Some(crate::RegexMode::Off),
                remote: Some(false),
                base_url: None,
                cache_dir: Some(cache.clone()),
            },
        )
        .expect("asset host");

        let json_asset = host.release.assets["languages/json.fkgram"].clone();
        let nord_asset = host.release.assets["themes/nord.fktheme"].clone();
        std::fs::copy(
            source.join("languages/json.fkgram"),
            cache.join(&json_asset.sha256),
        )
        .expect("seed json grammar");
        std::fs::copy(
            source.join("themes/nord.fktheme"),
            cache.join(&nord_asset.sha256),
        )
        .expect("seed nord theme");

        let catalogs = host.catalogs().expect("catalogs");

        crate::asset_source::reset_sha256_count();
        let plan = host
            .plan(&["json".to_owned()], &["nord".to_owned()])
            .expect("plan cached assets");
        assert!(plan.is_empty());
        assert_eq!(
            crate::asset_source::sha256_count(),
            2,
            "plan must verify each cached payload once"
        );

        // Removing the disk files after planning proves immediate catalog loads
        // consume the in-memory verified handoff with zero disk reads and zero
        // duplicate SHA-256 passes.
        std::fs::remove_file(cache.join(&json_asset.sha256)).expect("remove json from disk");
        std::fs::remove_file(cache.join(&nord_asset.sha256)).expect("remove nord from disk");
        assert!(catalogs.languages.load_asset("json").unwrap().is_some());
        assert!(catalogs.themes.load_asset("nord").unwrap().is_some());
        assert_eq!(
            crate::asset_source::sha256_count(),
            2,
            "catalog load after plan must not re-hash verified bytes"
        );

        // Clearing unconsumed entries forces fresh disk reads + SHA-256 verification.
        let mut tampered_nord = std::fs::read(source.join("themes/nord.fktheme")).unwrap();
        tampered_nord[0] ^= 0xff;
        std::fs::write(cache.join(&nord_asset.sha256), &tampered_nord).unwrap();
        host.clear_verified_cache();
        let fresh_catalogs = host.catalogs().expect("fresh catalogs");
        crate::asset_source::reset_sha256_count();
        let error = fresh_catalogs
            .themes
            .load_asset("nord")
            .expect_err("tampered disk entry must still fail SHA-256 verification");
        assert_eq!(error.kind(), ErrorKind::AssetIntegrity);
        assert_eq!(crate::asset_source::sha256_count(), 1);

        std::fs::remove_dir_all(&cache).expect("cleanup cache");
        std::fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn repeated_warm_plan_and_load_retains_zero_unconsumed_verified_bytes() {
        let (source, root) = fixture_root();
        let cache = temp_dir("warm-zero-retention");
        std::fs::create_dir_all(&cache).expect("cache directory");
        let host = NodeAssetHost::from_root(
            &root,
            &NodeAssetOptions {
                regex_prefilter: None,
                regex_mode: Some(crate::RegexMode::Prepared),
                remote: Some(false),
                base_url: None,
                cache_dir: Some(cache.clone()),
            },
        )
        .expect("asset host");

        for asset_path in [
            "languages/json.fkgram",
            "languages/json.fkbc",
            "themes/nord.fktheme",
        ] {
            let asset = &host.release.assets[asset_path];
            std::fs::copy(source.join(asset_path), cache.join(&asset.sha256))
                .expect("seed cache entry");
        }

        let mut core = crate::highlighter::HighlighterCore::with_assets_and_regex_mode(
            host.catalogs().expect("catalogs"),
            crate::RegexMode::Prepared,
        )
        .expect("core");

        // First plan + load consumes and evicts all planned entries.
        assert!(
            host.plan(&["json".to_owned()], &["nord".to_owned()])
                .unwrap()
                .is_empty()
        );
        assert!(host.verified_cache_stats().0 > 0);
        assert!(core.load_standard_language("json").unwrap().is_some());
        host.evict_verified_language("json");
        // Theme handoff entry stays intact until the theme itself is loaded.
        assert_eq!(host.verified_cache_stats().0, 1);
        assert!(core.load_standard_theme("nord").unwrap());
        host.evict_verified_theme("nord");
        assert_eq!(host.verified_cache_stats(), (0, 0));

        // Second plan for already-loaded language + theme: catalog returns early
        // without calling AssetStore::read, yet eviction leaves 0 bytes retained.
        assert!(
            host.plan(&["json".to_owned()], &["nord".to_owned()])
                .unwrap()
                .is_empty()
        );
        assert!(host.verified_cache_stats().1 > 0);
        assert!(core.load_standard_language("json").unwrap().is_some());
        host.evict_verified_language("json");
        assert!(core.load_standard_theme("nord").unwrap());
        host.evict_verified_theme("nord");
        assert_eq!(
            host.verified_cache_stats(),
            (0, 0),
            "already-loaded warm assets must not leave unconsumed verified buffers behind"
        );

        std::fs::remove_dir_all(&cache).expect("cleanup cache");
        std::fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn failed_plan_does_not_retain_staged_verified_payloads() {
        let (source, root) = fixture_root();
        let cache = temp_dir("failed-plan-staging");
        std::fs::create_dir_all(&cache).expect("cache directory");
        let host = NodeAssetHost::from_root(
            &root,
            &NodeAssetOptions {
                regex_prefilter: None,
                regex_mode: Some(crate::RegexMode::Off),
                remote: Some(false),
                base_url: None,
                cache_dir: Some(cache.clone()),
            },
        )
        .expect("asset host");

        // Seed only `languages/json.fkgram` (sorts before `themes/nord.fktheme`),
        // leaving `themes/nord.fktheme` missing offline so `plan()` fails mid-way.
        let json_asset = &host.release.assets["languages/json.fkgram"];
        std::fs::copy(
            source.join("languages/json.fkgram"),
            cache.join(&json_asset.sha256),
        )
        .expect("seed json grammar");

        let error = host
            .plan(&["json".to_owned()], &["nord".to_owned()])
            .expect_err("missing offline theme must fail plan");
        assert_eq!(error.kind(), ErrorKind::AssetUnavailable);
        assert_eq!(
            host.verified_cache_stats(),
            (0, 0),
            "staged verified payloads must be discarded when plan() returns Err"
        );

        std::fs::remove_dir_all(&cache).expect("cleanup cache");
        std::fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn standard_language_readiness_tracks_sidecar_attachment_across_sync_and_fallback_loads() {
        let (source, root) = fixture_root();
        let cache = temp_dir("sidecar-readiness");
        std::fs::create_dir_all(&cache).expect("cache directory");
        let host = NodeAssetHost::from_root(
            &root,
            &NodeAssetOptions {
                regex_prefilter: None,
                regex_mode: Some(crate::RegexMode::Prepared),
                remote: Some(false),
                base_url: None,
                cache_dir: Some(cache.clone()),
            },
        )
        .expect("asset host");

        // Seed only the grammar (no .fkbc sidecar): loading succeeds via source
        // fallback, but readiness stays false so a later async loadLanguage can
        // still plan and fetch the missing sidecar.
        let json_grammar = &host.release.assets["languages/json.fkgram"];
        let json_bytecode = &host.release.assets["languages/json.fkbc"];
        std::fs::copy(
            source.join("languages/json.fkgram"),
            cache.join(&json_grammar.sha256),
        )
        .expect("seed json grammar");

        let mut prepared = crate::highlighter::HighlighterCore::with_assets_and_regex_mode(
            host.catalogs().expect("catalogs"),
            crate::RegexMode::Prepared,
        )
        .expect("prepared core");
        assert!(!prepared.is_standard_language_ready("json"));
        assert!(prepared.load_standard_language("json").unwrap().is_some());
        assert!(
            !prepared.is_standard_language_ready("json"),
            "missing sidecar must keep readiness false for later recovery"
        );

        // Once the sidecar arrives and is attached on reload, readiness turns true.
        std::fs::copy(
            source.join("languages/json.fkbc"),
            cache.join(&json_bytecode.sha256),
        )
        .expect("seed json bytecode");
        assert!(prepared.load_standard_language("json").unwrap().is_some());
        assert!(prepared.is_standard_language_ready("json"));

        // In source-only modes (e.g. Off), readiness only requires the grammar.
        let mut off = crate::highlighter::HighlighterCore::with_assets_and_regex_mode(
            host.catalogs().expect("catalogs"),
            crate::RegexMode::Off,
        )
        .expect("off core");
        assert!(off.load_standard_language("json").unwrap().is_some());
        assert!(off.is_standard_language_ready("json"));

        std::fs::remove_dir_all(&cache).expect("cleanup cache");
        std::fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn sidecar_readiness_matches_planner_when_intermediate_embedded_sidecars_are_absent() {
        let (source, root) = fixture_root();
        let cache = temp_dir("sidecar-readiness-delegation");
        std::fs::create_dir_all(&cache).expect("cache directory");

        // Remove the intermediate embedded sidecars directly below `javascript`
        // (`es-tag-css` and `es-tag-html`) from the release manifest so the
        // planner stops requesting sidecars below them (`typescript`, `html`,
        // `css-styled`, `css`).
        let release_path = root.join(ferriki_asset_gen::RELEASE_MANIFEST_FILE);
        let mut release: Value =
            serde_json::from_slice(&std::fs::read(&release_path).expect("read release"))
                .expect("parse release");
        let assets_obj = release["assets"].as_object_mut().expect("assets map");
        assert!(assets_obj.remove("languages/es-tag-css.fkbc").is_some());
        assert!(assets_obj.remove("languages/es-tag-html.fkbc").is_some());
        assert!(
            assets_obj.contains_key("languages/typescript.fkbc"),
            "child sidecar remains pinned in the release manifest"
        );
        std::fs::write(
            &release_path,
            serde_json::to_vec(&release).expect("serialize release"),
        )
        .expect("write release");

        let host = host(&root, &cache);
        // Seed every grammar in javascript's closure plus javascript.fkbc,
        // leaving child sidecars (typescript.fkbc, css-styled.fkbc, html.fkbc,
        // css.fkbc) uncached.
        for path in [
            "languages/javascript.fkgram",
            "languages/javascript.fkbc",
            "languages/es-tag-css.fkgram",
            "languages/es-tag-html.fkgram",
            "languages/typescript.fkgram",
            "languages/css-styled.fkgram",
            "languages/html.fkgram",
            "languages/css.fkgram",
        ] {
            let asset = &host.release.assets[path];
            std::fs::copy(source.join(path), cache.join(&asset.sha256)).expect("seed asset");
        }

        let missing = host
            .plan(&["javascript".to_owned()], &[])
            .expect("plan javascript");
        assert!(
            missing.is_empty(),
            "planner must not request sidecars below non-delegated intermediates, got: {missing:?}"
        );

        let mut prepared = crate::highlighter::HighlighterCore::with_assets_and_regex_mode(
            host.catalogs().expect("catalogs"),
            crate::RegexMode::Prepared,
        )
        .expect("prepared core");
        assert!(
            prepared
                .load_standard_language("javascript")
                .unwrap()
                .is_some()
        );
        assert!(
            prepared.is_standard_language_ready("javascript"),
            "readiness must agree with planner when intermediate embedded languages have no sidecar"
        );

        std::fs::remove_dir_all(&cache).expect("cleanup cache");
        std::fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    #[ignore = "explicit release-mode startup/asset perf benchmark for #394"]
    fn bench_warm_node_plan_load_and_indexed_precompiled_startup() {
        use std::hint::black_box;
        use std::time::Instant;

        let (source, root) = fixture_root();
        let cache = temp_dir("bench-warm-startup");
        std::fs::create_dir_all(&cache).expect("cache directory");

        // Seed cache with standard payloads + prewarmed decoded/indexed .fkbc for typescript + vue + nord.
        let seed_host = NodeAssetHost::from_root(
            &root,
            &NodeAssetOptions {
                regex_prefilter: None,
                regex_mode: Some(crate::RegexMode::Prepared),
                remote: Some(false),
                base_url: None,
                cache_dir: Some(cache.clone()),
            },
        )
        .expect("seed host");
        for (path, asset) in &seed_host.release.assets {
            let src = source.join(path);
            if src.exists() {
                std::fs::copy(&src, cache.join(&asset.sha256)).expect("seed asset");
            }
        }
        // Prewarm decoded/indexed cache once (warm steady-state restart).
        {
            let mut warm = crate::highlighter::HighlighterCore::with_assets_and_regex_mode(
                seed_host.catalogs().unwrap(),
                crate::RegexMode::Prepared,
            )
            .unwrap();
            warm.load_standard_language("vue").unwrap();
            warm.load_standard_language("typescript").unwrap();
            warm.load_standard_theme("nord").unwrap();
        }

        let ts_code = "export interface Config<T> { name: string; values: Array<T>; }\n\
                       export function format(cfg: Config<number>): string {\n\
                         const sum = cfg.values.reduce((a, b) => a + b, 0);\n\
                         return `${cfg.name}: ${sum}`;\n\
                       }\n";
        let vue_code = "<script setup lang=\"ts\">\nconst count: number = 42;\n</script>\n\
                        <template><div :data-n=\"count\">{{ count }}</div></template>\n";

        let iterations = 40;
        let mut plan_load_ms = Vec::with_capacity(iterations);
        let mut first_highlight_ms = Vec::with_capacity(iterations);
        let mut total_ms = Vec::with_capacity(iterations);
        let mut sha256_per_iter = 0;

        for iter in 0..=iterations {
            let host = NodeAssetHost::from_root(
                &root,
                &NodeAssetOptions {
                    regex_prefilter: None,
                    regex_mode: Some(crate::RegexMode::Prepared),
                    remote: Some(false),
                    base_url: None,
                    cache_dir: Some(cache.clone()),
                },
            )
            .unwrap();
            let mut core = crate::highlighter::HighlighterCore::with_assets_and_regex_mode(
                host.catalogs().unwrap(),
                crate::RegexMode::Prepared,
            )
            .unwrap();

            crate::asset_source::reset_sha256_count();
            let t0 = Instant::now();
            let plan = host
                .plan(
                    &["vue".to_owned(), "typescript".to_owned()],
                    &["nord".to_owned()],
                )
                .unwrap();
            assert!(plan.is_empty());
            core.load_standard_language("vue").unwrap();
            core.load_standard_language("typescript").unwrap();
            core.load_standard_theme("nord").unwrap();
            let t1 = Instant::now();
            let opts = crate::TokenizeOptions::default();
            black_box(core.tokenize(ts_code, "typescript", "nord", &opts).unwrap());
            black_box(core.tokenize(vue_code, "vue", "nord", &opts).unwrap());
            let t2 = Instant::now();

            if iter == 0 {
                let diagnostics = core.regex_diagnostics();
                assert!(
                    diagnostics["preparedBytesRead"].as_u64().unwrap_or(0) > 0,
                    "benchmark must exercise indexed precompiled record reads: {diagnostics}"
                );
                assert!(
                    diagnostics["loadedPreparedGroups"].as_u64().unwrap_or(0) > 0,
                    "benchmark must load prepared Eager groups: {diagnostics}"
                );
                assert_eq!(
                    diagnostics["invalidPreparedGroups"].as_u64().unwrap_or(0),
                    0
                );
                assert_eq!(diagnostics["assemblyFallbacks"].as_u64().unwrap_or(0), 0);
            } else {
                plan_load_ms.push((t1 - t0).as_secs_f64() * 1000.0);
                first_highlight_ms.push((t2 - t1).as_secs_f64() * 1000.0);
                total_ms.push((t2 - t0).as_secs_f64() * 1000.0);
                sha256_per_iter = crate::asset_source::sha256_count();
            }
        }
        plan_load_ms.sort_by(f64::total_cmp);
        first_highlight_ms.sort_by(f64::total_cmp);
        total_ms.sort_by(f64::total_cmp);
        let mid = iterations / 2;
        eprintln!(
            "warm startup (vue+typescript+nord, n={iterations}): plan+load median={:.3} ms, \
             first-highlight median={:.3} ms, total median={:.3} ms, sha256_hashes={sha256_per_iter}",
            plan_load_ms[mid], first_highlight_ms[mid], total_ms[mid]
        );

        std::fs::remove_dir_all(&cache).expect("cleanup cache");
        std::fs::remove_dir_all(&root).expect("cleanup root");
    }
}
