//! Persist decoded prepared containers by their release-pinned identity.
//! A warm cache avoids transport decompression; integrity remains checked before use.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::{AssetMetadata, Error, ErrorKind, Result};

const MAX_DECODED_BYTES: u64 = 512 * 1024 * 1024;
static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

fn path(root: &Path, metadata: &AssetMetadata) -> PathBuf {
    root.join("decoded").join(metadata.digest().as_str())
}

/// Planning only checks availability. The actual read always verifies the bytes.
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
    let file = fs::File::open(&path).ok()?;
    let metadata = file.metadata().ok()?;
    let valid_size = metadata.is_file() && metadata.len() == decoded.size();
    if valid_size {
        let mut bytes = Vec::with_capacity(usize::try_from(decoded.size()).ok()?);
        if file.take(decoded.size()).read_to_end(&mut bytes).is_ok()
            && decoded.verify_bytes(&bytes).is_ok()
        {
            return Some(bytes);
        }
    } else {
        drop(file);
    }
    // Only this derived artifact is discarded; the original download remains usable.
    let _ = fs::remove_file(path);
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
    let directory = target.parent().expect("decoded cache has a parent");
    fs::create_dir_all(directory)?;
    // Relaxed ordering suffices for a unique filename; no data is published by this counter.
    let serial = NEXT_WRITE.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(
        ".{}.{}.{serial}.tmp",
        metadata.digest().as_str(),
        std::process::id()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        drop(file);
        fs::rename(&temporary, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
