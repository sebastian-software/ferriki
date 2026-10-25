use ferroni::oniguruma::ONIG_OPTION_CAPTURE_GROUP;
use ferroni::scanner::{OnigString, PrecompiledEager, ScannerFindOptions, ScannerSyntax};
use ferroni::{AccelerationMode, Scanner, ScannerConfig, ScannerPatternCache};
use serde_json::{Value, json};
use std::{hint::black_box, time::Instant};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let mode = &args[1];
    let patterns: Vec<String> = serde_json::from_slice(&std::fs::read(&args[2]).unwrap()).unwrap();
    let refs: Vec<_> = patterns.iter().map(String::as_str).collect();
    let queries: Vec<Value> = serde_json::from_slice(&std::fs::read(&args[3]).unwrap()).unwrap();
    let subjects: Vec<_> = queries
        .iter()
        .map(|q| OnigString::new(q["text"].as_str().unwrap()))
        .collect();
    let config = ScannerConfig::default()
        .options(ONIG_OPTION_CAPTURE_GROUP)
        .syntax(ScannerSyntax::Oniguruma)
        .prefilter(true)
        .acceleration(AccelerationMode::Eager);
    let mut producer = ScannerPatternCache::new();
    Scanner::with_pattern_cache(&refs, &config, &mut producer).unwrap();
    let exported = producer.export_precompiled_eager().unwrap();
    let program_bytes = exported.program_bytes().len();
    let group_bytes = exported.group_bytes().len();
    let mut cache = ScannerPatternCache::new();
    let started = Instant::now();
    let pair = if mode == "prepared" {
        let p =
            PrecompiledEager::from_bytes(exported.program_bytes(), exported.group_bytes()).unwrap();
        cache.add_precompiled_eager(p.clone());
        Some(p)
    } else {
        None
    };
    let config = if mode == "off" {
        config.acceleration(AccelerationMode::Off)
    } else {
        config
    };
    let mut scanner = Scanner::with_pattern_cache(&refs, &config, &mut cache).unwrap();
    let build_ms = started.elapsed().as_secs_f64() * 1000.;
    let initial = format!("{:?}", scanner.prefilter_stats());
    for (q, subject) in queries.iter().zip(&subjects) {
        let found = scanner.find_next_match_utf16(
            subject,
            q["start"].as_u64().unwrap() as usize,
            ScannerFindOptions::from_bits(q["options"].as_u64().unwrap() as u32),
        );
        let actual=found.map(|m|json!({"index":m.index,"captures":m.captures().iter().map(|c|(c.start,c.end)).collect::<Vec<_>>()}));
        assert_eq!(actual.as_ref().unwrap_or(&Value::Null), &q["expected"]);
    }
    let run = |scanner: &mut Scanner| {
        let mut checksum = 0usize;
        for (q, subject) in queries.iter().zip(&subjects) {
            if let Some(m) = scanner.find_next_match_utf16(
                subject,
                q["start"].as_u64().unwrap() as usize,
                ScannerFindOptions::from_bits(q["options"].as_u64().unwrap() as u32),
            ) {
                checksum = checksum.wrapping_add(m.index + 1);
                for c in m.captures() {
                    checksum = checksum.wrapping_add(c.start).wrapping_add(c.end);
                }
            }
        }
        black_box(checksum)
    };
    for _ in 0..5 {
        run(&mut scanner);
    }
    let before = format!("{:?}", scanner.prefilter_stats());
    let mut samples = Vec::new();
    let mut checksum = 0;
    for _ in 0..20 {
        let start = Instant::now();
        checksum = run(&mut scanner);
        samples.push(start.elapsed().as_secs_f64() * 1000.);
    }
    println!(
        "{}",
        json!({"mode":mode,"queries":queries.len(),"programBytes":program_bytes,"groupBytes":group_bytes,"buildMs":build_ms,"initial":initial,"beforeTimed":before,"afterTimed":format!("{:?}",scanner.prefilter_stats()),"samplesMs":samples,"checksum":checksum,"loadedGroups":pair.as_ref().map(|p|p.stats().loaded_groups),"invalidGroups":pair.as_ref().map(|p|p.stats().invalid_groups)})
    );
}
