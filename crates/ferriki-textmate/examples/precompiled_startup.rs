//! Small fresh-registry smoke diagnostic; the full Off/Eager matrix is the
//! ignored precompiled_bench::prepared_eager_startup release test.
//! Run in release mode with a grammar JSON path and a source fixture path.

use ferriki_textmate::{
    GrammarConfiguration, RawGrammar, SyncRegistry, parse_raw_grammar, precompile_grammar_patterns,
};
use std::hint::black_box;
use std::time::Instant;

fn tokenize(
    raw: &RawGrammar,
    archive: Option<&[u8]>,
    code: &str,
    prefilter: bool,
) -> Vec<Vec<u32>> {
    let mut registry = SyncRegistry::new(None, None).unwrap();
    if let Some(archive) = archive {
        registry.add_precompiled_patterns(archive.to_vec()).unwrap();
    }
    registry.add_grammar(raw.clone(), vec![]);
    let grammar = registry
        .grammar_for_scope_name(
            &raw.scope_name,
            GrammarConfiguration::default().with_regex_prefilter(prefilter),
        )
        .unwrap()
        .unwrap();
    let mut state = None;
    code.lines()
        .map(|line| {
            let result = grammar.tokenize_line2(line, state.take(), 0).unwrap();
            state = Some(result.rule_stack);
            result.tokens
        })
        .collect()
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert!(
        args.len() == 3 || (args.len() == 4 && args[3] == "--sampled"),
        "usage: precompiled_startup <grammar.json> <fixture> [--sampled]"
    );
    let sampled = args.len() == 4;
    let source = std::fs::read_to_string(&args[1]).unwrap();
    let raw = parse_raw_grammar(&source, Some("grammar.json")).unwrap();
    let code = std::fs::read_to_string(&args[2]).unwrap();
    let started = Instant::now();
    let archive = if sampled {
        let mut producer = SyncRegistry::new(None, None).unwrap();
        producer.add_grammar(raw.clone(), vec![]);
        producer
            .precompile_patterns(&raw.scope_name, &[&code])
            .unwrap()
            .unwrap()
    } else {
        precompile_grammar_patterns(&raw).unwrap()
    };
    println!(
        "{}: sampled={sampled}, source={} bytes, archive={} bytes, preparation={:.2} ms",
        raw.scope_name,
        source.len(),
        archive.len(),
        started.elapsed().as_secs_f64() * 1000.0
    );
    for prefilter in [false, true] {
        assert_eq!(
            tokenize(&raw, None, &code, prefilter),
            tokenize(&raw, Some(&archive), &code, prefilter)
        );
        let mut source_times = Vec::new();
        let mut archive_times = Vec::new();
        for sample in 0..21 {
            for prepared in if sample % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            } {
                let started = Instant::now();
                black_box(tokenize(
                    &raw,
                    prepared.then_some(archive.as_slice()),
                    &code,
                    prefilter,
                ));
                let ms = started.elapsed().as_secs_f64() * 1000.0;
                if sample > 0 {
                    // One untimed warmup pair; each sample has a fresh registry.
                    if prepared {
                        archive_times.push(ms);
                    } else {
                        source_times.push(ms);
                    }
                }
            }
        }
        for (label, mut times) in [("source", source_times), ("archive", archive_times)] {
            times.sort_by(f64::total_cmp);
            println!(
                "prefilter={prefilter} {label}: median={:.3} ms range={:.3}..{:.3} ms n={}",
                times[times.len() / 2],
                times[0],
                times[times.len() - 1],
                times.len()
            );
        }
    }
}
