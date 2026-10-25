use ferroni::scanner::PrecompiledEager;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc, time::Instant};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let root = Path::new(&args[1]);
    let cache = Path::new(&args[2]);
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("release-manifest.json")).unwrap())
            .unwrap();
    let mut pairs = Vec::new();
    let mut rows = Vec::new();
    for lang in args[3].split(',') {
        let meta = &manifest["assets"][format!("languages/{lang}.fkbc")]["decoded"];
        let start = Instant::now();
        let bytes =
            std::fs::read(cache.join("decoded").join(meta["sha256"].as_str().unwrap())).unwrap();
        let read_ms = start.elapsed().as_secs_f64() * 1000.;
        assert_eq!(bytes.len(), meta["size"].as_u64().unwrap() as usize);
        let start = Instant::now();
        let hash = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let hash_ms = start.elapsed().as_secs_f64() * 1000.;
        assert_eq!(hash, meta["sha256"].as_str().unwrap());
        assert_eq!(&bytes[..8], b"FKBC002\0");
        let scope = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        let program = u64::from_le_bytes(bytes[16..24].try_into().unwrap()) as usize;
        let start = Instant::now();
        let programs: Arc<[u8]> = Arc::from(&bytes[32 + scope..32 + scope + program]);
        let groups: Arc<[u8]> = Arc::from(&bytes[32 + scope + program..]);
        let copy_ms = start.elapsed().as_secs_f64() * 1000.;
        let start = Instant::now();
        let (pair, phases) = ferroni::scanner::load_profile::measure(|| {
            PrecompiledEager::from_bytes(programs, groups).unwrap()
        });
        let open_ms = start.elapsed().as_secs_f64() * 1000.;
        rows.push(json!({"language":lang,"decodedBytes":bytes.len(),"programBytes":program,"groupBytes":bytes.len()-32-scope-program,"groups":pair.len(),"readMs":read_ms,"hashMs":hash_ms,"copyMs":copy_ms,"openMs":open_ms,"openPhases":phases.iter().map(|p|json!({"phase":p.phase,"calls":p.calls,"inclusiveNs":p.inclusive_ns,"exclusiveNs":p.exclusive_ns})).collect::<Vec<_>>()}));
        pairs.push(pair);
    }
    println!("{}", json!({"phases":rows}));
    std::hint::black_box(pairs);
}
