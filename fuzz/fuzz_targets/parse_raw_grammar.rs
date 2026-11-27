#![no_main]

use ferriki_fuzz::fuzz_parse_raw_grammar;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: &[u8]| {
    fuzz_parse_raw_grammar(input);
});
