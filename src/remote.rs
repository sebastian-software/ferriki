//! Standard payloads from the release-pinned CDN mirror (ADR 0013).
//!
//! A payload is taken from the local cache when present and valid, otherwise
//! downloaded from immutable language/theme hash paths selected by the catalog. Downloaded bytes
//! are verified against the release manifest before they are cached, and the
//! cache holds one file per SHA-256 digest, so unchanged payloads are reused
//! across releases. Transient failures receive bounded backoff within one shared
//! network deadline; permanent failures and invalid payloads fail directly.

use std::borrow::Cow;
use std::collections::hash_map::RandomState;
use std::collections::{BTreeSet, HashMap};
use std::fs::OpenOptions;
use std::hash::{BuildHasher, Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ferriki_asset_gen::{ReleaseManifest, decode_language_manifest, decode_theme_manifest};

pub use crate::asset_settings::DEFAULT_ASSETS_BASE_URL;
use crate::asset_settings::{
    AssetSettingsInput, ResolvedAssetSettings, catalog_path, resolve_asset_settings,
};
use crate::asset_source::{
    AssetDigest, AssetSource, InternalVerifiedSource, VerifiedBytes, VerifiedPayloadCache,
    open_nonblocking,
};
use crate::{Error, ErrorKind, Result, StandardAssetCatalogs};

#[cfg(test)]
mod retry_tests;

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const DOWNLOAD_ATTEMPTS: usize = 3;
const RETRY_DELAY: Duration = Duration::from_millis(250);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(5);
const PREFETCH_WORKERS: usize = 6;
const MAX_TEMP_FILE_ATTEMPTS: usize = 64;
static NEXT_CACHE_WRITE: AtomicU64 = AtomicU64::new(0);

/// Where and whether [`crate::StandardAssetCatalogs::remote`] loads payloads.
///
/// Every setting left unset falls back to its environment variable and then to
/// its default: `FERRIKI_ASSETS_REMOTE` (`0` or `false` turns downloads off),
/// `FERRIKI_ASSETS_BASE_URL` ([`DEFAULT_ASSETS_BASE_URL`]) and
/// `FERRIKI_CACHE_DIR` (the platform cache directory plus `ferriki`). Standard
/// `language-hash-v2` catalogs address payloads by language/theme ID and short
/// hash without needing a commit; [`Self::with_commit`] takes effect only when
/// a catalog manifest uses legacy commit-routed storage (not the embedded
/// `language-hash-v2` catalog).
/// Set `FERRIKI_ASSETS_PROTECTED=1` and `FERRIKI_DOWNLOAD_TOKEN` to authorize
/// cache misses against the protected default CDN. Cached and offline loads do
/// not require a token; protected mode does not use a custom mirror.
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

    /// Sets the mirror that serves immutable language/theme hash paths.
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

    /// Sets the commit path segment for manifests that use legacy commit-routed
    /// storage.
    ///
    /// URL routing is selected by the catalog manifest's `storageLayout`, not
    /// by [`Self::with_base_url`]. The embedded `language-hash-v2` catalog
    /// always requests content-addressed `<id>/<short-hash>` and
    /// `themes/<id>/<short-hash>` paths regardless of mirror URL, and
    /// commit-based paths on `assets.ferriki.dev` have been retired. Leave
    /// this unset unless loading a legacy commit-routed manifest (without
    /// `storageLayout`) against a custom mirror serving
    /// `<commit>/assets/shiki/<path>` URLs.
    #[must_use]
    pub fn with_commit(mut self, value: Option<String>) -> Self {
        self.commit = value;
        self
    }

    pub(crate) fn resolve(
        &self,
        release: &ReleaseManifest,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<ResolvedAssetSettings> {
        resolve_asset_settings(
            AssetSettingsInput {
                remote: self.remote,
                base_url: self.base_url.clone(),
                cache_dir: self.cache_dir.clone(),
                commit: self.commit.clone(),
                release_commit: release.commit.clone(),
                compiled_commit: option_env!("FERRIKI_RELEASE_COMMIT"),
                cache_hint: "set FERRIKI_CACHE_DIR or RemoteAssets::with_cache_dir",
            },
            env,
        )
    }
}

/// Fetches, verifies and caches payloads named in a release manifest.
pub(crate) struct RemoteAssetSource {
    payloads: HashMap<AssetDigest, (String, u64)>,
    settings: ResolvedAssetSettings,
    storage_layout: Option<String>,
    agent: ureq::Agent,
    /// Rust's `remote()` downloads while it loads. Node plans downloads in Rust
    /// and lets the JavaScript host fetch and install bytes asynchronously.
    download_on_read: bool,
    /// Bounded one-shot handoff of verified payloads populated by `fetch()` so
    /// immediate catalog loads avoid re-reading and re-hashing the same bytes.
    verified_cache: Mutex<VerifiedPayloadCache>,
}

impl RemoteAssetSource {
    pub(crate) fn new(
        release: &ReleaseManifest,
        settings: ResolvedAssetSettings,
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
            storage_layout: release.storage_layout.clone(),
            agent,
            download_on_read,
            verified_cache: Mutex::new(VerifiedPayloadCache::new()),
        })
    }

    /// Makes sure a payload is in the cache, downloading it when allowed, and
    /// returns the verified bytes so a batch can stage them atomically on success.
    pub(crate) fn fetch(&self, digest: &AssetDigest) -> Result<VerifiedBytes> {
        let (path, size) = self.payload(digest)?;
        if let Some(verified) = self.read_cached(digest, size) {
            Ok(verified)
        } else if !self.settings.remote {
            Err(self.remote_off(path))
        } else {
            self.download(digest, path, size)
        }
    }

    pub(crate) fn clear_verified_cache(&self) {
        if let Ok(mut cache) = self.verified_cache.lock() {
            cache.clear();
        }
    }

    #[cfg(test)]
    fn verified_cache_stats(&self) -> (usize, usize) {
        self.verified_cache
            .lock()
            .map_or((0, 0), |cache| (cache.len(), cache.total_bytes()))
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

    fn read_cached(&self, digest: &AssetDigest, size: u64) -> Option<VerifiedBytes> {
        let path = self.cache_path(digest);
        let file = open_nonblocking(&path).ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() || metadata.len() != size {
            // Reject a malformed cache entry before allocating based on its
            // file size. The manifest pins the only acceptable size.
            drop(file);
            let _ = std::fs::remove_file(path);
            return None;
        }
        let capacity = usize::try_from(size).ok()?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(capacity).ok()?;
        if file
            .take(size.saturating_add(1))
            .read_to_end(&mut bytes)
            .is_err()
        {
            return None;
        }
        if let Ok(verified) = VerifiedBytes::verify(bytes, digest, size) {
            return Some(verified);
        }
        // A truncated or foreign file is replaced by a fresh download.
        let _ = std::fs::remove_file(path);
        None
    }

    fn download(&self, digest: &AssetDigest, path: &str, size: u64) -> Result<VerifiedBytes> {
        let url = crate::asset_settings::asset_url(
            self.storage_layout.as_deref(),
            &self.settings,
            path,
            digest.as_str(),
        )?;
        let protected = protected_selected()?;
        let bytes = if protected {
            let deadline = Instant::now() + DOWNLOAD_TIMEOUT;
            let path = protected_path(&url)?;
            let token = std::env::var("FERRIKI_DOWNLOAD_TOKEN").map_err(|_| protected_error())?;
            if token.is_empty() || token.contains(['\r', '\n']) {
                return Err(protected_error());
            }
            let signed = self.authorize_protected(path, digest.as_str(), size, &token, deadline)?;
            self.read_protected(&signed, size, deadline)?
        } else {
            self.read_remote_until(&url, size, Instant::now() + DOWNLOAD_TIMEOUT)?
        };
        let verified = VerifiedBytes::verify(bytes, digest, size).map_err(|_| {
            Error::new(
                ErrorKind::AssetIntegrity,
                if protected {
                    "Protected asset did not match its release-pinned SHA-256 and size; it was not cached.".to_owned()
                } else {
                    format!(
                        "{url} did not match its release-pinned SHA-256 and size; it was not cached."
                    )
                },
            )
        })?;
        self.store(digest, verified.as_slice())?;
        Ok(verified)
    }

    fn authorize_protected(
        &self,
        path: &str,
        digest: &str,
        size: u64,
        token: &str,
        deadline: Instant,
    ) -> Result<String> {
        self.authorize_protected_at(
            "https://downloads.ferriki.dev/v1/downloads",
            path,
            digest,
            size,
            token,
            deadline,
        )
    }

    fn authorize_protected_at(
        &self,
        issuer: &str,
        path: &str,
        digest: &str,
        size: u64,
        token: &str,
        deadline: Instant,
    ) -> Result<String> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(protected_error());
        }
        let body = serde_json::json!({ "path": path, "sha256": digest }).to_string();
        let mut response = self
            .agent
            .post(issuer)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .config()
            .max_redirects(0)
            .timeout_global(Some(remaining))
            .build()
            .send(body.as_bytes())
            .map_err(|_| protected_error())?;
        if response.status().as_u16() != 200 {
            return Err(protected_error());
        }
        let mut data = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(8193)
            .read_to_end(&mut data)
            .map_err(|_| protected_error())?;
        if data.len() > 8192 {
            return Err(protected_error());
        }
        parse_issuer_response(&data, path, digest, size)
    }

    fn read_protected(&self, url: &str, size: u64, deadline: Instant) -> Result<Vec<u8>> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(protected_error());
        }
        let mut response = self
            .agent
            .get(url)
            .config()
            .max_redirects(0)
            .timeout_global(Some(remaining))
            .build()
            .call()
            .map_err(|_| protected_error())?;
        if response.status().as_u16() != 200 {
            return Err(protected_error());
        }
        let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
        response
            .body_mut()
            .as_reader()
            .take(size.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| protected_error())?;
        Ok(bytes)
    }

    fn read_remote_until(&self, url: &str, size: u64, deadline: Instant) -> Result<Vec<u8>> {
        let mut attempts = 0;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(DownloadFailure::transport(ureq::Error::Timeout(
                    ureq::Timeout::Global,
                ))
                .into_error(url));
            }
            attempts += 1;
            match self.read_remote_once(url, size, remaining) {
                Ok(bytes) => return Ok(bytes),
                Err(failure) => match failure.retry_delay(attempts - 1) {
                    Some(wait)
                        if attempts < DOWNLOAD_ATTEMPTS
                            && wait < deadline.saturating_duration_since(Instant::now()) =>
                    {
                        std::thread::sleep(wait);
                    }
                    _ => return Err(failure.into_error(url)),
                },
            }
        }
    }

    fn read_remote_once(
        &self,
        url: &str,
        size: u64,
        remaining: Duration,
    ) -> std::result::Result<Vec<u8>, DownloadFailure> {
        let mut response = self
            .agent
            .get(url)
            .config()
            .max_redirects(0)
            .timeout_global(Some(remaining))
            .build()
            .call()
            .map_err(DownloadFailure::transport)?;
        let status = response.status().as_u16();
        if status != 200 {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| retry_after_delay(value, SystemTime::now()));
            return Err(DownloadFailure {
                source: ureq::Error::StatusCode(status),
                retry_after,
            });
        }
        let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
        response
            .body_mut()
            .as_reader()
            .take(size.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| DownloadFailure::transport(error.into()))?;
        Ok(bytes)
    }

    /// Writes through an exclusive temporary file and a rename, so concurrent
    /// processes never observe a partial cache entry.
    fn store(&self, digest: &AssetDigest, bytes: &[u8]) -> Result<()> {
        self.store_with_rename(
            digest,
            bytes,
            &NEXT_CACHE_WRITE,
            process_temp_nonce(),
            |from, to| std::fs::rename(from, to),
        )
    }

    fn store_with_rename(
        &self,
        digest: &AssetDigest,
        bytes: &[u8],
        counter: &AtomicU64,
        nonce: u64,
        rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
    ) -> Result<()> {
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
        let mut attempts = 0;
        let (temporary, mut file) = loop {
            // Relaxed ordering suffices for a unique filename; no data is published by this counter.
            let serial = counter.fetch_add(1, Ordering::Relaxed);
            let candidate = self
                .settings
                .cache_dir
                .join(temp_file_name(digest, nonce, serial));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => break (candidate, file),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    attempts += 1;
                    if attempts >= MAX_TEMP_FILE_ATTEMPTS {
                        return Err(io(error));
                    }
                }
                Err(error) => return Err(io(error)),
            }
        };
        if let Err(error) = file.write_all(bytes) {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err(io(error));
        }
        drop(file);
        let target = self.cache_path(digest);
        if let Err(error) = rename(&temporary, &target) {
            let _ = std::fs::remove_file(&temporary);
            if self.verify_cached_readonly(digest, bytes.len() as u64) {
                return Ok(());
            }
            return Err(io(error));
        }
        Ok(())
    }

    /// Read-only verification of a concurrent cache winner; never unlinks the target path.
    fn verify_cached_readonly(&self, digest: &AssetDigest, size: u64) -> bool {
        let path = self.cache_path(digest);
        let Ok(file) = crate::asset_source::open_nonblocking(&path) else {
            return false;
        };
        let Ok(metadata) = file.metadata() else {
            return false;
        };
        if !metadata.is_file() || metadata.len() != size {
            return false;
        }
        let Ok(capacity) = usize::try_from(size) else {
            return false;
        };
        let mut bytes = Vec::new();
        if bytes.try_reserve_exact(capacity).is_err() {
            return false;
        }
        if file
            .take(size.saturating_add(1))
            .read_to_end(&mut bytes)
            .is_err()
        {
            return false;
        }
        bytes.len() as u64 == size && AssetDigest::of(&bytes) == *digest
    }
}

fn process_temp_nonce() -> u64 {
    static NONCE: OnceLock<u64> = OnceLock::new();
    *NONCE.get_or_init(|| {
        let mut hasher = RandomState::new().build_hasher();
        std::process::id().hash(&mut hasher);
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos())
            .hash(&mut hasher);
        (&NONCE as *const OnceLock<u64> as usize).hash(&mut hasher);
        hasher.finish()
    })
}

fn temp_file_name(digest: &AssetDigest, nonce: u64, serial: u64) -> String {
    format!(
        "{}.{}-{nonce:016x}-{serial}.tmp",
        digest.as_str(),
        std::process::id()
    )
}

fn protected_error() -> Error {
    Error::new(
        ErrorKind::AssetDownload,
        "Protected asset download failed; check the protected download configuration.",
    )
}

fn protected_selected() -> Result<bool> {
    match std::env::var("FERRIKI_ASSETS_PROTECTED") {
        Err(std::env::VarError::NotPresent) => Ok(false),
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "" | "0" | "false" => Ok(false),
            "1" | "true" => Ok(true),
            _ => Err(protected_error()),
        },
        Err(_) => Err(protected_error()),
    }
}

fn protected_path(url: &str) -> Result<&str> {
    let path = url
        .strip_prefix("https://assets.ferriki.dev")
        .ok_or_else(protected_error)?;
    let parts: Vec<_> = path
        .strip_prefix('/')
        .ok_or_else(protected_error)?
        .split('/')
        .collect();
    let valid_id = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    };
    let valid_hash = |s: &str| s.len() == 8 && s.bytes().all(|c| c.is_ascii_alphanumeric());
    match parts.as_slice() {
        [id, hash] if valid_id(id) && valid_hash(hash) => Ok(path),
        ["themes", id, hash] if valid_id(id) && valid_hash(hash) => Ok(path),
        _ => Err(protected_error()),
    }
}

fn parse_issuer_response(data: &[u8], path: &str, digest: &str, size: u64) -> Result<String> {
    let value: serde_json::Value = serde_json::from_slice(data).map_err(|_| protected_error())?;
    if value.get("bytes").and_then(serde_json::Value::as_u64) != Some(size)
        || value.get("sha256").and_then(serde_json::Value::as_str) != Some(digest)
    {
        return Err(protected_error());
    }
    let url = value
        .get("url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(protected_error)?;
    validate_signed_url(url, path)?;
    Ok(url.to_owned())
}

fn validate_signed_url(url: &str, path: &str) -> Result<()> {
    let rest = url
        .strip_prefix("https://protected-assets.ferriki.dev")
        .ok_or_else(protected_error)?;
    let (actual_path, query) = rest.split_once('?').ok_or_else(protected_error)?;
    if actual_path != path || query.contains('#') {
        return Err(protected_error());
    }
    let mut token = false;
    let mut expires = false;
    for field in query.split('&') {
        let (key, value) = field.split_once('=').ok_or_else(protected_error)?;
        match key {
            "token"
                if !token
                    && !value.is_empty()
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
            {
                token = true
            }
            "expires"
                if !expires && !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) =>
            {
                expires = true
            }
            _ => return Err(protected_error()),
        }
    }
    if !token || !expires {
        return Err(protected_error());
    }
    Ok(())
}

struct DownloadFailure {
    source: ureq::Error,
    retry_after: Option<Duration>,
}

impl DownloadFailure {
    fn transport(source: ureq::Error) -> Self {
        Self {
            source,
            retry_after: None,
        }
    }

    fn retry_delay(&self, attempt: usize) -> Option<Duration> {
        let transient = match &self.source {
            ureq::Error::StatusCode(status) => matches!(status, 408 | 429 | 500..=599),
            error => transient_transport_error(error),
        };
        if !transient {
            return None;
        }
        let wait = (RETRY_DELAY * (1 << attempt)).max(self.retry_after.unwrap_or_default());
        (wait <= MAX_RETRY_DELAY).then_some(wait)
    }

    fn into_error(self, url: &str) -> Error {
        let detail = match &self.source {
            ureq::Error::StatusCode(status) => format!("HTTP {status}"),
            error => error.to_string(),
        };
        Error::new(
            ErrorKind::AssetDownload,
            format!("Downloading {url} failed: {detail}"),
        )
        .with_source(self.source)
    }
}

fn transient_transport_error(error: &ureq::Error) -> bool {
    match error {
        ureq::Error::Timeout(_) | ureq::Error::ConnectionFailed => true,
        // std's DNS lookup erases temporary/permanent resolver codes into an
        // opaque I/O error. Retry network I/O within the same finite budget;
        // cache/filesystem operations are deliberately outside this loop.
        ureq::Error::Io(error) => !matches!(
            error.kind(),
            std::io::ErrorKind::InvalidInput
                | std::io::ErrorKind::InvalidData
                | std::io::ErrorKind::PermissionDenied
                | std::io::ErrorKind::NotFound
                | std::io::ErrorKind::Unsupported
        ),
        ureq::Error::Decompress(_, error) => matches!(
            error.kind(),
            std::io::ErrorKind::TimedOut
                | std::io::ErrorKind::Interrupted
                | std::io::ErrorKind::WouldBlock
                | std::io::ErrorKind::ConnectionRefused
                | std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::UnexpectedEof
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::NotConnected
                | std::io::ErrorKind::NetworkDown
                | std::io::ErrorKind::NetworkUnreachable
                | std::io::ErrorKind::HostUnreachable
        ),
        _ => false,
    }
}

fn retry_after_delay(value: &str, now: SystemTime) -> Option<Duration> {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Some(value.parse().map_or(Duration::MAX, Duration::from_secs));
    }
    httpdate::parse_http_date(value)
        .ok()
        .map(|date| date.duration_since(now).unwrap_or_default())
}

impl RemoteAssetSource {
    fn read_verified_inner(
        &self,
        digest: &AssetDigest,
        expected_size: Option<u64>,
    ) -> Result<VerifiedBytes> {
        let (path, size) = self.payload(digest)?;
        if expected_size.is_some_and(|expected| expected != size) {
            return Err(Error::new(
                ErrorKind::AssetIntegrity,
                format!(
                    "Asset {} failed its SHA-256 or byte-size check.",
                    digest.as_str()
                ),
            ));
        }
        if let Ok(mut cache) = self.verified_cache.lock()
            && let Some(verified) = cache.take(digest)
            && verified.digest() == digest
            && verified.len() as u64 == size
        {
            return Ok(verified);
        }
        if let Some(verified) = self.read_cached(digest, size) {
            return Ok(verified);
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
        self.download(digest, path, size)
    }
}

impl InternalVerifiedSource for RemoteAssetSource {
    fn read_verified(&self, digest: &AssetDigest, expected_size: u64) -> Result<VerifiedBytes> {
        self.read_verified_inner(digest, Some(expected_size))
    }
}

impl AssetSource for RemoteAssetSource {
    fn read(&self, digest: &AssetDigest) -> Result<Cow<'_, [u8]>> {
        self.read_verified_inner(digest, None)
            .map(|verified| Cow::Owned(verified.into_bytes()))
    }
}

/// Shares one remote source between the catalogs and a blocking prefetch host.
struct SharedRemoteSource(Arc<RemoteAssetSource>);

impl InternalVerifiedSource for SharedRemoteSource {
    fn read_verified(&self, digest: &AssetDigest, expected_size: u64) -> Result<VerifiedBytes> {
        self.0.read_verified(digest, expected_size)
    }
}

impl AssetSource for SharedRemoteSource {
    fn read(&self, digest: &AssetDigest) -> Result<Cow<'_, [u8]>> {
        self.0.read(digest)
    }

    fn read_bounded(&self, digest: &AssetDigest, expected_size: u64) -> Result<Cow<'_, [u8]>> {
        self.0.read_bounded(digest, expected_size)
    }
}

/// Standard assets for internal Rust hosts: catalogs that read only the cache,
/// and a thread-safe `prefetch` that downloads what a load will need (ADR 0013).
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
        StandardAssetCatalogs::from_verified_release_manifest(
            &self.language_manifest,
            &self.theme_manifest,
            &self.release,
            SharedRemoteSource(Arc::clone(&self.source)),
        )
        .map(|catalogs| catalogs.with_decoded_cache(self.source.settings.cache_dir.clone()))
    }

    /// Downloads the payloads these languages, their embedded languages and
    /// these themes need, unless they are cached. Unknown names are skipped;
    /// loading them reports the error. Blocking; call it off the main thread.
    pub fn prefetch(&self, languages: &[String], themes: &[String]) -> Result<()> {
        let mut paths = BTreeSet::new();
        let mut pending: Vec<(&str, bool)> =
            languages.iter().map(|id| (id.as_str(), true)).collect();
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
            let delegated = prepared
                && self
                    .release
                    .assets
                    .get(&bytecode)
                    .is_some_and(|asset| asset.format_version >> 24 >= 3);
            if prepared
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
        let digests = paths
            .into_iter()
            .filter(|path| {
                !path.ends_with(".fkbc")
                    || !self.release.assets.get(path).is_some_and(|asset| {
                        crate::AssetMetadata::from_release_asset(asset).is_ok_and(|metadata| {
                            crate::precompiled_cache::available(
                                &self.source.settings.cache_dir,
                                &metadata,
                            )
                        })
                    })
            })
            .map(|path| {
                let asset = self.release.assets.get(&path).ok_or_else(|| {
                    Error::new(
                        ErrorKind::AssetFormat,
                        format!("Release metadata is missing `{path}`."),
                    )
                })?;
                Ok((
                    asset.sha256.parse::<AssetDigest>()?,
                    path.ends_with(".fkbc"),
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        // A language with its embedded languages is a dozen small files; fetch
        // them concurrently, a few at a time, and report the first failure.
        // Stage verified payloads in a bounded per-batch cache and publish them
        // into the shared handoff cache only after the entire batch succeeds.
        let workers = digests.len().min(PREFETCH_WORKERS);
        let next = std::sync::atomic::AtomicUsize::new(0);
        let staged = Mutex::new(VerifiedPayloadCache::new());
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..workers)
                .map(|_| {
                    scope.spawn(|| {
                        loop {
                            let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let Some((digest, optional)) = digests.get(index) else {
                                return Ok(());
                            };
                            match self.source.fetch(digest) {
                                Ok(verified) => {
                                    if let Ok(mut batch) = staged.lock() {
                                        batch.insert(verified);
                                    }
                                }
                                Err(error) if !optional => return Err(error),
                                Err(_) => {}
                            }
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
        })?;
        if let Ok(staged) = staged.into_inner()
            && !staged.is_empty()
            && let Ok(mut cache) = self.source.verified_cache.lock()
        {
            for verified in staged.into_payloads() {
                cache.insert(verified);
            }
        }
        Ok(())
    }

    /// Releases any unconsumed verified payloads staged by [`Self::prefetch`].
    ///
    /// Callers that prefetch assets for languages or themes which turn out to
    /// be already loaded can call this once loading settles to reclaim memory
    /// immediately.
    pub fn clear_verified_cache(&self) {
        self.source.clear_verified_cache();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferriki_asset_gen::{AssetSourceRef, generate_catalogs_from_upstream};
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ferriki-remote-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn release(commit: Option<&str>) -> ReleaseManifest {
        ReleaseManifest::from_json(&format!(
            r#"{{"manifestVersion":1,{}"assets":{{}}}}"#,
            commit.map_or(String::new(), |commit| format!(r#""commit":"{commit}","#))
        ))
        .expect("manifest")
    }

    fn release_with_asset(bytes: &[u8]) -> (ReleaseManifest, AssetDigest) {
        let digest = AssetDigest::of(bytes);
        let manifest = ReleaseManifest::from_json(&format!(
            r#"{{"manifestVersion":1,"assets":{{"languages/test.fkgram":{{"sha256":"{}","size":{},"formatVersion":1}}}}}}"#,
            digest.as_str(),
            bytes.len()
        ))
        .expect("manifest");
        (manifest, digest)
    }

    fn offline_source(release: &ReleaseManifest, cache_dir: &Path) -> RemoteAssetSource {
        let settings = RemoteAssets::default()
            .with_remote(Some(false))
            .with_cache_dir(Some(cache_dir.to_path_buf()))
            .with_commit(Some("abc".to_owned()))
            .resolve(release, env(&[]))
            .expect("settings");
        RemoteAssetSource::new(release, settings, false).expect("remote source")
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

    #[test]
    fn oversized_cache_entries_are_rejected_offline() {
        let expected = b"release-pinned payload";
        let (release, digest) = release_with_asset(expected);
        let cache = temp_dir("oversized-cache-entry");
        std::fs::create_dir_all(&cache).expect("cache directory");
        let path = cache.join(digest.as_str());
        let file = std::fs::File::create(&path).expect("cache entry");
        file.set_len(64 * 1024 * 1024)
            .expect("oversized cache entry");
        drop(file);

        let error = offline_source(&release, &cache)
            .read(&digest)
            .expect_err("oversized cache miss stays offline");

        assert_eq!(error.kind(), ErrorKind::AssetUnavailable);
        assert!(!path.exists(), "the oversized cache entry is removed");
        std::fs::remove_dir_all(cache).expect("remove cache");
    }

    #[test]
    fn valid_cache_entries_are_read_offline() {
        let expected = b"release-pinned payload";
        let (release, digest) = release_with_asset(expected);
        let cache = temp_dir("valid-cache-entry");
        std::fs::create_dir_all(&cache).expect("cache directory");
        std::fs::write(cache.join(digest.as_str()), expected).expect("cache entry");

        let source = offline_source(&release, &cache);
        let bytes = source.read(&digest).expect("valid cache entry");

        assert_eq!(bytes.as_ref(), expected);
        std::fs::remove_dir_all(cache).expect("remove cache");
    }

    #[test]
    fn truncated_cache_entries_are_rejected_offline() {
        let expected = b"release-pinned payload";
        let truncated = b"short";
        let (release, digest) = release_with_asset(expected);
        let cache = temp_dir("truncated-cache-entry");
        std::fs::create_dir_all(&cache).expect("cache directory");
        let path = cache.join(digest.as_str());
        std::fs::write(&path, truncated).expect("truncated cache entry");

        let error = offline_source(&release, &cache)
            .read(&digest)
            .expect_err("truncated cache miss stays offline");

        assert_eq!(error.kind(), ErrorKind::AssetUnavailable);
        assert!(!path.exists(), "the truncated cache entry is removed");
        std::fs::remove_dir_all(cache).expect("remove cache");
    }

    #[test]
    fn same_size_cache_entries_still_require_the_pinned_digest() {
        let expected = b"pinned data";
        let corrupt = b"wrong data!";
        assert_eq!(expected.len(), corrupt.len());
        let (release, digest) = release_with_asset(expected);
        let cache = temp_dir("same-size-corrupt-cache-entry");
        std::fs::create_dir_all(&cache).expect("cache directory");
        let path = cache.join(digest.as_str());
        std::fs::write(&path, corrupt).expect("corrupt cache entry");

        let error = offline_source(&release, &cache)
            .read(&digest)
            .expect_err("digest mismatch stays offline");

        assert_eq!(error.kind(), ErrorKind::AssetUnavailable);
        assert!(!path.exists(), "the digest-mismatched entry is removed");
        std::fs::remove_dir_all(cache).expect("remove cache");
    }

    #[test]
    fn prefetch_reports_missing_release_metadata_without_panicking() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let root = temp_dir("missing-release-entry");
        generate_catalogs_from_upstream(
            &upstream_dir,
            &root,
            AssetSourceRef::new(
                "textmate-grammars-themes".to_owned(),
                Some("1.0.0".to_owned()),
                Some("abc123".to_owned()),
            ),
        )
        .expect("generate catalog fixture");

        let language_manifest = decode_language_manifest(
            &std::fs::read(root.join("languages/manifest.fkindex")).expect("language manifest"),
        )
        .expect("decode language manifest");
        let language = &language_manifest.entries[0];
        let missing_path = format!("languages/{}", language.asset_file);
        let mut release: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join(ferriki_asset_gen::RELEASE_MANIFEST_FILE))
                .expect("release manifest"),
        )
        .expect("parse release manifest");
        release["assets"]
            .as_object_mut()
            .expect("release assets")
            .remove(&missing_path)
            .expect("language release metadata");
        std::fs::write(
            root.join(ferriki_asset_gen::RELEASE_MANIFEST_FILE),
            serde_json::to_vec(&release).expect("serialize release manifest"),
        )
        .expect("write incomplete release manifest");

        let host = RemoteAssetHost::from_root(
            &root,
            &RemoteAssets::default()
                .with_remote(Some(false))
                .with_cache_dir(Some(temp_dir("missing-release-entry-cache"))),
        )
        .expect("remote host");
        let error = host
            .prefetch(std::slice::from_ref(&language.id), &[])
            .expect_err("missing release metadata should be an error");

        assert_eq!(error.kind(), ErrorKind::AssetFormat);
        assert!(error.to_string().contains(&missing_path));
        std::fs::remove_dir_all(root).expect("remove catalog fixture");
    }

    #[test]
    fn store_retries_temp_file_collisions_and_handles_rename_races() {
        let expected = b"release-pinned payload";
        let (release, digest) = release_with_asset(expected);
        let cache = temp_dir("store-hardening");
        std::fs::create_dir_all(&cache).expect("cache directory");
        let source = offline_source(&release, &cache);

        // Pre-occupy serial 0 for this nonce so create_new hits AlreadyExists and retries serial 1.
        let nonce = process_temp_nonce();
        let expected_name = temp_file_name(&digest, nonce, 0);
        assert!(expected_name.contains(&format!("-{nonce:016x}-0.tmp")));
        assert_ne!(
            temp_file_name(&digest, nonce, 0),
            temp_file_name(&digest, nonce ^ 1, 0)
        );
        let occupied = cache.join(&expected_name);
        std::fs::write(&occupied, b"pre-existing").expect("pre-existing temp file");
        let counter = AtomicU64::new(0);
        source
            .store_with_rename(&digest, expected, &counter, nonce, |from, to| {
                std::fs::rename(from, to)
            })
            .expect("retry temp collision");
        assert_eq!(counter.load(Ordering::Relaxed), 2);
        assert_eq!(std::fs::read(&occupied).unwrap(), b"pre-existing");
        assert_eq!(
            std::fs::read(cache.join(digest.as_str())).unwrap(),
            expected
        );
        std::fs::remove_file(&occupied).expect("remove occupied temp");

        // Simulate Windows sharing/access-denied rename failure while the verified
        // target is already cached: store must succeed and remove its temp file.
        let counter = AtomicU64::new(10);
        source
            .store_with_rename(&digest, expected, &counter, nonce, |_, _| {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            })
            .expect("verified target makes rename failure benign");
        let entries: Vec<_> = std::fs::read_dir(&cache)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from(digest.as_str())]);

        // If rename fails and the cached target is corrupt (or missing), store
        // must fail, clean up its temporary file, and leave the target untouched.
        std::fs::write(cache.join(digest.as_str()), b"corrupt").expect("corrupt target");
        let error = source
            .store_with_rename(&digest, expected, &counter, nonce, |_, _| {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            })
            .expect_err("corrupt target must not mask rename failure");
        assert_eq!(error.kind(), ErrorKind::AssetIo);
        assert_eq!(
            std::fs::read(cache.join(digest.as_str())).unwrap(),
            b"corrupt",
            "rename-failure verification must stay read-only and never unlink target"
        );
        assert!(
            std::fs::read_dir(&cache).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")),
            "failed store must remove its temporary file"
        );
        std::fs::remove_dir_all(cache).expect("remove cache");
    }

    #[test]
    fn remote_asset_host_rejects_invalid_catalog_filenames() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let root = temp_dir("invalid-catalog-filename");
        generate_catalogs_from_upstream(
            &upstream_dir,
            &root,
            AssetSourceRef::new(
                "textmate-grammars-themes".to_owned(),
                Some("1.0.0".to_owned()),
                Some("abc123".to_owned()),
            ),
        )
        .expect("generate catalog fixture");

        let mut language_manifest = decode_language_manifest(
            &std::fs::read(root.join("languages/manifest.fkindex")).expect("language manifest"),
        )
        .expect("decode language manifest");
        language_manifest.entries[0].asset_file = "../escape.fkgram".to_owned();
        std::fs::write(
            root.join("languages/manifest.fkindex"),
            ferriki_asset_gen::encode_language_manifest(&language_manifest)
                .expect("encode language manifest"),
        )
        .expect("write tampered language manifest");

        let error = RemoteAssetHost::from_root(
            &root,
            &RemoteAssets::default()
                .with_remote(Some(false))
                .with_cache_dir(Some(temp_dir("invalid-catalog-filename-cache"))),
        )
        .err()
        .expect("traversal filename must be rejected");
        assert_eq!(error.kind(), ErrorKind::AssetFormat);

        std::fs::remove_dir_all(root).expect("remove catalog fixture");
    }

    #[test]
    fn populated_cache_ignores_invalid_inherited_base_url_until_cache_miss() {
        let expected = b"release-pinned payload";
        let (release, digest) = release_with_asset(expected);
        let cache = temp_dir("inherited-invalid-mirror");
        std::fs::create_dir_all(&cache).expect("cache directory");
        let cached_path = cache.join(digest.as_str());
        std::fs::write(&cached_path, expected).expect("seed cache");

        let settings = RemoteAssets::default()
            .with_remote(Some(true))
            .with_cache_dir(Some(cache.clone()))
            .with_commit(Some("0123456789abcdef0123456789abcdef01234567".to_owned()))
            .resolve(
                &release,
                env(&[("FERRIKI_ASSETS_BASE_URL", "http://mirror.internal")]),
            )
            .expect("inherited mirror URL must not fail construction");
        let source = RemoteAssetSource::new(&release, settings, true).expect("remote source");

        // Cache hit succeeds without touching the mirror URL.
        assert_eq!(source.read(&digest).expect("cached hit").as_ref(), expected);

        // Cache miss rejects the invalid mirror URL before any network request.
        std::fs::remove_file(&cached_path).expect("evict cache");
        let error = source
            .read(&digest)
            .expect_err("cache miss must reject plaintext non-loopback mirror");
        assert_eq!(error.kind(), ErrorKind::AssetDownload);
        assert!(error.to_string().contains("Invalid asset base URL"));
        std::fs::remove_dir_all(cache).expect("remove cache");
    }

    #[test]
    fn remote_verified_source_hashes_once_and_prefetch_avoids_redundant_reads() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let root = temp_dir("verified-once-root");
        let cache = temp_dir("verified-once-cache");
        std::fs::create_dir_all(&cache).expect("cache directory");
        generate_catalogs_from_upstream(
            &upstream_dir,
            &root,
            AssetSourceRef::new(
                "textmate-grammars-themes".to_owned(),
                Some("1.0.0".to_owned()),
                Some("abc123".to_owned()),
            ),
        )
        .expect("generate catalog fixture");

        let release = ReleaseManifest::from_json(
            &std::fs::read_to_string(root.join(ferriki_asset_gen::RELEASE_MANIFEST_FILE))
                .expect("release manifest"),
        )
        .expect("parse release manifest");
        let js_asset = &release.assets["languages/javascript.fkgram"];
        let theme_asset = &release.assets["themes/vitesse-light.fktheme"];
        std::fs::copy(
            root.join("languages/javascript.fkgram"),
            cache.join(&js_asset.sha256),
        )
        .expect("seed js grammar");
        std::fs::copy(
            root.join("themes/vitesse-light.fktheme"),
            cache.join(&theme_asset.sha256),
        )
        .expect("seed theme");

        // Part 1: Direct catalog load without prefetch hashes each asset exactly once.
        let host_direct = RemoteAssetHost::from_root(
            &root,
            &RemoteAssets::default()
                .with_remote(Some(false))
                .with_cache_dir(Some(cache.clone())),
        )
        .expect("direct remote host");
        let direct_catalogs = host_direct.catalogs().expect("direct catalogs");
        crate::asset_source::reset_sha256_count();
        assert!(
            direct_catalogs
                .languages
                .load_asset("javascript")
                .unwrap()
                .is_some()
        );
        assert!(
            direct_catalogs
                .themes
                .load_asset("vitesse-light")
                .unwrap()
                .is_some()
        );
        assert_eq!(
            crate::asset_source::sha256_count(),
            2,
            "verified remote catalog load must hash each payload once, not twice"
        );

        // Part 2: Prefetch populates the one-shot verified handoff cache so
        // immediate catalog load performs zero extra disk reads and zero SHA-256 hashes.
        let host_prefetched = RemoteAssetHost::from_root(
            &root,
            &RemoteAssets::default()
                .with_remote(Some(false))
                .with_cache_dir(Some(cache.clone())),
        )
        .expect("prefetched remote host");
        let prefetched_catalogs = host_prefetched.catalogs().expect("prefetched catalogs");
        host_prefetched
            .prefetch(&["javascript".to_owned()], &["vitesse-light".to_owned()])
            .expect("prefetch cached assets");
        std::fs::remove_file(cache.join(&js_asset.sha256)).expect("evict js from disk");
        std::fs::remove_file(cache.join(&theme_asset.sha256)).expect("evict theme from disk");
        crate::asset_source::reset_sha256_count();
        assert!(
            prefetched_catalogs
                .languages
                .load_asset("javascript")
                .unwrap()
                .is_some()
        );
        assert!(
            prefetched_catalogs
                .themes
                .load_asset("vitesse-light")
                .unwrap()
                .is_some()
        );
        assert_eq!(
            crate::asset_source::sha256_count(),
            0,
            "catalog load after prefetch must reuse verified bytes without re-hashing"
        );

        // Part 3: Unprefetched tampered files on disk are still rejected and unlinked.
        let mut tampered = std::fs::read(root.join("themes/vitesse-light.fktheme")).unwrap();
        tampered[0] ^= 0xff;
        let tampered_path = cache.join(&theme_asset.sha256);
        std::fs::write(&tampered_path, &tampered).unwrap();
        let fresh_catalogs = host_prefetched.catalogs().expect("fresh catalogs");
        let error = fresh_catalogs
            .themes
            .load_asset("vitesse-light")
            .expect_err("tampered cache entry must be rejected");
        assert_eq!(error.kind(), ErrorKind::AssetUnavailable);
        assert!(!tampered_path.exists());

        std::fs::remove_dir_all(&cache).expect("cleanup cache");
        std::fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn failed_prefetch_discards_staged_verified_payloads() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let root = temp_dir("prefetch-fail-root");
        let cache = temp_dir("prefetch-fail-cache");
        std::fs::create_dir_all(&cache).expect("cache directory");
        generate_catalogs_from_upstream(
            &upstream_dir,
            &root,
            AssetSourceRef::new(
                "textmate-grammars-themes".to_owned(),
                Some("1.0.0".to_owned()),
                Some("abc123".to_owned()),
            ),
        )
        .expect("generate catalog fixture");

        let release = ReleaseManifest::from_json(
            &std::fs::read_to_string(root.join(ferriki_asset_gen::RELEASE_MANIFEST_FILE))
                .expect("release manifest"),
        )
        .expect("parse release manifest");
        // Seed only javascript; leave vitesse-light uncached so offline prefetch fails.
        let js_asset = &release.assets["languages/javascript.fkgram"];
        std::fs::copy(
            root.join("languages/javascript.fkgram"),
            cache.join(&js_asset.sha256),
        )
        .expect("seed js grammar");

        let host = RemoteAssetHost::from_root(
            &root,
            &RemoteAssets::default()
                .with_remote(Some(false))
                .with_cache_dir(Some(cache.clone())),
        )
        .expect("remote host");
        let error = host
            .prefetch(&["javascript".to_owned()], &["vitesse-light".to_owned()])
            .expect_err("missing required theme must fail prefetch");
        assert_eq!(error.kind(), ErrorKind::AssetUnavailable);
        assert_eq!(
            host.source.verified_cache_stats(),
            (0, 0),
            "failed prefetch must not leave verified payloads staged in the shared cache"
        );

        std::fs::remove_dir_all(&cache).expect("cleanup cache");
        std::fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn clear_verified_cache_releases_unused_prefetched_payloads() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let root = temp_dir("clear-verified-root");
        let cache = temp_dir("clear-verified-cache");
        std::fs::create_dir_all(&cache).expect("cache directory");
        generate_catalogs_from_upstream(
            &upstream_dir,
            &root,
            AssetSourceRef::new(
                "textmate-grammars-themes".to_owned(),
                Some("1.0.0".to_owned()),
                Some("abc123".to_owned()),
            ),
        )
        .expect("generate catalog fixture");

        let release = ReleaseManifest::from_json(
            &std::fs::read_to_string(root.join(ferriki_asset_gen::RELEASE_MANIFEST_FILE))
                .expect("release manifest"),
        )
        .expect("parse release manifest");
        let js_asset = &release.assets["languages/javascript.fkgram"];
        let theme_asset = &release.assets["themes/vitesse-light.fktheme"];
        std::fs::copy(
            root.join("languages/javascript.fkgram"),
            cache.join(&js_asset.sha256),
        )
        .expect("seed js grammar");
        std::fs::copy(
            root.join("themes/vitesse-light.fktheme"),
            cache.join(&theme_asset.sha256),
        )
        .expect("seed theme");

        let host = RemoteAssetHost::from_root(
            &root,
            &RemoteAssets::default()
                .with_remote(Some(false))
                .with_cache_dir(Some(cache.clone())),
        )
        .expect("remote host");
        host.prefetch(&["javascript".to_owned()], &["vitesse-light".to_owned()])
            .expect("prefetch cached assets");
        let (entries, bytes) = host.source.verified_cache_stats();
        assert_eq!(entries, 2);
        assert!(bytes > 0);

        host.clear_verified_cache();
        assert_eq!(host.source.verified_cache_stats(), (0, 0));

        std::fs::remove_dir_all(&cache).expect("cleanup cache");
        std::fs::remove_dir_all(&root).expect("cleanup root");
    }
}
