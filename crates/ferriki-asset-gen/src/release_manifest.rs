//! The release manifest pins every standard payload by digest (ADR 0013).

use crate::schema::FORMAT_VERSION;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

/// File name of the release manifest inside a generated catalog directory.
pub const RELEASE_MANIFEST_FILE: &str = "release-manifest.json";

/// Version of the release manifest's own JSON layout.
pub const RELEASE_MANIFEST_VERSION: u32 = 1;

const CATALOGS: [(&str, &str); 2] = [("languages", "fkgram"), ("themes", "fktheme")];

/// Digest, size and format version of every grammar and theme payload.
///
/// Keys are payload paths relative to the catalog directory, such as
/// `languages/typescript.fkgram`. The repository copy carries no `commit`; the
/// release build sets it to the release commit, whose tree serves the payloads.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ReleaseManifest {
    pub manifest_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    pub assets: BTreeMap<String, ReleaseAsset>,
}

/// One pinned payload of a [`ReleaseManifest`].
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ReleaseAsset {
    /// Lowercase hexadecimal SHA-256 of the payload file.
    pub sha256: String,
    /// Payload size in bytes.
    pub size: u64,
    /// Binary asset format version of the payload.
    pub format_version: u32,
}

impl ReleaseManifest {
    /// Hashes every payload in the `languages/` and `themes/` catalogs of `catalog_dir`.
    pub fn from_catalog_dir(catalog_dir: &Path) -> io::Result<Self> {
        let mut assets = BTreeMap::new();
        for (catalog, extension) in CATALOGS {
            for entry in fs::read_dir(catalog_dir.join(catalog))? {
                let path = entry?.path();
                if path.extension().and_then(|value| value.to_str()) != Some(extension) {
                    continue;
                }
                let file_name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!("non-UTF-8 payload name `{}`", path.display()),
                        )
                    })?;
                let bytes = fs::read(&path)?;
                assets.insert(
                    format!("{catalog}/{file_name}"),
                    ReleaseAsset {
                        sha256: sha256_hex(&bytes),
                        size: bytes.len() as u64,
                        format_version: FORMAT_VERSION,
                    },
                );
            }
        }
        Ok(Self {
            manifest_version: RELEASE_MANIFEST_VERSION,
            commit: None,
            assets,
        })
    }

    /// Parses a release manifest and rejects unknown layout versions.
    pub fn from_json(source: &str) -> Result<Self, serde_json::Error> {
        let manifest: Self = serde_json::from_str(source)?;
        if manifest.manifest_version != RELEASE_MANIFEST_VERSION {
            return Err(serde::de::Error::custom(format!(
                "unsupported release manifest version {}; expected {RELEASE_MANIFEST_VERSION}",
                manifest.manifest_version
            )));
        }
        Ok(manifest)
    }

    /// Serializes the manifest as stable, pretty-printed JSON with a final newline.
    #[must_use]
    pub fn to_json(&self) -> String {
        let mut json = serde_json::to_string_pretty(self).expect("release manifest serializes");
        json.push('\n');
        json
    }

    /// Returns the manifest pinned to the given release commit.
    #[must_use]
    pub fn with_commit(mut self, commit: impl Into<String>) -> Self {
        self.commit = Some(commit.into());
        self
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_known_bytes() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn json_roundtrip_is_stable_and_versioned() {
        let mut assets = BTreeMap::new();
        assets.insert(
            "themes/nord.fktheme".to_owned(),
            ReleaseAsset {
                sha256: sha256_hex(b"nord"),
                size: 4,
                format_version: FORMAT_VERSION,
            },
        );
        let manifest = ReleaseManifest {
            manifest_version: RELEASE_MANIFEST_VERSION,
            commit: None,
            assets,
        };
        let json = manifest.to_json();
        assert!(!json.contains("commit"));
        assert_eq!(ReleaseManifest::from_json(&json).expect("parse"), manifest);

        let pinned = manifest.with_commit("0123abc");
        assert!(pinned.to_json().contains("\"commit\": \"0123abc\""));

        let other = json.replace("\"manifestVersion\": 1", "\"manifestVersion\": 2");
        assert!(ReleaseManifest::from_json(&other).is_err());
    }
}
