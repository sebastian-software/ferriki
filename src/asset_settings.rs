//! Shared configuration for digest-addressed asset caches and mirrors.

use std::path::PathBuf;

use crate::{Error, ErrorKind, Result};

/// The default mirror of this repository's release commits.
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
