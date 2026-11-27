//! Content-addressed asset sources. Verification belongs to the catalog, so
//! custom sources cannot accidentally bypass the release integrity contract.

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use ferriki_asset_gen::FORMAT_VERSION;
use sha2::{Digest, Sha256};

use crate::{Error, ErrorKind, Result};

const MAX_DIRECTORY_ASSET_BYTES: u64 = 64 * 1024 * 1024;

/// A normalized SHA-256 digest; safe to use as a cache filename.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AssetDigest(String);

impl AssetDigest {
    pub fn of(bytes: &[u8]) -> Self {
        Self(sha256_hex(bytes))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
std::thread_local! {
    static SHA256_HASH_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_sha256_count() {
    SHA256_HASH_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn sha256_count() -> usize {
    SHA256_HASH_COUNT.with(std::cell::Cell::get)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    #[cfg(test)]
    SHA256_HASH_COUNT.with(|count| count.set(count.get() + 1));
    const HEX: &[u8; 16] = b"0123456789abcdef";
    Sha256::digest(bytes)
        .into_iter()
        .flat_map(|byte| [HEX[usize::from(byte >> 4)], HEX[usize::from(byte & 15)]])
        .map(char::from)
        .collect()
}

impl FromStr for AssetDigest {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(Error::new(
                ErrorKind::AssetFormat,
                "An asset digest must contain 64 hexadecimal SHA-256 digits.",
            ));
        }
        Ok(Self(value.to_ascii_lowercase()))
    }
}

/// Release-pinned integrity information for one payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetMetadata {
    digest: AssetDigest,
    size: u64,
    format_version: u32,
    decoded: Option<Box<AssetMetadata>>,
}

impl AssetMetadata {
    pub fn new(digest: AssetDigest, size: u64, format_version: u32) -> Self {
        Self {
            digest,
            size,
            format_version,
            decoded: None,
        }
    }

    pub(crate) fn from_release_asset(asset: &ferriki_asset_gen::ReleaseAsset) -> Result<Self> {
        let mut metadata = Self::new(asset.sha256.parse()?, asset.size, asset.format_version);
        metadata.decoded = asset
            .decoded
            .as_ref()
            .map(|decoded| {
                Ok(Box::new(Self::new(
                    decoded.sha256.parse()?,
                    decoded.size,
                    asset.format_version,
                )))
            })
            .transpose()?;
        Ok(metadata)
    }

    pub(crate) fn decoded(&self) -> Option<&Self> {
        self.decoded.as_deref()
    }

    pub fn digest(&self) -> &AssetDigest {
        &self.digest
    }
    pub fn size(&self) -> u64 {
        self.size
    }
    pub fn format_version(&self) -> u32 {
        self.format_version
    }

    pub(crate) fn validate_format(&self) -> Result<()> {
        if self.format_version != FORMAT_VERSION {
            return Err(Error::new(
                ErrorKind::AssetFormat,
                format!(
                    "Unsupported asset format {}; expected {FORMAT_VERSION}.",
                    self.format_version
                ),
            ));
        }
        Ok(())
    }

    pub(crate) fn verify_bytes(&self, bytes: &[u8]) -> Result<()> {
        if bytes.len() as u64 != self.size || AssetDigest::of(bytes) != self.digest {
            return Err(Error::new(
                ErrorKind::AssetIntegrity,
                format!(
                    "Asset {} failed its SHA-256 or byte-size check.",
                    self.digest.as_str()
                ),
            ));
        }
        Ok(())
    }
}

/// Supplies immutable asset bytes by digest. Sources may perform synchronous
/// I/O while explicitly loading assets; they must not implement retries here.
/// Catalogs verify returned bytes before decoding or retaining them.
pub trait AssetSource: Send + Sync {
    fn read(&self, digest: &AssetDigest) -> Result<Cow<'_, [u8]>>;

    /// Reads immutable asset bytes bounded by the manifest-pinned `expected_size`.
    ///
    /// The default implementation delegates to [`Self::read`] and verifies the
    /// returned byte length matches `expected_size`; sources backed by external
    /// files can override it to reject mismatched sizes before allocating.
    fn read_bounded(&self, digest: &AssetDigest, expected_size: u64) -> Result<Cow<'_, [u8]>> {
        let bytes = self.read(digest)?;
        if bytes.len() as u64 != expected_size {
            return Err(Error::new(
                ErrorKind::AssetIntegrity,
                format!(
                    "Asset {} failed its SHA-256 or byte-size check.",
                    digest.as_str()
                ),
            ));
        }
        Ok(bytes)
    }
}

/// Proof-carrying payload whose byte length and SHA-256 digest were verified in
/// this process against the pinned release digest and size.
///
/// Fields stay private so no internal source can bypass SHA-256 verification.
pub(crate) struct VerifiedBytes {
    bytes: Vec<u8>,
    digest: AssetDigest,
}

impl VerifiedBytes {
    pub(crate) fn verify(
        bytes: Vec<u8>,
        expected_digest: &AssetDigest,
        expected_size: u64,
    ) -> Result<Self> {
        if bytes.len() as u64 != expected_size || AssetDigest::of(&bytes) != *expected_digest {
            return Err(Error::new(
                ErrorKind::AssetIntegrity,
                format!(
                    "Asset {} failed its SHA-256 or byte-size check.",
                    expected_digest.as_str()
                ),
            ));
        }
        Ok(Self {
            bytes,
            digest: expected_digest.clone(),
        })
    }

    #[cfg(any(test, all(feature = "remote", not(target_arch = "wasm32"))))]
    pub(crate) fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    pub(crate) fn digest(&self) -> &AssetDigest {
        &self.digest
    }

    pub(crate) fn len(&self) -> usize {
        self.bytes.len()
    }

    pub(crate) fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

/// Crate-internal source returning proof-carrying [`VerifiedBytes`] so catalogs
/// avoid re-hashing the exact same in-memory buffer while external
/// [`AssetSource`] implementations retain unconditional catalog verification.
pub(crate) trait InternalVerifiedSource: Send + Sync {
    fn read_verified(&self, digest: &AssetDigest, expected_size: u64) -> Result<VerifiedBytes>;
}

const MAX_VERIFIED_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_VERIFIED_CACHE_ENTRIES: usize = 256;

/// Bounded one-shot handoff cache between planning/prefetch and immediate
/// catalog decoding. Entries are consumed on `take` and bounded in both entry
/// count and total bytes so unused entries never leak memory.
pub(crate) struct VerifiedPayloadCache {
    entries: HashMap<AssetDigest, (VerifiedBytes, u64)>,
    order: VecDeque<(AssetDigest, u64)>,
    next_generation: u64,
    total_bytes: usize,
    max_bytes: usize,
    max_entries: usize,
    closed: bool,
}

impl Default for VerifiedPayloadCache {
    fn default() -> Self {
        Self::new()
    }
}

impl VerifiedPayloadCache {
    pub(crate) fn new() -> Self {
        Self::with_limits(MAX_VERIFIED_CACHE_BYTES, MAX_VERIFIED_CACHE_ENTRIES)
    }

    pub(crate) fn with_limits(max_bytes: usize, max_entries: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            next_generation: 0,
            total_bytes: 0,
            max_bytes,
            max_entries,
            closed: false,
        }
    }

    pub(crate) fn insert(&mut self, payload: VerifiedBytes) {
        let len = payload.len();
        if self.closed || len > self.max_bytes || self.max_entries == 0 {
            return;
        }
        let digest = payload.digest().clone();
        if let Some((previous, _)) = self.entries.remove(&digest) {
            self.total_bytes = self.total_bytes.saturating_sub(previous.len());
        }
        while self.entries.len() >= self.max_entries
            || self.total_bytes.saturating_add(len) > self.max_bytes
        {
            let Some((oldest, generation)) = self.order.pop_front() else {
                break;
            };
            if self
                .entries
                .get(&oldest)
                .is_some_and(|(_, live_generation)| *live_generation == generation)
                && let Some((evicted, _)) = self.entries.remove(&oldest)
            {
                self.total_bytes = self.total_bytes.saturating_sub(evicted.len());
            }
        }
        // Keep the FIFO queue bounded even if entries were replaced or taken.
        if self.order.len() > self.max_entries.saturating_mul(2) {
            self.order.retain(|(key, generation)| {
                self.entries
                    .get(key)
                    .is_some_and(|(_, live_generation)| *live_generation == *generation)
            });
        }
        let generation = self.next_generation;
        self.next_generation = self.next_generation.wrapping_add(1);
        self.total_bytes = self.total_bytes.saturating_add(len);
        self.entries.insert(digest.clone(), (payload, generation));
        self.order.push_back((digest, generation));
    }

    pub(crate) fn take(&mut self, digest: &AssetDigest) -> Option<VerifiedBytes> {
        let (payload, _) = self.entries.remove(digest)?;
        self.total_bytes = self.total_bytes.saturating_sub(payload.len());
        Some(payload)
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.total_bytes = 0;
    }

    /// Permanently empties and closes the cache so in-flight background
    /// planners cannot refill it after disposal.
    pub(crate) fn close(&mut self) {
        self.closed = true;
        self.clear();
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Consumes this bounded cache and returns its live payloads in FIFO order.
    pub(crate) fn into_payloads(mut self) -> Vec<VerifiedBytes> {
        let mut payloads = Vec::with_capacity(self.entries.len());
        while let Some((digest, generation)) = self.order.pop_front() {
            if self
                .entries
                .get(&digest)
                .is_some_and(|(_, live_generation)| *live_generation == generation)
                && let Some((payload, _)) = self.entries.remove(&digest)
            {
                payloads.push(payload);
            }
        }
        payloads
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    pub(crate) fn total_bytes(&self) -> usize {
        self.total_bytes
    }
}

/// Synchronized wrapper around [`VerifiedPayloadCache`] with a lock-free
/// `is_empty()` fast path for hot paths that do not hold staged payloads.
pub(crate) struct SharedVerifiedPayloadCache {
    count: AtomicUsize,
    inner: Mutex<VerifiedPayloadCache>,
}

impl SharedVerifiedPayloadCache {
    pub(crate) fn new() -> Self {
        Self {
            count: AtomicUsize::new(0),
            inner: Mutex::new(VerifiedPayloadCache::new()),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.count.load(Ordering::Acquire) == 0
    }

    pub(crate) fn insert_batch(&self, payloads: impl IntoIterator<Item = VerifiedBytes>) {
        if let Ok(mut cache) = self.inner.lock() {
            for payload in payloads {
                cache.insert(payload);
            }
            self.count.store(cache.entries.len(), Ordering::Release);
        }
    }

    pub(crate) fn take(&self, digest: &AssetDigest) -> Option<VerifiedBytes> {
        if self.is_empty() {
            return None;
        }
        let mut cache = self.inner.lock().ok()?;
        let taken = cache.take(digest);
        self.count.store(cache.entries.len(), Ordering::Release);
        taken
    }

    pub(crate) fn take_many(&self, digests: &[AssetDigest]) {
        if digests.is_empty() || self.is_empty() {
            return;
        }
        if let Ok(mut cache) = self.inner.lock() {
            for digest in digests {
                let _ = cache.take(digest);
            }
            self.count.store(cache.entries.len(), Ordering::Release);
        }
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut cache) = self.inner.lock() {
            cache.clear();
            self.count.store(0, Ordering::Release);
        }
    }

    pub(crate) fn close(&self) {
        if let Ok(mut cache) = self.inner.lock() {
            cache.close();
            self.count.store(0, Ordering::Release);
        }
    }

    #[cfg(test)]
    pub(crate) fn stats(&self) -> (usize, usize) {
        let cache = self.inner.lock().expect("verified cache lock");
        (cache.len(), cache.total_bytes())
    }
}

pub(crate) fn open_nonblocking(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    options.open(path)
}

/// Reads a digest-addressed directory, such as a pre-populated offline cache.
#[derive(Clone, Debug)]
pub struct DirectoryAssetSource {
    root: PathBuf,
}

impl DirectoryAssetSource {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn read_with_limit(
        &self,
        digest: &AssetDigest,
        expected_size: Option<u64>,
    ) -> Result<Cow<'_, [u8]>> {
        let io = |source: std::io::Error| {
            let kind = if source.kind() == std::io::ErrorKind::NotFound {
                ErrorKind::AssetUnavailable
            } else {
                ErrorKind::AssetIo
            };
            Error::new(
                kind,
                format!(
                    "Cannot read asset {} from {}. Pre-populate the cache or provide an embedded asset source.",
                    digest.as_str(),
                    self.root.display()
                ),
            )
            .with_source(source)
        };
        let integrity = |detail: String| Error::new(ErrorKind::AssetIntegrity, detail);
        let file = open_nonblocking(&self.root.join(digest.as_str())).map_err(io)?;
        let metadata = file.metadata().map_err(io)?;
        if !metadata.is_file() {
            return Err(Error::new(
                ErrorKind::AssetIo,
                format!(
                    "Cannot read asset {} from {}: expected a regular file.",
                    digest.as_str(),
                    self.root.display()
                ),
            ));
        }
        let len = metadata.len();
        let limit = match expected_size {
            Some(expected) => {
                if len != expected {
                    return Err(integrity(format!(
                        "Asset {} failed its SHA-256 or byte-size check.",
                        digest.as_str()
                    )));
                }
                expected
            }
            None => {
                if len > MAX_DIRECTORY_ASSET_BYTES {
                    return Err(integrity(format!(
                        "Asset {} in {} exceeds the maximum allowed byte size ({MAX_DIRECTORY_ASSET_BYTES}).",
                        digest.as_str(),
                        self.root.display()
                    )));
                }
                MAX_DIRECTORY_ASSET_BYTES
            }
        };
        let capacity = usize::try_from(len).map_err(|_| {
            integrity(format!(
                "Asset {} in {} exceeds the maximum allowed byte size.",
                digest.as_str(),
                self.root.display()
            ))
        })?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(capacity).map_err(|source| {
            Error::new(
                ErrorKind::AssetIo,
                format!(
                    "Cannot allocate asset {} from {}.",
                    digest.as_str(),
                    self.root.display()
                ),
            )
            .with_source(source)
        })?;
        file.take(limit.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(io)?;
        match expected_size {
            Some(expected) if bytes.len() as u64 != expected => {
                return Err(integrity(format!(
                    "Asset {} failed its SHA-256 or byte-size check.",
                    digest.as_str()
                )));
            }
            None if bytes.len() as u64 > MAX_DIRECTORY_ASSET_BYTES => {
                return Err(integrity(format!(
                    "Asset {} in {} exceeds the maximum allowed byte size ({MAX_DIRECTORY_ASSET_BYTES}).",
                    digest.as_str(),
                    self.root.display()
                )));
            }
            _ => {}
        }
        Ok(Cow::Owned(bytes))
    }
}

impl AssetSource for DirectoryAssetSource {
    fn read(&self, digest: &AssetDigest) -> Result<Cow<'_, [u8]>> {
        self.read_with_limit(digest, None)
    }

    fn read_bounded(&self, digest: &AssetDigest, expected_size: u64) -> Result<Cow<'_, [u8]>> {
        self.read_with_limit(digest, Some(expected_size))
    }
}

/// Borrowed or owned offline payloads, deduplicated by digest.
#[derive(Clone, Default)]
pub struct EmbeddedAssetSource {
    assets: HashMap<AssetDigest, Cow<'static, [u8]>>,
}

impl std::fmt::Debug for EmbeddedAssetSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmbeddedAssetSource")
            .field("assets", &self.assets.len())
            .finish()
    }
}

impl EmbeddedAssetSource {
    pub fn new(assets: impl IntoIterator<Item = (AssetDigest, Cow<'static, [u8]>)>) -> Self {
        Self {
            assets: assets.into_iter().collect(),
        }
    }
}

impl AssetSource for EmbeddedAssetSource {
    fn read(&self, digest: &AssetDigest) -> Result<Cow<'_, [u8]>> {
        self.assets.get(digest).map(|bytes| Cow::Borrowed(bytes.as_ref())).ok_or_else(|| {
            Error::new(ErrorKind::AssetUnavailable, format!(
                "Asset {} is unavailable offline. Provide embedded bytes or a pre-populated cache.", digest.as_str()
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoded_metadata_authenticates_persisted_bytes() {
        let bytes = b"decoded";
        let mut asset = serde_json::json!({
            "sha256": AssetDigest::of(b"transport").as_str(), "size": 9, "formatVersion": 1,
            "decoded": { "sha256": AssetDigest::of(bytes).as_str(), "size": bytes.len() }
        });
        let metadata =
            AssetMetadata::from_release_asset(&serde_json::from_value(asset.clone()).unwrap())
                .unwrap();
        let decoded = metadata.decoded().unwrap();
        assert!(decoded.verify_bytes(bytes).is_ok());
        assert_eq!(
            decoded.verify_bytes(b"changed").unwrap_err().kind(),
            ErrorKind::AssetIntegrity
        );
        asset["decoded"]["sha256"] = "invalid".into();
        assert_eq!(
            AssetMetadata::from_release_asset(&serde_json::from_value(asset).unwrap())
                .unwrap_err()
                .kind(),
            ErrorKind::AssetFormat
        );
    }

    #[test]
    fn directory_asset_source_rejects_non_files_and_oversized_entries() {
        let root = std::env::temp_dir().join(format!(
            "ferriki-dir-asset-source-hardening-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let source = DirectoryAssetSource::new(&root);

        let valid_digest = AssetDigest::of(b"ok");
        std::fs::write(root.join(valid_digest.as_str()), b"ok").unwrap();
        assert_eq!(source.read(&valid_digest).unwrap().as_ref(), b"ok");
        assert_eq!(
            source.read_bounded(&valid_digest, 2).unwrap().as_ref(),
            b"ok"
        );
        assert_eq!(
            source.read_bounded(&valid_digest, 1).unwrap_err().kind(),
            ErrorKind::AssetIntegrity
        );
        assert_eq!(
            source.read_bounded(&valid_digest, 3).unwrap_err().kind(),
            ErrorKind::AssetIntegrity
        );

        let missing_digest = AssetDigest::of(b"missing");
        assert_eq!(
            source.read(&missing_digest).unwrap_err().kind(),
            ErrorKind::AssetUnavailable
        );

        let dir_digest = AssetDigest::of(b"directory");
        std::fs::create_dir(root.join(dir_digest.as_str())).unwrap();
        assert_eq!(
            source.read(&dir_digest).unwrap_err().kind(),
            ErrorKind::AssetIo
        );

        let oversized_digest = AssetDigest::of(b"oversized");
        let sparse = std::fs::File::create(root.join(oversized_digest.as_str())).unwrap();
        sparse.set_len(MAX_DIRECTORY_ASSET_BYTES + 1).unwrap();
        drop(sparse);
        assert_eq!(
            source.read(&oversized_digest).unwrap_err().kind(),
            ErrorKind::AssetIntegrity
        );
        assert_eq!(
            source
                .read_bounded(&oversized_digest, 16)
                .unwrap_err()
                .kind(),
            ErrorKind::AssetIntegrity
        );

        #[cfg(unix)]
        {
            let fifo_digest = AssetDigest::of(b"fifo");
            let fifo_path = root.join(fifo_digest.as_str());
            let status = std::process::Command::new("mkfifo")
                .arg(&fifo_path)
                .status()
                .expect("mkfifo");
            assert!(status.success(), "mkfifo should create a named pipe");
            assert_eq!(
                source.read(&fifo_digest).unwrap_err().kind(),
                ErrorKind::AssetIo
            );
            assert_eq!(
                source.read_bounded(&fifo_digest, 0).unwrap_err().kind(),
                ErrorKind::AssetIo
            );
        }

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn default_read_bounded_enforces_expected_size() {
        let payload: &'static [u8] = b"embedded payload";
        let digest = AssetDigest::of(payload);
        let source = EmbeddedAssetSource::new([(digest.clone(), Cow::Borrowed(payload))]);

        assert_eq!(
            source
                .read_bounded(&digest, payload.len() as u64)
                .unwrap()
                .as_ref(),
            payload
        );
        for wrong in [payload.len() as u64 - 1, payload.len() as u64 + 1] {
            assert_eq!(
                source.read_bounded(&digest, wrong).unwrap_err().kind(),
                ErrorKind::AssetIntegrity
            );
        }
    }

    #[test]
    fn verified_payload_cache_bounds_memory_consumes_on_take_and_rejects_oversized() {
        let a_bytes = b"aaaa".to_vec();
        let b_bytes = b"bbbb".to_vec();
        let c_bytes = b"cccc".to_vec();
        let a_digest = AssetDigest::of(&a_bytes);
        let b_digest = AssetDigest::of(&b_bytes);
        let c_digest = AssetDigest::of(&c_bytes);

        // Tampered bytes or mismatched lengths must fail verification.
        assert_eq!(
            VerifiedBytes::verify(b"xxxx".to_vec(), &a_digest, 4)
                .err()
                .expect("tampered payload must fail")
                .kind(),
            ErrorKind::AssetIntegrity
        );
        assert_eq!(
            VerifiedBytes::verify(a_bytes.clone(), &a_digest, 5)
                .err()
                .expect("wrong size must fail")
                .kind(),
            ErrorKind::AssetIntegrity
        );

        let mut cache = VerifiedPayloadCache::with_limits(8, 2);
        cache.insert(VerifiedBytes::verify(a_bytes.clone(), &a_digest, 4).unwrap());
        cache.insert(VerifiedBytes::verify(b_bytes.clone(), &b_digest, 4).unwrap());
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.total_bytes(), 8);

        // Inserting a third 4-byte entry evicts the oldest (`a`) to stay within limits.
        cache.insert(VerifiedBytes::verify(c_bytes.clone(), &c_digest, 4).unwrap());
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.total_bytes(), 8);
        assert!(cache.take(&a_digest).is_none());

        // `take` consumes the entry once and decrements tracked bytes.
        let taken = cache.take(&b_digest).expect("cached b");
        assert_eq!(taken.as_slice(), b_bytes.as_slice());
        assert!(cache.take(&b_digest).is_none());
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.total_bytes(), 4);

        // Oversized payloads exceeding max_bytes are not retained.
        let huge = vec![0_u8; 16];
        let huge_digest = AssetDigest::of(&huge);
        cache.insert(VerifiedBytes::verify(huge, &huge_digest, 16).unwrap());
        assert!(cache.take(&huge_digest).is_none());
        assert_eq!(cache.len(), 1);

        cache.clear();
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.total_bytes(), 0);
    }

    #[test]
    fn verified_payload_cache_close_clears_and_discards_later_inserts() {
        let a_bytes = b"aaaa".to_vec();
        let b_bytes = b"bbbb".to_vec();
        let a_digest = AssetDigest::of(&a_bytes);
        let b_digest = AssetDigest::of(&b_bytes);

        let mut cache = VerifiedPayloadCache::with_limits(16, 4);
        cache.insert(VerifiedBytes::verify(a_bytes, &a_digest, 4).unwrap());
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.total_bytes(), 4);

        cache.close();
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.total_bytes(), 0);
        assert!(cache.take(&a_digest).is_none());

        // Late inserts (e.g. from an in-flight background planner) must be discarded.
        cache.insert(VerifiedBytes::verify(b_bytes, &b_digest, 4).unwrap());
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.total_bytes(), 0);
        assert!(cache.take(&b_digest).is_none());
    }

    #[test]
    fn verified_payload_cache_stale_fifo_entries_do_not_evict_reinserted_digests() {
        let a_bytes = b"aaaa".to_vec();
        let b_bytes = b"bbbb".to_vec();
        let c_bytes = b"cccc".to_vec();
        let a_digest = AssetDigest::of(&a_bytes);
        let b_digest = AssetDigest::of(&b_bytes);
        let c_digest = AssetDigest::of(&c_bytes);

        // 2-entry cache: insert A, take A, insert B, re-insert A, insert C.
        // The stale queue slot for the first A must be skipped so B is evicted
        // and the newly inserted A remains cached alongside C.
        let mut cache = VerifiedPayloadCache::with_limits(8, 2);
        cache.insert(VerifiedBytes::verify(a_bytes.clone(), &a_digest, 4).unwrap());
        assert!(cache.take(&a_digest).is_some());
        cache.insert(VerifiedBytes::verify(b_bytes, &b_digest, 4).unwrap());
        cache.insert(VerifiedBytes::verify(a_bytes.clone(), &a_digest, 4).unwrap());
        cache.insert(VerifiedBytes::verify(c_bytes.clone(), &c_digest, 4).unwrap());

        assert_eq!(cache.len(), 2);
        assert_eq!(cache.total_bytes(), 8);
        assert!(
            cache.take(&b_digest).is_none(),
            "B should have been evicted"
        );
        assert_eq!(
            cache
                .take(&a_digest)
                .expect("reinserted A must stay cached")
                .as_slice(),
            a_bytes.as_slice()
        );
        assert_eq!(
            cache
                .take(&c_digest)
                .expect("C must stay cached")
                .as_slice(),
            c_bytes.as_slice()
        );
    }

    #[test]
    fn verified_payload_cache_into_payloads_preserves_bounded_fifo_order() {
        let a_bytes = b"aaaa".to_vec();
        let b_bytes = b"bbbb".to_vec();
        let c_bytes = b"cccc".to_vec();
        let a_digest = AssetDigest::of(&a_bytes);
        let b_digest = AssetDigest::of(&b_bytes);
        let c_digest = AssetDigest::of(&c_bytes);

        let mut staged = VerifiedPayloadCache::with_limits(8, 2);
        staged.insert(VerifiedBytes::verify(a_bytes, &a_digest, 4).unwrap());
        staged.insert(VerifiedBytes::verify(b_bytes.clone(), &b_digest, 4).unwrap());
        staged.insert(VerifiedBytes::verify(c_bytes.clone(), &c_digest, 4).unwrap());
        assert_eq!(staged.len(), 2);
        assert_eq!(staged.total_bytes(), 8);

        let drained: Vec<Vec<u8>> = staged
            .into_payloads()
            .into_iter()
            .map(VerifiedBytes::into_bytes)
            .collect();
        assert_eq!(drained, vec![b_bytes, c_bytes]);
    }
}
