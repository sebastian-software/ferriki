#![no_main]

use ferriki_fuzz::fuzz_deserialize_state_stack;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: &[u8]| {
    fuzz_deserialize_state_stack(input);
});
