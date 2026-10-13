//! Compiles reviewed catalog metadata offline and records release provenance.
//!
//! `cargo publish` writes `.cargo_vcs_info.json` with the commit it packaged,
//! which for a release is the tagged release commit. Builds from a checkout have
//! no such file. Hash-addressed catalogs can download without a commit.

use std::fs;

fn main() {
    // Catalog metadata is reviewed in Git; large sources and payloads live in
    // immutable storage. Compilation needs neither Node nor a network request.
    println!("cargo::rerun-if-changed=assets/catalog.json");
    let catalog: serde_json::Value = serde_json::from_str(
        &fs::read_to_string("assets/catalog.json").expect("asset catalog lock"),
    )
    .expect("valid asset catalog lock");
    let languages: ferriki_asset_gen::LanguageManifest =
        serde_json::from_value(catalog["languages"].clone()).expect("language metadata");
    let themes: ferriki_asset_gen::ThemeManifest =
        serde_json::from_value(catalog["themes"].clone()).expect("theme metadata");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("build output"));
    fs::write(
        output.join("languages.fkindex"),
        ferriki_asset_gen::encode_language_manifest(&languages).expect("language index"),
    )
    .expect("write language index");
    fs::write(
        output.join("themes.fkindex"),
        ferriki_asset_gen::encode_theme_manifest(&themes).expect("theme index"),
    )
    .expect("write theme index");
    fs::write(
        output.join("release-manifest.json"),
        serde_json::to_string(&catalog["release"]).expect("release metadata"),
    )
    .expect("write release metadata");
    println!("cargo::rerun-if-changed=.cargo_vcs_info.json");
    let Ok(info) = fs::read_to_string(".cargo_vcs_info.json") else {
        return;
    };
    if let Some(commit) = sha1(&info) {
        println!("cargo::rustc-env=FERRIKI_RELEASE_COMMIT={commit}");
    }
}

/// Extracts the packaged source commit. The value is 40 hexadecimal digits.
fn sha1(info: &str) -> Option<&str> {
    let rest = &info[info.find("\"sha1\"")? + "\"sha1\"".len()..];
    let start = rest.find('"')? + 1;
    let value = &rest[start..start + 40.min(rest.len() - start)];
    (value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(value)
}
