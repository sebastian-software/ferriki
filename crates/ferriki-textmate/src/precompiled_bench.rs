//! Explicit diagnostic: source Off loading versus prepared Eager loading,
//! with ordinary Eager as the execution reference. Not a CI timing gate.

use crate::grammar::{Grammar, GrammarConfiguration, ThemeProvider};
use crate::parse_raw_grammar;
use crate::precompiled::prepare;
use crate::regexp::ScannerPatternCache;
use crate::rule_factory::GrammarStore;
use crate::theme::Theme;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::hint::black_box;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

fn tokenize(grammar: &Grammar, code: &str) -> Vec<Vec<u32>> {
    let mut state = None;
    code.lines()
        .map(|line| {
            let result = grammar.tokenize_line2(line, state.take(), 0).unwrap();
            state = Some(result.rule_stack);
            result.tokens
        })
        .collect()
}

fn summary(mut samples: Vec<f64>) -> serde_json::Value {
    let raw = samples.clone();
    samples.sort_by(f64::total_cmp);
    let middle = samples.len() / 2;
    let median = if samples.len().is_multiple_of(2) {
        (samples[middle - 1] + samples[middle]) / 2.0
    } else {
        samples[middle]
    };
    json!({"median_ms": median, "min_ms": samples[0], "max_ms": samples[samples.len()-1], "samples_ms": raw})
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
#[ignore = "explicit release-mode performance diagnostic"]
fn prepared_eager_startup() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut cases = Vec::new();
    for (language, file) in [
        ("cpp", "orders.cpp"),
        ("swift", "Orders.swift"),
        ("rust", "orders.rs"),
        ("python", "orders.py"),
        ("json", "orders.json"),
        ("css", "orders.css"),
        ("typescript", "orders.ts"),
    ] {
        let source = std::fs::read_to_string(
            root.join("assets/upstream/curated/grammars")
                .join(format!("{language}.json")),
        )
        .unwrap();
        let raw = Arc::new(parse_raw_grammar(&source, Some("grammar.json")).unwrap());
        let code =
            std::fs::read_to_string(root.join("node/benchmarks/curated/fixtures").join(file))
                .unwrap();
        let mut provider = GrammarStore::new();
        provider.insert_shared(Arc::clone(&raw));
        let sampled = prepare(&raw, &provider, &[&code]).unwrap();
        let complete = prepare(&raw, &provider, &[]).unwrap();
        let archives = [None, None, Some(&sampled), Some(&complete)];
        let names = [
            "source-off",
            "source-eager",
            "prepared-sampled",
            "prepared-static",
        ];
        let digests: Vec<_> = archives.iter().map(|a| a.map(Sha256::digest)).collect();
        let construct = |lane: usize| {
            let cache = if lane == 1 {
                ScannerPatternCache::for_preparation()
            } else {
                ScannerPatternCache::new()
            }
            .for_scope(&raw.scope_name);
            if let Some(archive) = archives[lane] {
                assert_eq!(Some(Sha256::digest(archive)), digests[lane]);
                cache.add_precompiled(archive.clone()).unwrap();
            }
            let grammar = Grammar::with_theme_provider(
                &raw,
                &provider,
                ThemeProvider::new(Theme::create_from_raw_theme(None, None).unwrap()),
                GrammarConfiguration::default().with_regex_prefilter(lane != 0),
                cache.clone(),
            );
            (grammar, cache)
        };
        let expected = tokenize(&construct(0).0, &code);
        let mut setup = vec![Vec::new(); 4];
        let mut first = vec![Vec::new(); 4];
        let mut startup = vec![Vec::new(); 4];
        let mut groups = [0; 4];
        for round in 0..21 {
            for offset in 0..4 {
                let lane = (round + offset) % 4;
                let start = Instant::now();
                let (grammar, cache) = construct(lane);
                let ready = start.elapsed().as_secs_f64() * 1000.0;
                let first_start = Instant::now();
                let actual = black_box(tokenize(&grammar, &code));
                let document = first_start.elapsed().as_secs_f64() * 1000.0;
                let total = start.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(actual, expected, "{language}/{}", names[lane]);
                if lane >= 2 {
                    let (loaded, invalid) = cache.prepared_stats(&raw.scope_name);
                    assert!(loaded > 0, "archive must actually supply groups");
                    assert_eq!(invalid, 0);
                    assert_eq!(
                        cache.assembly_fallbacks(),
                        0,
                        "{language}/{} must use the prepared scanner without assembly fallback",
                        names[lane]
                    );
                    groups[lane] = loaded;
                }
                if round > 0 {
                    setup[lane].push(ready);
                    first[lane].push(document);
                    startup[lane].push(total);
                }
            }
        }
        // Reuse each grammar, with exactly three warm documents in every lane.
        // This compares execution policies, without waiting for Auto thresholds.
        let grammars: Vec<_> = (0..4).map(|lane| construct(lane).0).collect();
        for grammar in &grammars {
            for _ in 0..3 {
                assert_eq!(tokenize(grammar, &code), expected);
            }
        }
        let mut warm = vec![Vec::new(); 4];
        let start = Instant::now();
        let mut round = 0;
        while round < 5000 && (round < 30 || start.elapsed().as_secs_f64() < 0.8) {
            for offset in 0..4 {
                let lane = (round + offset) % 4;
                let start = Instant::now();
                black_box(tokenize(&grammars[lane], &code));
                warm[lane].push(start.elapsed().as_secs_f64() * 1000.0);
            }
            round += 1;
        }
        let results: Vec<_> = (0..4).map(|lane| json!({"lane": names[lane], "setup": summary(setup[lane].clone()), "first_document": summary(first[lane].clone()), "startup":summary(startup[lane].clone()), "execution":summary(warm[lane].clone()), "loaded_groups":groups[lane], "active_prefilters":grammars[lane].prefilter_stats().iter().filter(|s| s.built).count()})).collect();
        println!(
            "{language}: {}",
            results
                .iter()
                .map(|r| format!(
                    "{} startup={:.3} execution={:.3}",
                    r["lane"].as_str().unwrap(),
                    r["startup"]["median_ms"].as_f64().unwrap(),
                    r["execution"]["median_ms"].as_f64().unwrap()
                ))
                .collect::<Vec<_>>()
                .join("; ")
        );
        cases.push(json!({"language":language,"fixture":file,"fixture_sha256":sha256_hex(code.as_bytes()),"grammar_sha256":sha256_hex(source.as_bytes()),"bytes":code.len(),"sampled_archive_bytes":sampled.len(),"static_archive_bytes":complete.len(),"results":results}));
    }
    let lock = std::fs::read_to_string(root.join("Cargo.lock")).unwrap();
    let ferroni_version = lock
        .split("[[package]]")
        .find(|package| package.lines().any(|line| line == "name = \"ferroni\""))
        .and_then(|package| {
            package.lines().find_map(|line| {
                line.strip_prefix("version = \"")
                    .and_then(|version| version.strip_suffix('"'))
            })
        })
        .expect("Ferroni version in the workspace lockfile");
    let report = json!({"ferroni":ferroni_version,"transport":"Zstd 19 / FKBC002 / Ferroni program v2 + group v3", "os":std::env::consts::OS,"arch":std::env::consts::ARCH,"profile":"release fat LTO, one codegen unit", "startup_pairs":20, "warmup_documents":3,"minimum_execution_rounds":30,"maximum_execution_rounds":5000,"budget_ms_per_case":800,"order":"rotate lanes each round", "boundary":"setup includes compressed SHA256, buffer copy, bounded decompression, pair opening, theme and grammar construction; startup adds first full tokenize_line2 document; execution retains grammar and resets document stack; excludes file/network I/O, grammar JSON parsing and teardown", "cases":cases});
    if let Ok(path) = std::env::var("FERRIKI_BENCH_OUTPUT") {
        std::fs::write(path, serde_json::to_string(&report).unwrap()).unwrap();
    }
}
