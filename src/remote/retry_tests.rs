use super::*;
use std::collections::VecDeque;
use std::error::Error as _;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::JoinHandle;
use std::time::Instant;

const PAYLOAD: &[u8] = b"release-pinned payload";

enum Reply {
    Status(u16, Option<&'static str>),
    Disconnect,
    Interrupted,
    Body(Vec<u8>),
    DelayedHeaders(Duration),
    DelayedBody(Duration),
}

struct Mirror {
    address: std::net::SocketAddr,
    requests: Arc<Mutex<Vec<Instant>>>,
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Mirror {
    fn start(replies: impl IntoIterator<Item = Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local mirror");
        let address = listener.local_addr().expect("mirror address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stopped = Arc::new(AtomicBool::new(false));
        let (times, stop) = (Arc::clone(&requests), Arc::clone(&stopped));
        let mut replies: VecDeque<_> = replies.into_iter().collect();
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.expect("accept mirror request");
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .expect("bound request reads");
                let mut reader = BufReader::new(stream.try_clone().expect("clone request stream"));
                let mut line = String::new();
                while reader.read_line(&mut line).expect("read request") > 2 {
                    line.clear();
                }
                times.lock().expect("request times").push(Instant::now());
                let reply = replies
                    .pop_front()
                    .unwrap_or_else(|| Reply::Body(PAYLOAD.to_vec()));
                match reply {
                    Reply::Status(status, retry_after) => {
                        let header = retry_after
                            .map_or(String::new(), |value| format!("Retry-After: {value}\r\n"));
                        let _ = write!(
                            stream,
                            "HTTP/1.1 {status} Test\r\n{header}Content-Length: 0\r\nConnection: close\r\n\r\n"
                        );
                    }
                    Reply::Disconnect => {}
                    Reply::Interrupted => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            PAYLOAD.len()
                        );
                        let _ = stream.write_all(&PAYLOAD[..3]);
                    }
                    Reply::Body(bytes) => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            bytes.len()
                        );
                        let _ = stream.write_all(&bytes);
                    }
                    Reply::DelayedHeaders(wait) | Reply::DelayedBody(wait) => {
                        let body_wait = matches!(reply, Reply::DelayedBody(_));
                        if !body_wait {
                            std::thread::sleep(wait);
                        }
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            PAYLOAD.len()
                        );
                        if body_wait {
                            let _ = stream.flush();
                            std::thread::sleep(wait);
                        }
                        let _ = stream.write_all(PAYLOAD);
                    }
                }
            }
        });
        Self {
            address,
            requests,
            stopped,
            thread: Some(thread),
        }
    }

    fn requests(&self) -> Vec<Instant> {
        self.requests.lock().expect("request times").clone()
    }
}

impl Drop for Mirror {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.address);
        self.thread
            .take()
            .expect("mirror thread")
            .join()
            .expect("join mirror");
    }
}

struct Fixture {
    source: RemoteAssetSource,
    digest: AssetDigest,
    root: PathBuf,
    cache: PathBuf,
}

impl Fixture {
    fn new(mirror: &Mirror) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "ferriki-remote-retries-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("test root");
        let cache = root.join("cache");
        let digest = AssetDigest::of(PAYLOAD);
        let release = ReleaseManifest::from_json(&format!(
            r#"{{"manifestVersion":1,"assets":{{"languages/test.fkgram":{{"sha256":"{}","size":{},"formatVersion":1}}}}}}"#,
            digest.as_str(), PAYLOAD.len()
        )).expect("test release");
        let settings = RemoteAssets::default()
            .with_remote(Some(true))
            .with_base_url(Some(format!("http://{}", mirror.address)))
            .with_cache_dir(Some(cache.clone()))
            .with_commit(Some("0123456789abcdef0123456789abcdef01234567".to_owned()))
            .resolve(&release, |_| None)
            .expect("test remote settings");
        let mut source = RemoteAssetSource::new(&release, settings, true).expect("remote source");
        // Local transport tests must not inherit a host's corporate proxy.
        source.agent = ureq::Agent::config_builder()
            .proxy(None)
            .tls_config(source.agent.config().tls_config().clone())
            .http_status_as_error(false)
            .build()
            .new_agent();
        Self {
            source,
            digest,
            root,
            cache,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).expect("remove test cache");
    }
}

#[test]
fn transient_statuses_recover_and_only_cache_verified_bytes() {
    for status in [408, 503] {
        let mirror = Mirror::start([Reply::Status(status, None), Reply::Status(429, Some("0"))]);
        let fixture = Fixture::new(&mirror);
        assert_eq!(
            fixture
                .source
                .read(&fixture.digest)
                .expect("recover")
                .as_ref(),
            PAYLOAD
        );
        let requests = mirror.requests();
        assert_eq!(requests.len(), 3);
        assert!(requests[1].duration_since(requests[0]) >= Duration::from_millis(250));
        assert!(requests[2].duration_since(requests[1]) >= Duration::from_millis(500));
        assert_eq!(
            std::fs::read(fixture.cache.join(fixture.digest.as_str())).unwrap(),
            PAYLOAD
        );
        assert_eq!(std::fs::read_dir(&fixture.cache).unwrap().count(), 1);
    }
}

#[test]
fn retries_stop_after_three_attempts_and_a_later_call_can_recover() {
    let mirror = Mirror::start((0..3).map(|_| Reply::Status(503, None)));
    let fixture = Fixture::new(&mirror);
    let error = fixture
        .source
        .read(&fixture.digest)
        .expect_err("exhausted attempts");
    assert_eq!(error.kind(), ErrorKind::AssetDownload);
    assert!(matches!(
        error
            .source()
            .and_then(|source| source.downcast_ref::<ureq::Error>()),
        Some(ureq::Error::StatusCode(503))
    ));
    assert_eq!(mirror.requests().len(), 3);
    assert!(!fixture.cache.exists());
    assert_eq!(
        fixture
            .source
            .read(&fixture.digest)
            .expect("later recovery")
            .as_ref(),
        PAYLOAD
    );
    assert_eq!(mirror.requests().len(), 4);
}

#[test]
fn retry_after_is_honored_without_retrying_long_pauses_early() {
    let mirror = Mirror::start([Reply::Status(429, Some("1"))]);
    let fixture = Fixture::new(&mirror);
    fixture
        .source
        .read(&fixture.digest)
        .expect("short pause recovers");
    let requests = mirror.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].duration_since(requests[0]) >= Duration::from_secs(1));

    let mirror = Mirror::start([Reply::Status(429, Some("120"))]);
    let fixture = Fixture::new(&mirror);
    assert_eq!(
        fixture
            .source
            .read(&fixture.digest)
            .expect_err("long pause")
            .kind(),
        ErrorKind::AssetDownload
    );
    assert_eq!(mirror.requests().len(), 1);
    assert!(!fixture.cache.exists());
}

#[test]
fn retry_after_http_dates_use_the_same_bounded_delay() {
    let now = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    let value = httpdate::fmt_http_date(now + Duration::from_secs(2));
    let failure = DownloadFailure {
        source: ureq::Error::StatusCode(503),
        retry_after: retry_after_delay(&value, now),
    };
    assert_eq!(failure.retry_delay(0), Some(Duration::from_secs(2)));
    let value = httpdate::fmt_http_date(now + Duration::from_secs(120));
    let failure = DownloadFailure {
        source: ureq::Error::StatusCode(503),
        retry_after: retry_after_delay(&value, now),
    };
    assert_eq!(failure.retry_delay(0), None);
}

#[test]
fn headers_and_body_use_only_the_deadline_left_after_backoff() {
    for reply in [
        Reply::DelayedHeaders(Duration::from_millis(750)),
        Reply::DelayedBody(Duration::from_millis(750)),
    ] {
        let mirror = Mirror::start([Reply::Status(503, None), reply]);
        let fixture = Fixture::new(&mirror);
        let error = fixture
            .source
            .read_remote_until(
                &format!("http://{}", mirror.address),
                PAYLOAD.len() as u64,
                Instant::now() + Duration::from_millis(800),
            )
            .expect_err("shared deadline expires during second attempt");
        assert_eq!(error.kind(), ErrorKind::AssetDownload);
        assert!(matches!(
            error
                .source()
                .and_then(|source| source.downcast_ref::<ureq::Error>()),
            Some(ureq::Error::Timeout(ureq::Timeout::Global))
        ));
        assert_eq!(mirror.requests().len(), 2);
        assert!(!fixture.cache.exists());
    }
}

#[test]
fn certificate_configuration_and_cache_failures_do_not_retry() {
    assert!(transient_transport_error(&ureq::Error::Io(
        std::io::Error::other("opaque resolver failure")
    )));
    assert!(!transient_transport_error(&ureq::Error::Tls(
        "untrusted certificate"
    )));
    assert!(!transient_transport_error(&ureq::Error::Rustls(
        rustls::Error::InvalidCertificate(rustls::CertificateError::Expired)
    )));
    assert!(!transient_transport_error(&ureq::Error::BadUri(
        "bad mirror".to_owned()
    )));
    for kind in [
        std::io::ErrorKind::InvalidData,
        std::io::ErrorKind::PermissionDenied,
    ] {
        assert!(!transient_transport_error(&ureq::Error::Io(
            std::io::Error::from(kind)
        )));
    }
    let mirror = Mirror::start([]);
    let fixture = Fixture::new(&mirror);
    std::fs::write(&fixture.cache, b"not a cache directory").expect("block cache writes");
    let error = fixture
        .source
        .read(&fixture.digest)
        .expect_err("cache failure");
    assert_eq!(error.kind(), ErrorKind::AssetIo);
    assert!(error.source().is_some());
    assert_eq!(mirror.requests().len(), 1);
    assert_eq!(
        std::fs::read(&fixture.cache).unwrap(),
        b"not a cache directory"
    );
}

#[test]
fn interrupted_headers_and_response_bodies_recover() {
    for reply in [Reply::Disconnect, Reply::Interrupted] {
        let mirror = Mirror::start([reply]);
        let fixture = Fixture::new(&mirror);
        assert_eq!(
            fixture
                .source
                .read(&fixture.digest)
                .expect("recover")
                .as_ref(),
            PAYLOAD
        );
        assert_eq!(mirror.requests().len(), 2);
        assert_eq!(std::fs::read_dir(&fixture.cache).unwrap().count(), 1);
    }
}

#[test]
fn permanent_status_and_integrity_failures_do_not_retry() {
    for (reply, kind) in [
        (Reply::Status(404, None), ErrorKind::AssetDownload),
        (
            Reply::Body(vec![b'x'; PAYLOAD.len()]),
            ErrorKind::AssetIntegrity,
        ),
        (
            Reply::Body(vec![b'x'; PAYLOAD.len() + 1]),
            ErrorKind::AssetIntegrity,
        ),
    ] {
        let mirror = Mirror::start([reply]);
        let fixture = Fixture::new(&mirror);
        let error = fixture.source.read(&fixture.digest).expect_err("fail");
        assert_eq!(error.kind(), kind);
        assert_eq!(mirror.requests().len(), 1);
        assert!(
            !fixture.cache.exists(),
            "failed bytes never reach the cache"
        );
    }
}
