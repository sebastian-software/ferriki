//! Shared configuration for digest-addressed asset caches and mirrors.

use std::net::{IpAddr, Ipv6Addr};
use std::path::{Path, PathBuf};

use crate::{Error, ErrorKind, Result};

pub(crate) fn catalog_path(catalog: &str, file: &str) -> Result<String> {
    if file.is_empty()
        || file == "."
        || file == ".."
        || file.contains('/')
        || file.contains('\\')
        || Path::new(file).components().count() != 1
        || Path::new(file).file_name().and_then(|name| name.to_str()) != Some(file)
    {
        return Err(Error::new(
            ErrorKind::AssetFormat,
            format!("Invalid Ferriki asset filename `{file}`."),
        ));
    }
    Ok(format!("{catalog}/{file}"))
}

pub(crate) fn validate_base_url(base_url: &str) -> Result<String> {
    let invalid = || {
        Error::new(
            ErrorKind::AssetDownload,
            "Invalid asset base URL: only https:// URLs (or http:// loopback URLs) without credentials, query strings, or fragments are allowed.",
        )
    };
    if base_url.is_empty()
        || base_url
            .bytes()
            .any(|byte| byte <= 0x20 || byte == 0x7f || matches!(byte, b'\\' | b'?' | b'#'))
    {
        return Err(invalid());
    }
    let (is_https, rest) = if base_url
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
    {
        (true, &base_url[8..])
    } else if base_url
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
    {
        (false, &base_url[7..])
    } else {
        return Err(invalid());
    };
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, Some(path)),
        None => (rest, None),
    };
    if authority.is_empty() || authority.contains('@') || authority.contains('%') {
        return Err(invalid());
    }
    let host = if authority.starts_with('[') {
        let end = authority.find(']').ok_or_else(invalid)?;
        let host = &authority[..=end];
        let tail = &authority[end + 1..];
        host[1..host.len() - 1]
            .parse::<Ipv6Addr>()
            .map_err(|_| invalid())?;
        if !tail.is_empty() {
            let port = tail.strip_prefix(':').ok_or_else(invalid)?;
            validate_port(port).ok_or_else(invalid)?;
        }
        host
    } else {
        if authority.contains('[') || authority.contains(']') {
            return Err(invalid());
        }
        let host = match authority.split_once(':') {
            Some((host, port)) => {
                validate_port(port).ok_or_else(invalid)?;
                host
            }
            None => authority,
        };
        let labels = host.strip_suffix('.').unwrap_or(host);
        if labels.is_empty()
            || !labels.split('.').all(|label| !label.is_empty())
            || !labels
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
        {
            return Err(invalid());
        }
        host
    };
    if !is_https && !is_loopback_host(host) {
        return Err(invalid());
    }
    if let Some(path) = path {
        for segment in path.split('/') {
            let Some(decoded) = percent_decode_segment(segment) else {
                return Err(invalid());
            };
            if segment.is_empty()
                || segment == "."
                || segment == ".."
                || decoded.is_empty()
                || decoded == b"."
                || decoded == b".."
                || decoded.iter().any(|&byte| {
                    byte < 0x20 || byte == 0x7f || matches!(byte, b'/' | b'\\' | b'?' | b'#')
                })
            {
                return Err(invalid());
            }
        }
    }
    Ok(format!(
        "{}://{rest}",
        if is_https { "https" } else { "http" }
    ))
}

fn validate_port(port: &str) -> Option<u16> {
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse::<u16>().ok().filter(|&value| value > 0)
}

fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.eq_ignore_ascii_case("localhost.") {
        return true;
    }
    let addr = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host);
    addr.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode_segment(segment: &str) -> Option<Vec<u8>> {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_value(*bytes.get(index + 1)?)?;
            let low = hex_value(*bytes.get(index + 2)?)?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    Some(decoded)
}

fn validate_legacy_asset_path(path: &str) -> Result<()> {
    let invalid = || Error::new(ErrorKind::AssetFormat, "Invalid legacy asset path.");
    if path.is_empty()
        || path.starts_with('/')
        || path.ends_with('/')
        || path
            .bytes()
            .any(|byte| byte <= 0x20 || byte == 0x7f || matches!(byte, b'\\' | b'?' | b'#'))
    {
        return Err(invalid());
    }
    for segment in path.split('/') {
        let decoded = percent_decode_segment(segment).ok_or_else(invalid)?;
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || decoded.is_empty()
            || decoded == b"."
            || decoded == b".."
            || decoded.iter().any(|&byte| {
                byte <= 0x20 || byte == 0x7f || matches!(byte, b'/' | b'\\' | b'?' | b'#')
            })
        {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(crate) fn asset_url(
    storage_layout: Option<&str>,
    settings: &ResolvedAssetSettings,
    path: &str,
    digest: &str,
) -> Result<String> {
    let base_url = validate_base_url(&settings.base_url)?;
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
        return Ok(format!("{base_url}/{prefix}{id}/{object}"));
    }
    let commit = settings.commit.as_deref().ok_or_else(|| Error::new(
        ErrorKind::AssetUnavailable,
        "Legacy assets need a release commit. Set FERRIKI_RELEASE_COMMIT or pre-populate the cache.",
    ))?;
    if !matches!(commit.len(), 40 | 64) || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Error::new(
            ErrorKind::AssetFormat,
            "Invalid legacy release commit.",
        ));
    }
    validate_legacy_asset_path(path)?;
    Ok(format!("{base_url}/{commit}/assets/shiki/{path}"))
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
    let mut base_url = input
        .base_url
        .or_else(|| env("FERRIKI_ASSETS_BASE_URL").filter(|value| !value.trim().is_empty()))
        .unwrap_or_else(|| DEFAULT_ASSETS_BASE_URL.to_owned())
        .trim()
        .trim_end_matches('/')
        .to_owned();
    if let Ok(normalized) = validate_base_url(&base_url) {
        base_url = normalized;
    }
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
        settings.commit = Some("c".repeat(64));
        assert_eq!(
            asset_url(None, &settings, "languages/rust.fkgram", &hash).unwrap(),
            format!(
                "https://assets.example/{}/assets/shiki/languages/rust.fkgram",
                "c".repeat(64)
            )
        );
    }

    #[test]
    fn resolve_asset_settings_validates_base_url_scheme_and_components() {
        let resolve = |base_url: &str| {
            resolve_asset_settings(
                AssetSettingsInput {
                    remote: Some(true),
                    base_url: Some(base_url.to_owned()),
                    cache_dir: Some(PathBuf::from("cache")),
                    commit: None,
                    release_commit: None,
                    compiled_commit: None,
                    cache_hint: "test",
                },
                |_| None,
            )
        };

        for valid in [
            "https://assets.ferriki.dev",
            "https://assets.ferriki.dev/",
            "HTTPS://mirror.example/assets",
            "HTTP://localhost:8080/mirror",
            "https://mirror.example./assets/",
            "https://xn--bcher-kva.example/assets/",
            "https://mirror.example:8443/ferriki/",
            "https://[::1]:8443/mirror",
            "http://localhost",
            "http://localhost:8080/mirror/",
            "http://localhost.:8080/assets",
            "http://LOCALHOST:1",
            "http://127.0.0.1",
            "http://127.0.0.1:8080",
            "http://127.0.0.2:8080/assets",
            "http://[::1]",
            "http://[::1]:8080/mirror",
            "http://[0:0:0:0:0:0:0:1]:8080/assets",
        ] {
            let resolved = resolve(valid)
                .unwrap_or_else(|err| panic!("expected valid base_url {valid}: {err}"));
            let url = asset_url(
                Some("language-hash-v2"),
                &resolved,
                "languages/rust.fkgram",
                &"a".repeat(64),
            )
            .unwrap_or_else(|err| panic!("expected valid asset_url for {valid}: {err}"));
            #[cfg(all(feature = "remote", not(target_arch = "wasm32")))]
            ureq::http::Uri::try_from(url.as_str())
                .unwrap_or_else(|err| panic!("ureq URI parser rejected {url}: {err}"));
            #[cfg(not(all(feature = "remote", not(target_arch = "wasm32"))))]
            let _ = url;
        }

        for invalid in [
            "",
            "   ",
            "http://example.com",
            "http://assets.ferriki.dev",
            "http://localhost.evil.example",
            "http://127.0.0.1.evil.example",
            "http://0.0.0.0:8080",
            "http://128.0.0.1:8080/assets",
            "http://[::2]:8080",
            "http://é.example",
            "https://é.example",
            "file:///etc/passwd",
            "ftp://mirror.example",
            "https://",
            "https://.",
            "https://..",
            "https://mirror.example..",
            "https://bücher.example",
            "https:///path",
            "https://user:secret-pass@assets.ferriki.dev",
            "http://localhost@evil.example",
            "http://localhost%40evil.example",
            "https://assets.ferriki.dev?token=1",
            "https://assets.ferriki.dev#fragment",
            "https://assets.ferriki.dev/path\\other",
            "http://localhost\\@evil.example",
            "https://assets.ferriki.dev/../other",
            "https://assets.ferriki.dev/a//b",
            "https://assets.ferriki.dev:0",
            "https://assets.ferriki.dev:70000",
            "https://assets.ferriki.dev:abc",
            "https://assets.ferriki.dev/a\nb",
            "https://assets .ferriki.dev",
        ] {
            let resolved = resolve(invalid)
                .unwrap_or_else(|err| panic!("settings resolution must defer URL policy: {err}"));
            let error = asset_url(
                Some("language-hash-v2"),
                &resolved,
                "languages/rust.fkgram",
                &"a".repeat(64),
            )
            .expect_err(&format!("expected invalid base_url: {invalid}"));
            assert_eq!(error.kind(), ErrorKind::AssetDownload, "{invalid}");
            assert!(
                !error.to_string().contains("secret-pass"),
                "error must not leak URL credentials"
            );
        }
        assert_eq!(
            resolve("HTTPS://mirror.example/assets").unwrap().base_url,
            "https://mirror.example/assets"
        );
        assert_eq!(
            resolve("HTTP://localhost:8080/mirror").unwrap().base_url,
            "http://localhost:8080/mirror"
        );
        assert!(validate_base_url("https://assets.ferriki.dev\n").is_err());

        // Offline mode must remain independent of an older plaintext mirror URL.
        let offline = resolve_asset_settings(
            AssetSettingsInput {
                remote: Some(false),
                base_url: None,
                cache_dir: Some(PathBuf::from("cache")),
                commit: None,
                release_commit: None,
                compiled_commit: None,
                cache_hint: "test",
            },
            |key| {
                (key == "FERRIKI_ASSETS_BASE_URL")
                    .then(|| "http://internal-mirror.example/assets".to_owned())
            },
        )
        .expect("offline settings ignore mirror URL");
        assert!(!offline.remote);
        assert_eq!(
            asset_url(
                Some("language-hash-v2"),
                &offline,
                "languages/rust.fkgram",
                &"a".repeat(64)
            )
            .unwrap_err()
            .kind(),
            ErrorKind::AssetDownload
        );
    }

    #[test]
    fn legacy_asset_url_rejects_invalid_commits_and_paths() {
        let hash = "a".repeat(64);
        let mut settings = ResolvedAssetSettings {
            remote: true,
            base_url: "https://assets.example".to_owned(),
            cache_dir: PathBuf::from("cache"),
            commit: Some("b".repeat(40)),
        };

        for bad_commit in [
            "",
            "abc123",
            "main",
            "../other",
            &"g".repeat(40),
            &"b".repeat(41),
        ] {
            settings.commit = Some(bad_commit.to_owned());
            let error = asset_url(None, &settings, "languages/rust.fkgram", &hash)
                .expect_err(&format!("expected invalid commit: {bad_commit}"));
            assert_eq!(error.kind(), ErrorKind::AssetFormat);
        }

        settings.commit = Some("b".repeat(40));
        for bad_path in [
            "",
            "/languages/rust.fkgram",
            "languages/rust.fkgram/",
            "../secret",
            "languages/../secret",
            "languages/./rust.fkgram",
            "languages//rust.fkgram",
            "languages/rust.fkgram?x=1",
            "languages/rust.fkgram#frag",
            "languages\\rust.fkgram",
            "languages/rust .fkgram",
            "languages/%2e%2e/secret",
            "languages/%2E/rust.fkgram",
            "languages/.%2e/secret",
            "languages/rust%2ffake.fkgram",
            "languages/rust%2Ffake.fkgram",
            "languages/rust%5cfake.fkgram",
            "languages/rust%5Cfake.fkgram",
            "languages/rust%3fx=1",
            "languages/rust%23frag",
            "languages/rust%2",
            "languages/rust%zz.fkgram",
        ] {
            let error = asset_url(None, &settings, bad_path, &hash)
                .expect_err(&format!("expected invalid legacy path: {bad_path}"));
            assert_eq!(error.kind(), ErrorKind::AssetFormat, "{bad_path}");
        }
    }
}
