#![no_main]

use ferriki_fuzz::fuzz_decode_precompiled_archives;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: &[u8]| {
    fuzz_decode_precompiled_archives(input);
});
