//! Shared configuration for digest-addressed asset caches and mirrors.

use std::path::PathBuf;

use crate::{Error, ErrorKind, Result};

pub(crate) fn asset_url(
    storage_layout: Option<&str>,
    settings: &ResolvedAssetSettings,
    path: &str,
    digest: &str,
) -> Result<String> {
    if matches!(
        storage_layout,
        Some("language-hash-v1" | "language-hash-v2")
    ) {
        let (prefix, id) = if let Some(id) = path.strip_prefix("languages/").and_then(|p| {
            p.strip_suffix(".fkgram")
                .or_else(|| p.strip_suffix(".fkbc"))
        }) {
            ("", id)
        } else if let Some(id) = path
            .strip_prefix("themes/")
            .and_then(|p| p.strip_suffix(".fktheme"))
        {
            ("themes/", id)
        } else {
            return Err(Error::new(
                ErrorKind::AssetFormat,
                "Invalid content-addressed payload path.",
            ));
        };
        if id.is_empty()
            || !id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err(Error::new(
                ErrorKind::AssetFormat,
                "Invalid content-addressed asset ID.",
            ));
        }
        let object = if storage_layout == Some("language-hash-v2") {
            short_hash(digest)?
        } else {
            digest.to_owned()
        };
        return Ok(format!("{}/{prefix}{id}/{object}", settings.base_url));
    }
    let commit = settings.commit.as_deref().ok_or_else(|| Error::new(
        ErrorKind::AssetUnavailable,
        "Legacy assets need a release commit. Set FERRIKI_RELEASE_COMMIT or pre-populate the cache.",
    ))?;
    Ok(format!(
        "{}/{commit}/assets/shiki/{path}",
        settings.base_url
    ))
}

pub(crate) fn short_hash(digest: &str) -> Result<String> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(Error::new(ErrorKind::AssetFormat, "Invalid asset digest."));
    }
    let mut value = u64::from_str_radix(&digest[..16], 16)
        .map_err(|_| Error::new(ErrorKind::AssetFormat, "Invalid asset digest."))?
        % 62_u64.pow(8);
    let alphabet = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut encoded = [b'0'; 8];
    for byte in encoded.iter_mut().rev() {
        *byte = alphabet[(value % 62) as usize];
        value /= 62;
    }
    Ok(encoded.into_iter().map(char::from).collect())
}

/// The default mirror of immutable payloads and legacy release assets.
#[cfg(all(feature = "remote", not(target_arch = "wasm32")))]
pub const DEFAULT_ASSETS_BASE_URL: &str = "https://assets.ferriki.dev";
#[cfg(not(all(feature = "remote", not(target_arch = "wasm32"))))]
pub(crate) const DEFAULT_ASSETS_BASE_URL: &str = "https://assets.ferriki.dev";

#[derive(Debug)]
pub(crate) struct ResolvedAssetSettings {
    pub(crate) remote: bool,
    pub(crate) base_url: String,
    pub(crate) cache_dir: PathBuf,
    pub(crate) commit: Option<String>,
}

pub(crate) struct AssetSettingsInput {
    pub(crate) remote: Option<bool>,
    pub(crate) base_url: Option<String>,
    pub(crate) cache_dir: Option<PathBuf>,
    pub(crate) commit: Option<String>,
    pub(crate) release_commit: Option<String>,
    pub(crate) compiled_commit: Option<&'static str>,
    pub(crate) cache_hint: &'static str,
}

pub(crate) fn resolve_asset_settings(
    input: AssetSettingsInput,
    env: impl Fn(&str) -> Option<String>,
) -> Result<ResolvedAssetSettings> {
    let remote = input.remote.unwrap_or_else(|| {
        env("FERRIKI_ASSETS_REMOTE").is_none_or(|value| {
            !matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false")
        })
    });
    let base_url = input
        .base_url
        .or_else(|| env("FERRIKI_ASSETS_BASE_URL").filter(|value| !value.trim().is_empty()))
        .unwrap_or_else(|| DEFAULT_ASSETS_BASE_URL.to_owned())
        .trim()
        .trim_end_matches('/')
        .to_owned();
    let cache_dir = input
        .cache_dir
        .or_else(|| {
            env("FERRIKI_CACHE_DIR")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| platform_cache_dir(&env))
        .ok_or_else(|| {
            Error::new(
                ErrorKind::AssetIo,
                format!(
                    "No cache directory for Ferriki assets; {}.",
                    input.cache_hint
                ),
            )
        })?;
    let commit = input
        .commit
        .or(input.release_commit)
        .or_else(|| input.compiled_commit.map(str::to_owned));

    Ok(ResolvedAssetSettings {
        remote,
        base_url,
        cache_dir,
        commit,
    })
}

pub(crate) fn platform_cache_dir(env: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
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

#[cfg(test)]
mod url_tests {
    use super::*;

    #[test]
    fn immutable_layout_needs_no_commit_and_legacy_routing_stays_available() {
        let mut settings = ResolvedAssetSettings {
            remote: true,
            base_url: "https://assets.example".to_owned(),
            cache_dir: PathBuf::from("cache"),
            commit: None,
        };
        let hash = "a".repeat(64);
        assert_eq!(short_hash(&"0".repeat(64)).unwrap(), "00000000");
        assert_eq!(short_hash(&hash).unwrap(), "Big46r2A");
        assert_eq!(short_hash(&"f".repeat(64)).unwrap(), "Ha16AHYF");
        assert_eq!(
            asset_url(
                Some("language-hash-v2"),
                &settings,
                "languages/rust.fkgram",
                &hash
            )
            .unwrap(),
            "https://assets.example/rust/Big46r2A"
        );
        assert_eq!(
            asset_url(
                Some("language-hash-v1"),
                &settings,
                "languages/rust.fkgram",
                &hash
            )
            .unwrap(),
            format!("https://assets.example/rust/{hash}")
        );
        assert_eq!(
            asset_url(
                Some("language-hash-v1"),
                &settings,
                "themes/nord.fktheme",
                &hash
            )
            .unwrap(),
            format!("https://assets.example/themes/nord/{hash}")
        );
        assert!(
            asset_url(
                Some("language-hash-v1"),
                &settings,
                "languages/../rust.fkgram",
                &hash
            )
            .is_err()
        );
        assert!(asset_url(None, &settings, "languages/rust.fkgram", &hash).is_err());
        settings.commit = Some("b".repeat(40));
        assert_eq!(
            asset_url(None, &settings, "languages/rust.fkgram", &hash).unwrap(),
            format!(
                "https://assets.example/{}/assets/shiki/languages/rust.fkgram",
                "b".repeat(40)
            )
        );
    }
}
