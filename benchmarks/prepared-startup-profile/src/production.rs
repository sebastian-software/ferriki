//! Separate instrumented probe through the same indexed cache provider as Node.
//! Phase clocks perturb execution; ordinary Node runs remain the timing evidence.
use ferriki::__private::{HighlighterCore, NodeAssetHost, NodeAssetOptions};
use ferriki::{AssetDigest, RegexMode, RenderOptions, TokenizeOptions, render_html};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn measure<T>(load: impl FnOnce() -> T) -> (T, Value) {
    let start = Instant::now();
    let (value, phases) = ferroni::scanner::load_profile::measure(load);
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    let phases: Vec<_> = phases
        .into_iter()
        .map(|sample| {
            json!({"phase": sample.phase, "calls": sample.calls,
                "inclusiveMs": sample.inclusive_ns as f64 / 1e6,
                "exclusiveMs": sample.exclusive_ns as f64 / 1e6})
        })
        .collect();
    (value, json!({"elapsedMs": elapsed, "phases": phases}))
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let inputs: Value = serde_json::from_slice(&fs::read(&args[2]).unwrap()).unwrap();
    let documents = inputs[0]["documents"].as_array().unwrap();
    let mode = match args[4].as_str() {
        "off" => RegexMode::Off,
        "auto" => RegexMode::Auto,
        "eager" => RegexMode::Eager,
        "prepared" => RegexMode::Prepared,
        _ => panic!("unsupported mode"),
    };
    let (mut highlighter, setup) = measure(|| {
        let host = NodeAssetHost::from_root(
            Path::new(&args[1]),
            &NodeAssetOptions {
                remote: Some(false),
                cache_dir: Some(PathBuf::from(&args[3])),
                regex_mode: Some(mode),
                ..NodeAssetOptions::default()
            },
        )
        .unwrap();
        let mut highlighter =
            HighlighterCore::with_assets_and_regex_mode(host.catalogs().unwrap(), mode).unwrap();
        for doc in documents {
            highlighter
                .load_standard_language(doc["lang"].as_str().unwrap())
                .unwrap();
        }
        highlighter.load_standard_theme("github-dark").unwrap();
        highlighter
    });
    let mut rows = Vec::new();
    let mut hashes = Vec::new();
    for pass in ["first", "reuse"] {
        for (index, doc) in documents.iter().enumerate() {
            let lang = doc["lang"].as_str().unwrap();
            let code = doc["code"].as_str().unwrap();
            assert_eq!(AssetDigest::of(code.as_bytes()).as_str(), doc["sha256"]);
            let (html, phases) = measure(|| {
                let tokens = highlighter
                    .tokenize(code, lang, "github-dark", &TokenizeOptions::default())
                    .unwrap();
                render_html(&tokens, &RenderOptions::default())
            });
            let hash = AssetDigest::of(html.as_bytes()).as_str().to_owned();
            if pass == "first" {
                hashes.push(hash);
            } else {
                assert_eq!(hash, hashes[index]);
            }
            rows.push(json!({"pass": pass, "language": lang, "measurement": phases}));
        }
    }
    println!(
        "{}",
        json!({"mode": args[4], "phaseClocks": true, "setup": setup,
            "rows": rows, "outputHashes": hashes, "diagnostics": highlighter.regex_diagnostics()})
    );
}
