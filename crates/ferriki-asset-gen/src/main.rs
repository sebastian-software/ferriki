use ferriki_asset_gen::{AssetSourceRef, generate_catalogs_from_upstream};
use std::env;
use std::path::PathBuf;

const USAGE: &str = "\
Usage:
  ferriki-asset-gen generate --upstream-dir <path> --output-dir <path> [--source-version <version>] [--source-commit <commit>]
";

fn main() {
  if let Err(err) = run(env::args().skip(1).collect()) {
    eprintln!("{err}");
    std::process::exit(1);
  }
}

fn run(args: Vec<String>) -> Result<(), String> {
  let command = args.first().map(String::as_str).ok_or_else(|| USAGE.to_owned())?;
  if command != "generate" {
    return Err(format!("unknown command: {command}\n\n{USAGE}"));
  }

  let opts = parse_generate_args(&args[1..])?;
  let source = AssetSourceRef {
    upstream: "textmate-grammars-themes".to_owned(),
    version: opts.source_version,
    commit: opts.source_commit,
  };

  generate_catalogs_from_upstream(&opts.upstream_dir, &opts.output_dir, source)
    .map_err(|err| format!("generation failed: {err}"))?;

  Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GenerateOptions {
  upstream_dir: PathBuf,
  output_dir: PathBuf,
  source_version: Option<String>,
  source_commit: Option<String>,
}

fn parse_generate_args(args: &[String]) -> Result<GenerateOptions, String> {
  let mut upstream_dir = None;
  let mut output_dir = None;
  let mut source_version = None;
  let mut source_commit = None;

  let mut index = 0;
  while index < args.len() {
    let flag = args[index].as_str();
    let value = args
      .get(index + 1)
      .ok_or_else(|| format!("missing value for {flag}\n\n{USAGE}"))?;

    match flag {
      "--upstream-dir" => upstream_dir = Some(PathBuf::from(value)),
      "--output-dir" => output_dir = Some(PathBuf::from(value)),
      "--source-version" => source_version = Some(value.clone()),
      "--source-commit" => source_commit = Some(value.clone()),
      _ => return Err(format!("unknown flag: {flag}\n\n{USAGE}")),
    }

    index += 2;
  }

  Ok(GenerateOptions {
    upstream_dir: upstream_dir.ok_or_else(|| format!("missing --upstream-dir\n\n{USAGE}"))?,
    output_dir: output_dir.ok_or_else(|| format!("missing --output-dir\n\n{USAGE}"))?,
    source_version,
    source_commit,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use ferriki_asset_gen::{decode_language_manifest, decode_theme_manifest};
  use std::fs;
  use std::path::Path;
  use std::time::{SystemTime, UNIX_EPOCH};

  fn temp_output_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("clock")
      .as_nanos();
    std::env::temp_dir().join(format!("ferriki-{label}-{nanos}"))
  }

  #[test]
  fn parse_generate_args_requires_paths() {
    let err = parse_generate_args(&[]).expect_err("missing args");
    assert!(err.contains("--upstream-dir"));
  }

  #[test]
  fn run_generate_writes_catalogs() {
    let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("tests/fixtures/upstream/textmate-grammars-themes");
    let output_dir = temp_output_dir("cli-generate");
    let args = vec![
      "generate".to_owned(),
      "--upstream-dir".to_owned(),
      upstream_dir.display().to_string(),
      "--output-dir".to_owned(),
      output_dir.display().to_string(),
      "--source-version".to_owned(),
      "1.0.0".to_owned(),
      "--source-commit".to_owned(),
      "abc123".to_owned(),
    ];

    run(args).expect("run");

    let language_manifest = decode_language_manifest(
      &fs::read(output_dir.join("languages/manifest.fkindex")).expect("language manifest"),
    )
    .expect("decode language manifest");
    let theme_manifest =
      decode_theme_manifest(&fs::read(output_dir.join("themes/manifest.fkindex")).expect("theme manifest"))
        .expect("decode theme manifest");

    assert_eq!(language_manifest.entries.len(), 1);
    assert_eq!(theme_manifest.entries.len(), 1);
    assert_eq!(language_manifest.source.upstream, "textmate-grammars-themes");
    assert_eq!(theme_manifest.source.commit.as_deref(), Some("abc123"));

    fs::remove_dir_all(output_dir).expect("cleanup");
  }
}
