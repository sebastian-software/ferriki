//! Standard payloads from the release-pinned CDN mirror (ADR 0013).
//!
//! A payload is taken from the local cache when present and valid, otherwise
//! downloaded from `<base_url>/<commit>/assets/shiki/<path>`. Downloaded bytes
//! are verified against the release manifest before they are cached, and the
//! cache holds one file per SHA-256 digest, so unchanged payloads are reused
//! across releases. There is no retry policy.

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ferriki_asset_gen::ReleaseManifest;

use crate::asset_source::{AssetDigest, AssetSource};
use crate::{Error, ErrorKind, Result};

/// The default mirror of this repository's release commits.
pub const DEFAULT_ASSETS_BASE_URL: &str = "https://assets.ferriki.dev";

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

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
}

impl RemoteAssetSource {
    pub(crate) fn new(release: &ReleaseManifest, settings: ResolvedRemote) -> Result<Self> {
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
        })
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
        let (path, size) = self.payloads.get(digest).ok_or_else(|| {
            Error::new(
                ErrorKind::AssetUnavailable,
                format!("Asset {} is not part of this release.", digest.as_str()),
            )
        })?;
        if let Some(bytes) = self.read_cached(digest) {
            return Ok(Cow::Owned(bytes));
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
        self.download(digest, path, *size).map(Cow::Owned)
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
                env(&[("HOME", "/home/me"), ("XDG_CACHE_HOME", "/xdg")]),
            )
            .expect("resolve");
        assert!(resolved.remote);
        assert_eq!(resolved.base_url, DEFAULT_ASSETS_BASE_URL);
        assert_eq!(resolved.commit.as_deref(), Some("abc"));
        if cfg!(target_os = "macos") {
            assert_eq!(
                resolved.cache_dir,
                PathBuf::from("/home/me/Library/Caches/ferriki")
            );
        } else if !cfg!(target_os = "windows") {
            assert_eq!(resolved.cache_dir, PathBuf::from("/xdg/ferriki"));
        }

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
