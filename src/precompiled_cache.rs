//! Persist decoded prepared containers and reuse their verified local file state.
//! SHA-256 authenticates cache fills and changed files, not unchanged restarts.

use std::fs::{self, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::{AssetMetadata, Error, ErrorKind, Result};

const MAX_DECODED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_STAMP_BYTES: u64 = 1024;
static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

fn path(root: &Path, metadata: &AssetMetadata) -> PathBuf {
    root.join("decoded").join(metadata.digest().as_str())
}

fn stamp_path(path: &Path) -> PathBuf {
    path.with_extension("verified")
}

/// A change detector for a trusted local cache, not an authentication boundary.
/// Size and modification time remain portable across restored build caches.
#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
struct FileStamp {
    size: u64,
    modified_secs: u64,
    modified_nanos: u32,
}

impl FileStamp {
    fn of(metadata: &Metadata) -> Option<Self> {
        let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        Some(Self {
            size: metadata.len(),
            modified_secs: modified.as_secs(),
            modified_nanos: modified.subsec_nanos(),
        })
    }
}

fn read_stamp(path: &Path) -> Option<FileStamp> {
    let file = fs::File::open(stamp_path(path)).ok()?;
    if file.metadata().ok()?.len() > MAX_STAMP_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_STAMP_BYTES).read_to_end(&mut bytes).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_stamp(path: &Path, stamp: &FileStamp) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(stamp).map_err(std::io::Error::other)?;
    write_atomic(&stamp_path(path), &bytes)
}

/// Planning only checks availability. Actual reads check the recorded file state.
pub(crate) fn available(root: &Path, metadata: &AssetMetadata) -> bool {
    metadata.decoded().is_some_and(|decoded| {
        decoded.size() <= MAX_DECODED_BYTES
            && fs::metadata(path(root, decoded))
                .is_ok_and(|file| file.is_file() && file.len() == decoded.size())
    })
}

pub(crate) fn read(root: &Path, decoded: &AssetMetadata) -> Option<Vec<u8>> {
    if decoded.size() > MAX_DECODED_BYTES {
        return None;
    }
    let path = path(root, decoded);
    let mut file = fs::File::open(&path).ok()?;
    let metadata = file.metadata().ok()?;
    if metadata.is_file() && metadata.len() == decoded.size() {
        let before = FileStamp::of(&metadata);
        let verified = before.is_some() && read_stamp(&path).as_ref() == before.as_ref();
        let mut bytes = Vec::with_capacity(usize::try_from(decoded.size()).ok()?);
        if (&mut file)
            .take(decoded.size())
            .read_to_end(&mut bytes)
            .is_ok()
            && bytes.len() as u64 == decoded.size()
        {
            let after = file
                .metadata()
                .ok()
                .and_then(|metadata| FileStamp::of(&metadata));
            // Use the stamp only when the open file stayed unchanged throughout
            // the read. Missing/unsupported stamps keep full verification.
            let unchanged = before.is_some() && before == after;
            if (verified && unchanged) || decoded.verify_bytes(&bytes).is_ok() {
                if !verified
                    && unchanged
                    && let Some(stamp) = after
                {
                    let _ = write_stamp(&path, &stamp);
                }
                return Some(bytes);
            }
        }
    }
    drop(file);
    // Only derived artifacts are discarded; the original download remains usable.
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(stamp_path(&path));
    None
}

pub(crate) fn prepare(root: &Path, decoded: &AssetMetadata, compressed: &[u8]) -> Result<Vec<u8>> {
    if decoded.size() > MAX_DECODED_BYTES {
        return Err(Error::new(
            ErrorKind::AssetFormat,
            "Excessive decoded prepared asset size.",
        ));
    }
    let bytes = ferriki_textmate::decompress_precompiled_patterns(compressed).map_err(|error| {
        Error::new(
            ErrorKind::AssetFormat,
            "Cannot decompress a prepared asset.",
        )
        .with_source(error)
    })?;
    decoded.verify_bytes(&bytes)?;
    // A read-only or full cache must not make the optional optimization required.
    let _ = write(root, decoded, &bytes);
    Ok(bytes)
}

fn write(root: &Path, metadata: &AssetMetadata, bytes: &[u8]) -> std::io::Result<()> {
    let target = path(root, metadata);
    write_atomic(&target, bytes)?;
    if let Some(stamp) = FileStamp::of(&fs::metadata(&target)?) {
        write_stamp(&target, &stamp)?;
    }
    Ok(())
}

fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let directory = target.parent().expect("decoded cache has a parent");
    fs::create_dir_all(directory)?;
    // Relaxed ordering suffices for a unique filename; no data is published by this counter.
    let serial = NEXT_WRITE.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(
        ".{}.{}.{serial}.tmp",
        target
            .file_name()
            .expect("cache file has a name")
            .to_string_lossy(),
        std::process::id()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        drop(file);
        fs::rename(&temporary, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn fixture() -> (PathBuf, AssetMetadata, Vec<u8>) {
        let serial = NEXT_WRITE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "ferriki-stat-cache-{}-{serial}",
            std::process::id()
        ));
        let bytes = b"verified local bytes".to_vec();
        let metadata = AssetMetadata::new(crate::AssetDigest::of(&bytes), bytes.len() as u64, 1);
        write(&root, &metadata, &bytes).unwrap();
        (root, metadata, bytes)
    }

    #[test]
    fn unchanged_file_reuses_its_stamp_and_missing_or_invalid_stamps_are_rebuilt() {
        let (root, metadata, bytes) = fixture();
        let target = path(&root, &metadata);
        let stamp = stamp_path(&target);
        let original_stamp = fs::read(&stamp).unwrap();
        assert_eq!(read(&root, &metadata), Some(bytes.clone()));
        assert_eq!(fs::read(&stamp).unwrap(), original_stamp);
        fs::remove_file(&stamp).unwrap();
        assert_eq!(read(&root, &metadata), Some(bytes.clone()));
        assert_eq!(fs::read(&stamp).unwrap(), original_stamp);
        for invalid in [
            b"invalid".to_vec(),
            vec![b' '; MAX_STAMP_BYTES as usize + 1],
        ] {
            fs::write(&stamp, invalid).unwrap();
            assert_eq!(read(&root, &metadata), Some(bytes.clone()));
            assert_eq!(fs::read(&stamp).unwrap(), original_stamp);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changed_valid_file_is_reverified_and_same_size_corruption_is_removed() {
        let (root, metadata, bytes) = fixture();
        let target = path(&root, &metadata);
        let old_stamp = read_stamp(&target).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&target).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(60))
            .unwrap();
        assert_ne!(FileStamp::of(&file.metadata().unwrap()).unwrap(), old_stamp);
        assert_eq!(read(&root, &metadata), Some(bytes.clone()));
        let refreshed = read_stamp(&target).unwrap();
        assert_ne!(refreshed, old_stamp);
        assert_eq!(
            Some(refreshed),
            FileStamp::of(&fs::metadata(&target).unwrap())
        );
        let mut damaged = bytes;
        damaged[0] ^= 1;
        fs::write(&target, damaged).unwrap();
        // Make this deterministic even on filesystems with coarse timestamps.
        file.set_modified(SystemTime::now() - Duration::from_secs(120))
            .unwrap();
        assert!(read(&root, &metadata).is_none());
        assert!(!target.exists());
        assert!(!stamp_path(&target).exists());
        drop(file);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copied_cache_with_preserved_mtime_reuses_verification() {
        let (root, metadata, bytes) = fixture();
        let target = path(&root, &metadata);
        let modified = fs::metadata(&target).unwrap().modified().unwrap();
        let replacement = root.join("replacement");
        let original_stamp = fs::read(stamp_path(&target)).unwrap();
        fs::write(&replacement, &bytes).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        fs::rename(replacement, &target).unwrap();
        assert_eq!(
            read_stamp(&target),
            FileStamp::of(&fs::metadata(&target).unwrap())
        );
        assert_eq!(read(&root, &metadata), Some(bytes));
        assert_eq!(fs::read(stamp_path(&target)).unwrap(), original_stamp);
        fs::remove_dir_all(root).unwrap();
    }
}
