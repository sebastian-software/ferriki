use crate::schema::{
  encode_language_asset,
  encode_language_manifest,
  encode_theme_asset,
  encode_theme_manifest,
  AssetSourceRef,
  LanguageAsset,
  LanguageAssetEntry,
  LanguageManifest,
  ThemeAsset,
  ThemeAssetEntry,
  ThemeManifest,
  FORMAT_VERSION,
};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const LANGUAGE_MANIFEST_FILE: &str = "manifest.fkindex";
const THEME_MANIFEST_FILE: &str = "manifest.fkindex";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedCatalog {
  pub manifest_path: PathBuf,
  pub asset_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanguageSourceRecord {
  pub id: String,
  pub scope_name: String,
  pub display_name: Option<String>,
  pub aliases: Vec<String>,
  pub embedded_langs: Vec<String>,
  pub embedded_langs_lazy: Vec<String>,
  pub inject_to: Vec<String>,
  pub grammar_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeSourceRecord {
  pub id: String,
  pub display_name: Option<String>,
  pub theme_type: Option<String>,
  pub theme_json: String,
}

pub fn write_language_catalog(
  output_dir: &Path,
  source: AssetSourceRef,
  records: &[LanguageSourceRecord],
) -> io::Result<GeneratedCatalog> {
  fs::create_dir_all(output_dir)?;
  let mut entries = Vec::with_capacity(records.len());
  let mut asset_paths = Vec::with_capacity(records.len());

  for record in records {
    let asset_file = format!("{}.fkgram", sanitize_asset_id(&record.id));
    let asset = LanguageAsset {
      format_version: FORMAT_VERSION,
      id: record.id.clone(),
      scope_name: record.scope_name.clone(),
      display_name: record.display_name.clone(),
      aliases: record.aliases.clone(),
      embedded_langs: record.embedded_langs.clone(),
      embedded_langs_lazy: record.embedded_langs_lazy.clone(),
      inject_to: record.inject_to.clone(),
      grammar_json: record.grammar_json.clone(),
    };
    let bytes = encode_language_asset(&asset)
      .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    let asset_path = output_dir.join(&asset_file);
    fs::write(&asset_path, bytes)?;
    asset_paths.push(asset_path);

    entries.push(LanguageAssetEntry {
      id: record.id.clone(),
      scope_name: record.scope_name.clone(),
      asset_file,
      display_name: record.display_name.clone(),
      aliases: record.aliases.clone(),
      embedded_langs: record.embedded_langs.clone(),
      embedded_langs_lazy: record.embedded_langs_lazy.clone(),
      inject_to: record.inject_to.clone(),
    });
  }

  entries.sort_by(|a, b| a.id.cmp(&b.id));
  let manifest = LanguageManifest {
    format_version: FORMAT_VERSION,
    source,
    entries,
  };
  let manifest_path = output_dir.join(LANGUAGE_MANIFEST_FILE);
  let manifest_bytes = encode_language_manifest(&manifest)
    .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
  fs::write(&manifest_path, manifest_bytes)?;

  Ok(GeneratedCatalog {
    manifest_path,
    asset_paths,
  })
}

pub fn write_theme_catalog(
  output_dir: &Path,
  source: AssetSourceRef,
  records: &[ThemeSourceRecord],
) -> io::Result<GeneratedCatalog> {
  fs::create_dir_all(output_dir)?;
  let mut entries = Vec::with_capacity(records.len());
  let mut asset_paths = Vec::with_capacity(records.len());

  for record in records {
    let asset_file = format!("{}.fktheme", sanitize_asset_id(&record.id));
    let asset = ThemeAsset {
      format_version: FORMAT_VERSION,
      id: record.id.clone(),
      display_name: record.display_name.clone(),
      theme_type: record.theme_type.clone(),
      theme_json: record.theme_json.clone(),
    };
    let bytes = encode_theme_asset(&asset)
      .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    let asset_path = output_dir.join(&asset_file);
    fs::write(&asset_path, bytes)?;
    asset_paths.push(asset_path);

    entries.push(ThemeAssetEntry {
      id: record.id.clone(),
      asset_file,
      display_name: record.display_name.clone(),
      theme_type: record.theme_type.clone(),
    });
  }

  entries.sort_by(|a, b| a.id.cmp(&b.id));
  let manifest = ThemeManifest {
    format_version: FORMAT_VERSION,
    source,
    entries,
  };
  let manifest_path = output_dir.join(THEME_MANIFEST_FILE);
  let manifest_bytes = encode_theme_manifest(&manifest)
    .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
  fs::write(&manifest_path, manifest_bytes)?;

  Ok(GeneratedCatalog {
    manifest_path,
    asset_paths,
  })
}

fn sanitize_asset_id(id: &str) -> String {
  let mut out = String::with_capacity(id.len());
  for ch in id.chars() {
    if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
      out.push(ch);
    } else {
      out.push('_');
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::schema::{
    decode_language_asset,
    decode_language_manifest,
    decode_theme_asset,
    decode_theme_manifest,
  };
  use std::time::{SystemTime, UNIX_EPOCH};

  fn temp_output_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("clock")
      .as_nanos();
    std::env::temp_dir().join(format!("ferriki-{label}-{nanos}"))
  }

  #[test]
  fn write_language_catalog_emits_manifest_and_assets() {
    let output_dir = temp_output_dir("language-catalog");
    let source = AssetSourceRef {
      upstream: "textmate-grammars-themes".to_owned(),
      version: Some("1.0.0".to_owned()),
      commit: Some("abc123".to_owned()),
    };
    let records = vec![LanguageSourceRecord {
      id: "javascript".to_owned(),
      scope_name: "source.js".to_owned(),
      display_name: Some("JavaScript".to_owned()),
      aliases: vec!["js".to_owned()],
      embedded_langs: vec!["regex".to_owned()],
      embedded_langs_lazy: vec!["css".to_owned()],
      inject_to: vec!["text.html.markdown".to_owned()],
      grammar_json: r##"{"scopeName":"source.js"}"##.to_owned(),
    }];

    let generated = write_language_catalog(&output_dir, source.clone(), &records).expect("write");
    let manifest_bytes = fs::read(&generated.manifest_path).expect("manifest read");
    let manifest = decode_language_manifest(&manifest_bytes).expect("manifest decode");
    let asset_bytes = fs::read(&generated.asset_paths[0]).expect("asset read");
    let asset = decode_language_asset(&asset_bytes).expect("asset decode");

    assert_eq!(manifest.source, source);
    assert_eq!(manifest.entries.len(), 1);
    assert_eq!(manifest.entries[0].id, "javascript");
    assert_eq!(asset.id, "javascript");
    assert_eq!(asset.scope_name, "source.js");

    fs::remove_dir_all(output_dir).expect("cleanup");
  }

  #[test]
  fn write_theme_catalog_emits_manifest_and_assets() {
    let output_dir = temp_output_dir("theme-catalog");
    let source = AssetSourceRef {
      upstream: "textmate-grammars-themes".to_owned(),
      version: Some("2.0.0".to_owned()),
      commit: Some("def456".to_owned()),
    };
    let records = vec![ThemeSourceRecord {
      id: "vitesse-light".to_owned(),
      display_name: Some("Vitesse Light".to_owned()),
      theme_type: Some("light".to_owned()),
      theme_json: r##"{"name":"Vitesse Light"}"##.to_owned(),
    }];

    let generated = write_theme_catalog(&output_dir, source.clone(), &records).expect("write");
    let manifest_bytes = fs::read(&generated.manifest_path).expect("manifest read");
    let manifest = decode_theme_manifest(&manifest_bytes).expect("manifest decode");
    let asset_bytes = fs::read(&generated.asset_paths[0]).expect("asset read");
    let asset = decode_theme_asset(&asset_bytes).expect("asset decode");

    assert_eq!(manifest.source, source);
    assert_eq!(manifest.entries.len(), 1);
    assert_eq!(manifest.entries[0].id, "vitesse-light");
    assert_eq!(asset.id, "vitesse-light");
    assert_eq!(asset.theme_type.as_deref(), Some("light"));

    fs::remove_dir_all(output_dir).expect("cleanup");
  }
}
