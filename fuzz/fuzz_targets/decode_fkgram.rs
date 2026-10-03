#![no_main]

use ferriki_asset_gen::decode_language_asset;
use ferriki_fuzz::MAX_ASSET_BYTES;
use ferriki_textmate::parse_raw_grammar;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: &[u8]| {
    let bytes = &input[..input.len().min(MAX_ASSET_BYTES)];
    if let Ok(asset) = decode_language_asset(bytes) {
        // The binary corpus seed is a valid .fkgram file, so this also exercises
        // the embedded grammar parse used after a successful asset load.
        let _ = parse_raw_grammar(&asset.grammar_json, Some("asset.json"));
    }
});
