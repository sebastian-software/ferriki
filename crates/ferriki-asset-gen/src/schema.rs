use serde::{Deserialize, Serialize};
pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetSourceRef {
  pub upstream: String,
  pub version: Option<String>,
  pub commit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LanguageAssetEntry {
  pub id: String,
  pub scope_name: String,
  pub asset_file: String,
  pub display_name: Option<String>,
  pub aliases: Vec<String>,
  pub embedded_langs: Vec<String>,
  pub embedded_langs_lazy: Vec<String>,
  pub inject_to: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeAssetEntry {
  pub id: String,
  pub asset_file: String,
  pub display_name: Option<String>,
  pub theme_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LanguageManifest {
  pub format_version: u32,
  pub source: AssetSourceRef,
  pub entries: Vec<LanguageAssetEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeManifest {
  pub format_version: u32,
  pub source: AssetSourceRef,
  pub entries: Vec<ThemeAssetEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LanguageAsset {
  pub format_version: u32,
  pub id: String,
  pub scope_name: String,
  pub display_name: Option<String>,
  pub aliases: Vec<String>,
  pub embedded_langs: Vec<String>,
  pub embedded_langs_lazy: Vec<String>,
  pub inject_to: Vec<String>,
  pub grammar_json: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThemeAsset {
  pub format_version: u32,
  pub id: String,
  pub display_name: Option<String>,
  pub theme_type: Option<String>,
  pub theme_json: String,
}

pub fn encode_language_manifest(manifest: &LanguageManifest) -> Result<Vec<u8>, bincode::Error> {
  bincode::serialize(manifest)
}

pub fn decode_language_manifest(bytes: &[u8]) -> Result<LanguageManifest, bincode::Error> {
  bincode::deserialize(bytes)
}

pub fn encode_theme_manifest(manifest: &ThemeManifest) -> Result<Vec<u8>, bincode::Error> {
  bincode::serialize(manifest)
}

pub fn decode_theme_manifest(bytes: &[u8]) -> Result<ThemeManifest, bincode::Error> {
  bincode::deserialize(bytes)
}

pub fn encode_language_asset(asset: &LanguageAsset) -> Result<Vec<u8>, bincode::Error> {
  bincode::serialize(asset)
}

pub fn decode_language_asset(bytes: &[u8]) -> Result<LanguageAsset, bincode::Error> {
  bincode::deserialize(bytes)
}

pub fn encode_theme_asset(asset: &ThemeAsset) -> Result<Vec<u8>, bincode::Error> {
  bincode::serialize(asset)
}

pub fn decode_theme_asset(bytes: &[u8]) -> Result<ThemeAsset, bincode::Error> {
  bincode::deserialize(bytes)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn language_manifest_roundtrip_is_stable() {
    let manifest = LanguageManifest {
      format_version: FORMAT_VERSION,
      source: AssetSourceRef {
        upstream: "tm-grammars".to_owned(),
        version: Some("1.0.0".to_owned()),
        commit: Some("abc123".to_owned()),
      },
      entries: vec![
        LanguageAssetEntry {
          id: "javascript".to_owned(),
          scope_name: "source.js".to_owned(),
          asset_file: "javascript.fkgram".to_owned(),
          display_name: Some("JavaScript".to_owned()),
          aliases: vec!["js".to_owned(), "mjs".to_owned()],
          embedded_langs: vec!["regex".to_owned()],
          embedded_langs_lazy: vec!["css".to_owned()],
          inject_to: vec!["text.html.markdown".to_owned()],
        },
      ],
    };

    let encoded = encode_language_manifest(&manifest).expect("encode");
    let decoded = decode_language_manifest(&encoded).expect("decode");
    let reencoded = encode_language_manifest(&decoded).expect("reencode");

    assert_eq!(decoded, manifest);
    assert_eq!(reencoded, encoded);
  }

  #[test]
  fn theme_manifest_roundtrip_is_stable() {
    let manifest = ThemeManifest {
      format_version: FORMAT_VERSION,
      source: AssetSourceRef {
        upstream: "tm-themes".to_owned(),
        version: Some("2.0.0".to_owned()),
        commit: Some("def456".to_owned()),
      },
      entries: vec![
        ThemeAssetEntry {
          id: "vitesse-light".to_owned(),
          asset_file: "vitesse-light.fktheme".to_owned(),
          display_name: Some("Vitesse Light".to_owned()),
          theme_type: Some("light".to_owned()),
        },
      ],
    };

    let encoded = encode_theme_manifest(&manifest).expect("encode");
    let decoded = decode_theme_manifest(&encoded).expect("decode");
    let reencoded = encode_theme_manifest(&decoded).expect("reencode");

    assert_eq!(decoded, manifest);
    assert_eq!(reencoded, encoded);
  }

  #[test]
  fn language_asset_roundtrip_is_stable() {
    let asset = LanguageAsset {
      format_version: FORMAT_VERSION,
      id: "javascript".to_owned(),
      scope_name: "source.js".to_owned(),
      display_name: Some("JavaScript".to_owned()),
      aliases: vec!["js".to_owned()],
      embedded_langs: vec!["regex".to_owned()],
      embedded_langs_lazy: vec!["css".to_owned()],
      inject_to: vec!["text.html.markdown".to_owned()],
      grammar_json: r##"{"scopeName":"source.js","patterns":[{"include":"#expression"}]}"##.to_owned(),
    };

    let encoded = encode_language_asset(&asset).expect("encode");
    let decoded = decode_language_asset(&encoded).expect("decode");
    let reencoded = encode_language_asset(&decoded).expect("reencode");

    assert_eq!(decoded, asset);
    assert_eq!(reencoded, encoded);
  }

  #[test]
  fn theme_asset_roundtrip_is_stable() {
    let asset = ThemeAsset {
      format_version: FORMAT_VERSION,
      id: "vitesse-light".to_owned(),
      display_name: Some("Vitesse Light".to_owned()),
      theme_type: Some("light".to_owned()),
      theme_json: r##"{"name":"Vitesse Light","type":"light","colors":{"editor.foreground":"#393a34"}}"##.to_owned(),
    };

    let encoded = encode_theme_asset(&asset).expect("encode");
    let decoded = decode_theme_asset(&encoded).expect("decode");
    let reencoded = encode_theme_asset(&decoded).expect("reencode");

    assert_eq!(decoded, asset);
    assert_eq!(reencoded, encoded);
  }
}
