//! Pins the release commit whose tree serves this crate's standard payloads.
//!
//! `cargo publish` writes `.cargo_vcs_info.json` with the commit it packaged,
//! which for a release is the tagged release commit. Builds from a checkout have
//! no such file; the `remote` feature then needs an explicit commit.

use std::fs;

fn main() {
    println!("cargo::rerun-if-changed=.cargo_vcs_info.json");
    let Ok(info) = fs::read_to_string(".cargo_vcs_info.json") else {
        return;
    };
    if let Some(commit) = sha1(&info) {
        println!("cargo::rustc-env=FERRIKI_RELEASE_COMMIT={commit}");
    }
}

/// Extracts `git.sha1` without a JSON parser, keeping the build script free of
/// dependencies. The value is 40 lowercase hexadecimal digits.
fn sha1(info: &str) -> Option<&str> {
    let rest = &info[info.find("\"sha1\"")? + "\"sha1\"".len()..];
    let start = rest.find('"')? + 1;
    let value = &rest[start..start + 40.min(rest.len() - start)];
    (value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(value)
}
