use crate::generate::{LanguageSourceRecord, ThemeSourceRecord};
use serde::Deserialize;
use std::fs;
use std::io;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct UpstreamLanguageCatalog {
  pub languages: Vec<UpstreamLanguageMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct UpstreamLanguageMeta {
  pub id: String,
  pub grammar_file: String,
  pub scope_name: String,
  pub display_name: Option<String>,
  #[serde(default)]
  pub aliases: Vec<String>,
  #[serde(default)]
  pub embedded_langs: Vec<String>,
  #[serde(default)]
  pub embedded_langs_lazy: Vec<String>,
  #[serde(default)]
  pub inject_to: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct UpstreamThemeCatalog {
  pub themes: Vec<UpstreamThemeMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct UpstreamThemeMeta {
  pub id: String,
  pub theme_file: String,
  pub display_name: Option<String>,
  pub theme_type: Option<String>,
}

pub fn load_language_records_from_upstream(source_dir: &Path) -> io::Result<Vec<LanguageSourceRecord>> {
  let catalog_path = source_dir.join("languages.json");
  let catalog = read_json::<UpstreamLanguageCatalog>(&catalog_path)?;
  let mut records = Vec::with_capacity(catalog.languages.len());

  for language in catalog.languages {
    let grammar_path = source_dir.join("grammars").join(&language.grammar_file);
    let grammar_json = fs::read_to_string(&grammar_path)?;
    records.push(LanguageSourceRecord {
      id: language.id,
      scope_name: language.scope_name,
      display_name: language.display_name,
      aliases: language.aliases,
      embedded_langs: language.embedded_langs,
      embedded_langs_lazy: language.embedded_langs_lazy,
      inject_to: language.inject_to,
      grammar_json,
    });
  }

  records.sort_by(|a, b| a.id.cmp(&b.id));
  Ok(records)
}

pub fn load_theme_records_from_upstream(source_dir: &Path) -> io::Result<Vec<ThemeSourceRecord>> {
  let catalog_path = source_dir.join("themes.json");
  let catalog = read_json::<UpstreamThemeCatalog>(&catalog_path)?;
  let mut records = Vec::with_capacity(catalog.themes.len());

  for theme in catalog.themes {
    let theme_path = source_dir.join("themes").join(&theme.theme_file);
    let theme_json = fs::read_to_string(&theme_path)?;
    records.push(ThemeSourceRecord {
      id: theme.id,
      display_name: theme.display_name,
      theme_type: theme.theme_type,
      theme_json,
    });
  }

  records.sort_by(|a, b| a.id.cmp(&b.id));
  Ok(records)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> io::Result<T> {
  let raw = fs::read_to_string(path)?;
  serde_json::from_str::<T>(&raw).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn loads_language_records_from_upstream_layout() {
    let source_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("tests/fixtures/upstream/textmate-grammars-themes");
    let records = load_language_records_from_upstream(&source_dir).expect("load");

    assert_eq!(records.len(), 1);
    assert_eq!(records[0].id, "javascript");
    assert_eq!(records[0].scope_name, "source.js");
    assert_eq!(records[0].aliases, vec!["js".to_owned(), "mjs".to_owned()]);
    assert!(records[0].grammar_json.contains("\"scopeName\": \"source.js\""));
  }

  #[test]
  fn loads_theme_records_from_upstream_layout() {
    let source_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("tests/fixtures/upstream/textmate-grammars-themes");
    let records = load_theme_records_from_upstream(&source_dir).expect("load");

    assert_eq!(records.len(), 1);
    assert_eq!(records[0].id, "vitesse-light");
    assert_eq!(records[0].theme_type.as_deref(), Some("light"));
    assert!(records[0].theme_json.contains("\"name\": \"Vitesse Light\""));
  }
}
