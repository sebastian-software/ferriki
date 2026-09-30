//! Standard payloads from the release-pinned CDN mirror (ADR 0013).
//!
//! A payload is taken from the local cache when present and valid, otherwise
//! downloaded from `<base_url>/<commit>/assets/shiki/<path>`. Downloaded bytes
//! are verified against the release manifest before they are cached, and the
//! cache holds one file per SHA-256 digest, so unchanged payloads are reused
//! across releases. There is no retry policy.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ferriki_asset_gen::{ReleaseManifest, decode_language_manifest, decode_theme_manifest};

use crate::asset_source::{AssetDigest, AssetSource};
use crate::{Error, ErrorKind, Result, StandardAssetCatalogs};

/// The default mirror of this repository's release commits.
pub const DEFAULT_ASSETS_BASE_URL: &str = "https://assets.ferriki.dev";

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const PREFETCH_WORKERS: usize = 6;

/// Where and whether [`crate::StandardAssetCatalogs::remote`] loads payloads.
///
/// Every setting left unset falls back to its environment variable and then to
/// its default: `FERRIKI_ASSETS_REMOTE` (`0` or `false` turns downloads off),
/// `FERRIKI_ASSETS_BASE_URL` ([`DEFAULT_ASSETS_BASE_URL`]) and
/// `FERRIKI_CACHE_DIR` (the platform cache directory plus `ferriki`). The
/// commit defaults to the release commit this crate was published from.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
#[non_exhaustive]
pub struct RemoteAssets {
    pub remote: Option<bool>,
    pub base_url: Option<String>,
    pub cache_dir: Option<PathBuf>,
    pub commit: Option<String>,
}

impl RemoteAssets {
    /// Allows or forbids downloads. Without downloads, only cached payloads load.
    #[must_use]
    pub fn with_remote(mut self, value: Option<bool>) -> Self {
        self.remote = value;
        self
    }

    /// Sets the mirror that serves `<commit>/assets/shiki/<path>`.
    #[must_use]
    pub fn with_base_url(mut self, value: Option<String>) -> Self {
        self.base_url = value;
        self
    }

    /// Sets the digest-addressed cache directory.
    #[must_use]
    pub fn with_cache_dir(mut self, value: Option<PathBuf>) -> Self {
        self.cache_dir = value;
        self
    }

    /// Sets the commit whose tree serves the payloads. Needed for builds from a
    /// repository checkout, which have no published release commit.
    #[must_use]
    pub fn with_commit(mut self, value: Option<String>) -> Self {
        self.commit = value;
        self
    }

    pub(crate) fn resolve(
        &self,
        release: &ReleaseManifest,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<ResolvedRemote> {
        let remote = self.remote.unwrap_or_else(|| {
            env("FERRIKI_ASSETS_REMOTE").is_none_or(|value| {
                !matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false")
            })
        });
        let base_url = self
            .base_url
            .clone()
            .or_else(|| env("FERRIKI_ASSETS_BASE_URL").filter(|value| !value.trim().is_empty()))
            .unwrap_or_else(|| DEFAULT_ASSETS_BASE_URL.to_owned())
            .trim()
            .trim_end_matches('/')
            .to_owned();
        let cache_dir = self
            .cache_dir
            .clone()
            .or_else(|| env("FERRIKI_CACHE_DIR").filter(|value| !value.is_empty()).map(PathBuf::from))
            .or_else(|| platform_cache_dir(&env))
            .ok_or_else(|| {
                Error::new(
                    ErrorKind::AssetIo,
                    "No cache directory for Ferriki assets; set FERRIKI_CACHE_DIR or RemoteAssets::with_cache_dir.",
                )
            })?;
        let commit = self
            .commit
            .clone()
            .or_else(|| release.commit.clone())
            .or_else(|| option_env!("FERRIKI_RELEASE_COMMIT").map(str::to_owned));
        Ok(ResolvedRemote {
            remote,
            base_url,
            cache_dir,
            commit,
        })
    }
}

#[derive(Debug)]
pub(crate) struct ResolvedRemote {
    pub(crate) remote: bool,
    pub(crate) base_url: String,
    pub(crate) cache_dir: PathBuf,
    pub(crate) commit: Option<String>,
}

fn platform_cache_dir(env: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let home = || {
        env("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    let base = if cfg!(target_os = "windows") {
        env("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        home().map(|home| home.join("Library").join("Caches"))
    } else {
        env("XDG_CACHE_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| home().map(|home| home.join(".cache")))
    };
    base.map(|base| base.join("ferriki"))
}

/// Fetches, verifies and caches payloads named in a release manifest.
pub(crate) struct RemoteAssetSource {
    payloads: HashMap<AssetDigest, (String, u64)>,
    settings: ResolvedRemote,
    agent: ureq::Agent,
    /// Rust's `remote()` downloads while it loads. The Node host reads only the
    /// cache on its synchronous paths and downloads in `prefetch` instead.
    download_on_read: bool,
}

impl RemoteAssetSource {
    pub(crate) fn new(
        release: &ReleaseManifest,
        settings: ResolvedRemote,
        download_on_read: bool,
    ) -> Result<Self> {
        let mut payloads = HashMap::with_capacity(release.assets.len());
        for (path, asset) in &release.assets {
            payloads.insert(
                asset.sha256.parse::<AssetDigest>()?,
                (path.clone(), asset.size),
            );
        }
        let tls = ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::Rustls)
            .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        let agent = ureq::Agent::config_builder()
            .tls_config(tls)
            .timeout_global(Some(DOWNLOAD_TIMEOUT))
            .http_status_as_error(false)
            .user_agent(concat!("ferriki/", env!("CARGO_PKG_VERSION")))
            .build()
            .new_agent();
        Ok(Self {
            payloads,
            settings,
            agent,
            download_on_read,
        })
    }

    /// Makes sure a payload is in the cache, downloading it when allowed.
    pub(crate) fn fetch(&self, digest: &AssetDigest) -> Result<()> {
        let (path, size) = self.payload(digest)?;
        if self.read_cached(digest).is_some() {
            return Ok(());
        }
        if !self.settings.remote {
            return Err(self.remote_off(path));
        }
        self.download(digest, path, size).map(|_| ())
    }

    fn payload(&self, digest: &AssetDigest) -> Result<(&str, u64)> {
        self.payloads
            .get(digest)
            .map(|(path, size)| (path.as_str(), *size))
            .ok_or_else(|| {
                Error::new(
                    ErrorKind::AssetUnavailable,
                    format!("Asset {} is not part of this release.", digest.as_str()),
                )
            })
    }

    fn remote_off(&self, path: &str) -> Error {
        Error::new(
            ErrorKind::AssetUnavailable,
            format!(
                "Asset {path} is not cached in {} and remote assets are turned off. \
                 Allow remote assets, point FERRIKI_ASSETS_BASE_URL at a mirror, or pre-populate the cache.",
                self.settings.cache_dir.display()
            ),
        )
    }

    fn cache_path(&self, digest: &AssetDigest) -> PathBuf {
        self.settings.cache_dir.join(digest.as_str())
    }

    fn read_cached(&self, digest: &AssetDigest) -> Option<Vec<u8>> {
        let path = self.cache_path(digest);
        let bytes = std::fs::read(&path).ok()?;
        if AssetDigest::of(&bytes) == *digest {
            return Some(bytes);
        }
        // A truncated or foreign file is replaced by a fresh download.
        let _ = std::fs::remove_file(path);
        None
    }

    fn download(&self, digest: &AssetDigest, path: &str, size: u64) -> Result<Vec<u8>> {
        let commit = self.settings.commit.as_deref().ok_or_else(|| {
            Error::new(
                ErrorKind::AssetUnavailable,
                format!(
                    "Asset {path} is not cached, and this build has no release commit to download it from. \
                     Set RemoteAssets::with_commit, or pre-populate {}.",
                    self.settings.cache_dir.display()
                ),
            )
        })?;
        let url = format!("{}/{commit}/assets/shiki/{path}", self.settings.base_url);
        let failed = |detail: String| {
            Error::new(
                ErrorKind::AssetDownload,
                format!("Downloading {url} failed: {detail}"),
            )
        };
        let mut response = self
            .agent
            .get(&url)
            .call()
            .map_err(|error| failed(error.to_string()))?;
        let status = response.status();
        if status != 200 {
            return Err(failed(format!("HTTP {}", status.as_u16())));
        }
        let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
        response
            .body_mut()
            .as_reader()
            .take(size.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| failed(error.to_string()))?;
        if bytes.len() as u64 != size || AssetDigest::of(&bytes) != *digest {
            return Err(Error::new(
                ErrorKind::AssetIntegrity,
                format!(
                    "{url} did not match its release-pinned SHA-256 and size; it was not cached."
                ),
            ));
        }
        self.store(digest, &bytes)?;
        Ok(bytes)
    }

    /// Writes through a unique temporary file and a rename, so concurrent
    /// processes never observe a partial cache entry.
    fn store(&self, digest: &AssetDigest, bytes: &[u8]) -> Result<()> {
        let io = |error: std::io::Error| {
            Error::new(
                ErrorKind::AssetIo,
                format!(
                    "Cannot write asset {} to the cache {}.",
                    digest.as_str(),
                    self.settings.cache_dir.display()
                ),
            )
            .with_source(error)
        };
        std::fs::create_dir_all(&self.settings.cache_dir).map_err(io)?;
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let temporary = self.settings.cache_dir.join(format!(
            "{}.{}-{nanos}.tmp",
            digest.as_str(),
            std::process::id()
        ));
        std::fs::write(&temporary, bytes).map_err(io)?;
        std::fs::rename(&temporary, self.cache_path(digest)).map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            io(error)
        })
    }
}

impl AssetSource for RemoteAssetSource {
    fn read(&self, digest: &AssetDigest) -> Result<Cow<'_, [u8]>> {
        let (path, size) = self.payload(digest)?;
        if let Some(bytes) = self.read_cached(digest) {
            return Ok(Cow::Owned(bytes));
        }
        if !self.download_on_read {
            return Err(Error::new(
                ErrorKind::AssetUnavailable,
                format!(
                    "Asset {path} is not cached in {}. Load it through the asynchronous \
                     createHighlighter, loadLanguage or loadTheme first, or pre-populate the cache.",
                    self.settings.cache_dir.display()
                ),
            ));
        }
        if !self.settings.remote {
            return Err(self.remote_off(path));
        }
        self.download(digest, path, size).map(Cow::Owned)
    }
}

/// Shares one remote source between the catalogs and the Node host's prefetch.
struct SharedRemoteSource(Arc<RemoteAssetSource>);

impl AssetSource for SharedRemoteSource {
    fn read(&self, digest: &AssetDigest) -> Result<Cow<'_, [u8]>> {
        self.0.read(digest)
    }
}

/// Standard assets for the N-API host: catalogs that read only the cache, and
/// a thread-safe `prefetch` that downloads what a load will need (ADR 0013).
/// Exempt from semver guarantees.
pub struct RemoteAssetHost {
    source: Arc<RemoteAssetSource>,
    release: ReleaseManifest,
    language_manifest: Vec<u8>,
    theme_manifest: Vec<u8>,
    languages: HashMap<String, (String, Vec<String>)>,
    language_aliases: HashMap<String, String>,
    themes: HashMap<String, String>,
}

impl RemoteAssetHost {
    /// Reads `languages/manifest.fkindex`, `themes/manifest.fkindex` and
    /// `release-manifest.json` below `root`.
    pub fn from_root(root: &Path, settings: &RemoteAssets) -> Result<Self> {
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
            for alias in &entry.aliases {
                language_aliases.insert(alias.clone(), entry.id.clone());
            }
            languages.insert(
                entry.id.clone(),
                (
                    format!("languages/{}", entry.asset_file),
                    entry.embedded_langs,
                ),
            );
        }
        let themes = decode_theme_manifest(&theme_manifest)
            .map_err(format)?
            .entries
            .into_iter()
            .map(|entry| (entry.id, format!("themes/{}", entry.asset_file)))
            .collect();
        let resolved = settings.resolve(&release, |key| std::env::var(key).ok())?;
        let source = Arc::new(RemoteAssetSource::new(&release, resolved, false)?);
        Ok(Self {
            source,
            release,
            language_manifest,
            theme_manifest,
            languages,
            language_aliases,
            themes,
        })
    }

    /// Catalogs over the shared source; loading a payload never downloads.
    pub fn catalogs(&self) -> Result<StandardAssetCatalogs> {
        StandardAssetCatalogs::from_release_manifest(
            &self.language_manifest,
            &self.theme_manifest,
            &self.release,
            SharedRemoteSource(Arc::clone(&self.source)),
        )
    }

    /// Downloads the payloads these languages, their embedded languages and
    /// these themes need, unless they are cached. Unknown names are skipped;
    /// loading them reports the error. Blocking; call it off the main thread.
    pub fn prefetch(&self, languages: &[String], themes: &[String]) -> Result<()> {
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
        let digests = paths
            .into_iter()
            .map(|path| self.release.assets[path].sha256.parse::<AssetDigest>())
            .collect::<Result<Vec<_>>>()?;
        // A language with its embedded languages is a dozen small files; fetch
        // them concurrently, a few at a time, and report the first failure.
        let workers = digests.len().min(PREFETCH_WORKERS);
        let next = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..workers)
                .map(|_| {
                    scope.spawn(|| {
                        loop {
                            let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let Some(digest) = digests.get(index) else {
                                return Ok(());
                            };
                            self.source.fetch(digest)?;
                        }
                    })
                })
                .collect();
            // The scope joins every worker before it returns, even after an error.
            handles.into_iter().try_for_each(|handle| {
                handle.join().unwrap_or_else(|_| {
                    Err(Error::from_reason("An asset download thread panicked."))
                })
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn release(commit: Option<&str>) -> ReleaseManifest {
        ReleaseManifest::from_json(&format!(
            r#"{{"manifestVersion":1,{}"assets":{{}}}}"#,
            commit.map_or(String::new(), |commit| format!(r#""commit":"{commit}","#))
        ))
        .expect("manifest")
    }

    fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let vars: BTreeMap<String, String> = vars
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        move |key| vars.get(key).cloned()
    }

    #[test]
    fn defaults_come_from_the_environment_then_the_platform() {
        let resolved = RemoteAssets::default()
            .resolve(
                &release(Some("abc")),
                env(&[
                    ("HOME", "/home/me"),
                    ("XDG_CACHE_HOME", "/xdg"),
                    ("LOCALAPPDATA", "/local"),
                ]),
            )
            .expect("resolve");
        assert!(resolved.remote);
        assert_eq!(resolved.base_url, DEFAULT_ASSETS_BASE_URL);
        assert_eq!(resolved.commit.as_deref(), Some("abc"));
        let expected = if cfg!(target_os = "windows") {
            PathBuf::from("/local").join("ferriki")
        } else if cfg!(target_os = "macos") {
            PathBuf::from("/home/me/Library/Caches").join("ferriki")
        } else {
            PathBuf::from("/xdg").join("ferriki")
        };
        assert_eq!(resolved.cache_dir, expected);

        let resolved = RemoteAssets::default()
            .resolve(
                &release(None),
                env(&[
                    ("FERRIKI_ASSETS_REMOTE", "False"),
                    ("FERRIKI_ASSETS_BASE_URL", "https://mirror.example/ferriki/"),
                    ("FERRIKI_CACHE_DIR", "/cache"),
                ]),
            )
            .expect("resolve");
        assert!(!resolved.remote);
        assert_eq!(resolved.base_url, "https://mirror.example/ferriki");
        assert_eq!(resolved.cache_dir, PathBuf::from("/cache"));
    }

    #[test]
    fn explicit_settings_win_over_the_environment() {
        let resolved = RemoteAssets::default()
            .with_remote(Some(true))
            .with_base_url(Some("http://localhost:1".to_owned()))
            .with_cache_dir(Some(PathBuf::from("/explicit")))
            .with_commit(Some("def".to_owned()))
            .resolve(
                &release(Some("abc")),
                env(&[
                    ("FERRIKI_ASSETS_REMOTE", "0"),
                    ("FERRIKI_ASSETS_BASE_URL", "https://mirror.example"),
                    ("FERRIKI_CACHE_DIR", "/cache"),
                ]),
            )
            .expect("resolve");
        assert!(resolved.remote);
        assert_eq!(resolved.base_url, "http://localhost:1");
        assert_eq!(resolved.cache_dir, PathBuf::from("/explicit"));
        assert_eq!(resolved.commit.as_deref(), Some("def"));
    }

    #[test]
    fn a_missing_cache_directory_is_a_typed_error() {
        let error = RemoteAssets::default()
            .resolve(&release(None), env(&[]))
            .expect_err("no cache directory");
        assert_eq!(error.kind(), ErrorKind::AssetIo);
        assert!(error.to_string().contains("FERRIKI_CACHE_DIR"));
    }
}
