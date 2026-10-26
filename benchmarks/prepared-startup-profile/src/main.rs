//! Separate diagnostic: normal cached-read shape versus File's specialized read,
//! followed by the same shared archive opener. Does not change the native addon.
use ferroni::scanner::{PrecompiledBytes, PrecompiledEager};
use serde_json::{Value, json};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::Instant;

fn millis(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn open(bytes: Vec<u8>) -> (PrecompiledEager, Vec<Value>) {
    assert!([b"FKBC002\0", b"FKBC003\0"].contains(&bytes[..8].try_into().unwrap()));
    let scope_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    let program_len = u64::from_le_bytes(bytes[16..24].try_into().unwrap()) as usize;
    let group_len = u64::from_le_bytes(bytes[24..32].try_into().unwrap()) as usize;
    let scope_end = 32_usize.checked_add(scope_len).unwrap();
    let program_end = scope_end.checked_add(program_len).unwrap();
    assert_eq!(program_end.checked_add(group_len), Some(bytes.len()));
    let image = PrecompiledBytes::new(bytes);
    let load = || {
        PrecompiledEager::from_shared_bytes(
            image.slice(scope_end..program_end).unwrap(),
            image.slice(program_end..image.len()).unwrap(),
        )
        .unwrap()
    };
    #[cfg(feature = "phases")]
    {
        let (archive, samples) = ferroni::scanner::load_profile::measure(load);
        let samples = samples
            .into_iter()
            .map(|sample| {
                json!({"phase": sample.phase, "calls": sample.calls,
                    "inclusiveMs": sample.inclusive_ns as f64 / 1e6,
                    "exclusiveMs": sample.exclusive_ns as f64 / 1e6})
            })
            .collect();
        (archive, samples)
    }
    #[cfg(not(feature = "phases"))]
    {
        (load(), Vec::new())
    }
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let inputs: Value = serde_json::from_slice(&fs::read(&args[1]).unwrap()).unwrap();
    let reader = args[2].as_str();
    assert!(["take", "file", "exact"].contains(&reader));
    let mut retained = Vec::new();
    let mut rows = Vec::new();
    for item in inputs.as_array().unwrap() {
        let path = Path::new(item["path"].as_str().unwrap());
        let size = item["bytes"].as_u64().unwrap();
        let started = Instant::now();
        let mut file = fs::File::open(path).unwrap();
        let before = file.metadata().unwrap();
        assert_eq!(before.len(), size);
        let size_usize = usize::try_from(size).unwrap();
        let mut bytes = if reader == "exact" {
            vec![0; size_usize]
        } else {
            Vec::with_capacity(size_usize)
        };
        if reader == "take" {
            // Same bounded reader and reservation as precompiled_cache::read.
            (&mut file).take(size).read_to_end(&mut bytes).unwrap();
        } else if reader == "file" {
            file.read_to_end(&mut bytes).unwrap();
        } else {
            file.read_exact(&mut bytes).unwrap();
        }
        assert_eq!(bytes.len() as u64, size);
        assert_eq!(
            before.modified().unwrap(),
            file.metadata().unwrap().modified().unwrap()
        );
        let read_ms = millis(started);
        let started = Instant::now();
        let (archive, samples) = open(bytes);
        let open_ms = millis(started);
        rows.push(json!({"language": item["language"], "bytes": size,
            "readMs": read_ms, "openMs": open_ms, "phases": samples}));
        retained.push(archive);
    }
    let read_ms: f64 = rows.iter().map(|r| r["readMs"].as_f64().unwrap()).sum();
    let open_ms: f64 = rows.iter().map(|r| r["openMs"].as_f64().unwrap()).sum();
    println!(
        "{}",
        json!({"reader": reader, "phaseClocks": cfg!(feature = "phases"),
        "readMs": read_ms, "openMs": open_ms, "rows": rows})
    );
    std::hint::black_box(retained);
}
