#![no_main]

use ferriki_fuzz::fuzz_decorations;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: &[u8]| {
    fuzz_decorations(input);
});
