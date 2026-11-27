#![no_main]

use ferriki_fuzz::fuzz_theme_render;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: &[u8]| {
    fuzz_theme_render(input);
});
