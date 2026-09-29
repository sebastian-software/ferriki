//! Content-addressed asset sources. Verification belongs to the catalog, so
//! custom sources cannot accidentally bypass the release integrity contract.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use ferriki_asset_gen::FORMAT_VERSION;
use sha2::{Digest, Sha256};

use crate::{Error, ErrorKind, Result};

/// A normalized SHA-256 digest; safe to use as a cache filename.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AssetDigest(String);

impl AssetDigest {
    pub fn of(bytes: &[u8]) -> Self {
        Self(format!("{:x}", Sha256::digest(bytes)))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
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
}

impl AssetMetadata {
    pub fn new(digest: AssetDigest, size: u64, format_version: u32) -> Self {
        Self {
            digest,
            size,
            format_version,
        }
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

    pub(crate) fn verify(&self, bytes: &[u8]) -> Result<()> {
        self.validate_format()?;
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
}

impl AssetSource for DirectoryAssetSource {
    fn read(&self, digest: &AssetDigest) -> Result<Cow<'_, [u8]>> {
        std::fs::read(self.root.join(digest.as_str())).map(Cow::Owned).map_err(|source| {
            let kind = if source.kind() == std::io::ErrorKind::NotFound {
                ErrorKind::AssetUnavailable
            } else { ErrorKind::AssetIo };
            Error::new(kind, format!("Cannot read asset {} from {}. Pre-populate the cache or provide an embedded asset source.", digest.as_str(), self.root.display())).with_source(source)
        })
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
