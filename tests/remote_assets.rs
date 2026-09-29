//! The `remote` feature against a local mirror: payloads are downloaded once,
//! verified before they are cached, and served from the cache afterwards.
#![cfg(all(feature = "remote", not(target_arch = "wasm32")))]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use ferriki::{ErrorKind, Highlighter, RemoteAssets, StandardAssetCatalogs};

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

/// Serves `assets/shiki` below `/<COMMIT>/assets/shiki/`, one request per
/// connection. Individual paths can be replaced to simulate a bad mirror.
struct Mirror {
    url: String,
    requests: Arc<AtomicUsize>,
    overrides: Arc<Mutex<HashMap<String, Option<Vec<u8>>>>>,
}

impl Mirror {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("address"));
        let requests = Arc::new(AtomicUsize::new(0));
        let overrides = Arc::new(Mutex::new(HashMap::new()));
        let (count, replaced) = (Arc::clone(&requests), Arc::clone(&overrides));
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                count.fetch_add(1, Ordering::SeqCst);
                serve(stream, &replaced);
            }
        });
        Self {
            url,
            requests,
            overrides,
        }
    }

    fn requests(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }

    /// `None` answers 404; `Some(bytes)` answers 200 with those bytes.
    fn replace(&self, path: &str, body: Option<Vec<u8>>) {
        self.overrides
            .lock()
            .unwrap()
            .insert(format!("/{COMMIT}/assets/shiki/{path}"), body);
    }
}

fn serve(mut stream: TcpStream, overrides: &Mutex<HashMap<String, Option<Vec<u8>>>>) {
    let mut request_line = String::new();
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    reader.read_line(&mut request_line).expect("request line");
    let mut header = String::new();
    while reader.read_line(&mut header).is_ok_and(|read| read > 2) {
        header.clear();
    }
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_owned();
    let body = match overrides.lock().unwrap().get(&path) {
        Some(replaced) => replaced.clone(),
        None => path
            .strip_prefix(&format!("/{COMMIT}/assets/shiki/"))
            .and_then(|relative| std::fs::read(catalog_dir().join(relative)).ok()),
    };
    let response = match body {
        Some(body) => {
            let mut head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes();
            head.extend(body);
            head
        }
        None => {
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
        }
    };
    let _ = stream.write_all(&response);
}

fn catalog_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/shiki")
}

/// A fresh cache directory per call. The counter keeps parallel tests apart on
/// platforms whose clock has only microsecond resolution.
fn temp_cache() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let serial = NEXT.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "ferriki-remote-{}-{nanos}-{serial}",
        std::process::id()
    ))
}

fn settings(mirror: &Mirror, cache: &Path) -> RemoteAssets {
    RemoteAssets::default()
        .with_remote(Some(true))
        .with_base_url(Some(mirror.url.clone()))
        .with_cache_dir(Some(cache.to_path_buf()))
        .with_commit(Some(COMMIT.to_owned()))
}

fn load(settings: RemoteAssets, language: &str, theme: &str) -> ferriki::Result<Highlighter> {
    Highlighter::builder()
        .with_assets(StandardAssetCatalogs::remote(settings)?)
        .load_languages([language])
        .load_themes([theme])
        .build()
}

#[test]
fn downloads_once_then_highlights_from_the_cache_offline() {
    let mirror = Mirror::start();
    let cache = temp_cache();

    let mut highlighter = load(settings(&mirror, &cache), "rust", "nord").expect("remote load");
    let html = highlighter
        .highlight_html_lines("fn main() {}", "rust", "nord", &Default::default())
        .expect("highlight");
    assert!(html.lines[0].contains("<span"));
    let downloads = mirror.requests();
    assert!(downloads >= 2, "grammar and theme were downloaded");
    assert!(std::fs::read_dir(&cache).unwrap().count() >= 2);

    let offline = settings(&mirror, &cache).with_remote(Some(false));
    load(offline, "rust", "nord").expect("cached payloads load without downloads");
    assert_eq!(
        mirror.requests(),
        downloads,
        "the cache served every payload"
    );

    std::fs::remove_dir_all(cache).unwrap();
}

#[test]
fn tampered_downloads_are_rejected_and_never_cached() {
    let mirror = Mirror::start();
    let cache = temp_cache();
    mirror.replace(
        "themes/nord.fktheme",
        Some(b"not the pinned theme".to_vec()),
    );

    let error = load(settings(&mirror, &cache), "rust", "nord").expect_err("tampered theme");
    assert_eq!(error.kind(), ErrorKind::AssetIntegrity);
    let cached: Vec<_> = std::fs::read_dir(&cache)
        .map(|entries| entries.flatten().map(|entry| entry.file_name()).collect())
        .unwrap_or_default();
    let nord = ferriki::AssetDigest::of(
        &std::fs::read(catalog_dir().join("themes/nord.fktheme")).unwrap(),
    );
    assert!(!cached.iter().any(|name| name == nord.as_str()));

    let _ = std::fs::remove_dir_all(cache);
}

#[test]
fn a_corrupt_cache_entry_is_replaced_by_a_fresh_download() {
    let mirror = Mirror::start();
    let cache = temp_cache();
    let theme = std::fs::read(catalog_dir().join("themes/nord.fktheme")).unwrap();
    let digest = ferriki::AssetDigest::of(&theme);
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(cache.join(digest.as_str()), b"truncated").unwrap();

    load(settings(&mirror, &cache), "rust", "nord").expect("recovers from a corrupt entry");
    assert_eq!(std::fs::read(cache.join(digest.as_str())).unwrap(), theme);

    std::fs::remove_dir_all(cache).unwrap();
}

#[test]
fn download_failures_and_offline_misses_have_distinct_errors() {
    let mirror = Mirror::start();
    let cache = temp_cache();
    mirror.replace("languages/rust.fkgram", None);

    let error = load(settings(&mirror, &cache), "rust", "nord").expect_err("404");
    assert_eq!(error.kind(), ErrorKind::AssetDownload);
    assert!(error.to_string().contains("HTTP 404"), "{error}");

    let offline = settings(&mirror, &temp_cache()).with_remote(Some(false));
    let error = load(offline, "rust", "nord").expect_err("offline miss");
    assert_eq!(error.kind(), ErrorKind::AssetUnavailable);
    assert!(
        error.to_string().contains("pre-populate the cache"),
        "{error}"
    );

    let unreachable =
        settings(&mirror, &temp_cache()).with_base_url(Some("http://127.0.0.1:9".to_owned()));
    let error = load(unreachable, "rust", "nord").expect_err("unreachable mirror");
    assert_eq!(error.kind(), ErrorKind::AssetDownload);

    let _ = std::fs::remove_dir_all(cache);
}

#[test]
fn a_checkout_build_without_a_release_commit_names_the_remedy() {
    let mirror = Mirror::start();
    let cache = temp_cache();
    let without_commit = settings(&mirror, &cache).with_commit(None);
    // Tests build from a checkout, which has no published release commit.
    if option_env!("FERRIKI_RELEASE_COMMIT").is_none() {
        let error = load(without_commit, "rust", "nord").expect_err("no commit");
        assert_eq!(error.kind(), ErrorKind::AssetUnavailable);
        assert!(error.to_string().contains("with_commit"), "{error}");
    }
    assert_eq!(mirror.requests(), 0);
}
