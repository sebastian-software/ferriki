use crate::generate::{LanguageSourceRecord, ThemeSourceRecord};
use serde::Deserialize;
use serde_json::{Value, json};
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
    let grammar_json = normalize_language_grammar_json(
      &fs::read_to_string(&grammar_path)?,
      &language.id,
    )?;
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
    let theme_json = normalize_theme_json(&fs::read_to_string(&theme_path)?, &theme.id)?;
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

fn normalize_theme_json(raw: &str, fallback_name: &str) -> io::Result<String> {
  let value: Value = serde_json::from_str(raw)
    .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
  let Some(obj) = value.as_object() else {
    return Err(io::Error::new(
      io::ErrorKind::InvalidData,
      "Theme JSON must be an object.",
    ));
  };

  if obj.contains_key("fg") && obj.contains_key("bg") && obj.contains_key("settings") {
    return serde_json::to_string(&value)
      .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err));
  }

  let colors = obj.get("colors").and_then(Value::as_object);
  let fg = colors
    .and_then(|c| c.get("editor.foreground"))
    .and_then(Value::as_str)
    .unwrap_or_default();
  let bg = colors
    .and_then(|c| c.get("editor.background"))
    .and_then(Value::as_str)
    .unwrap_or_default();

  let mut settings = Vec::new();
  let token_colors = obj
    .get("tokenColors")
    .and_then(Value::as_array)
    .or_else(|| obj.get("settings").and_then(Value::as_array));

  if let Some(entries) = token_colors {
    for entry in entries {
      let Some(entry_obj) = entry.as_object() else { continue };
      let Some(raw_settings) = entry_obj.get("settings").and_then(Value::as_object) else {
        continue;
      };

      let scopes = match entry_obj.get("scope") {
        Some(Value::String(scope)) => scope
          .split(',')
          .map(str::trim)
          .filter(|scope| !scope.is_empty())
          .map(str::to_owned)
          .collect::<Vec<_>>(),
        Some(Value::Array(scopes)) => scopes
          .iter()
          .filter_map(|scope| scope.as_str().map(str::trim).filter(|scope| !scope.is_empty()).map(str::to_owned))
          .collect::<Vec<_>>(),
        _ => Vec::new(),
      };

      let font_style = parse_font_style_bitmask(
        raw_settings.get("fontStyle").and_then(Value::as_str).unwrap_or_default(),
      );
      let foreground = raw_settings
        .get("foreground")
        .and_then(Value::as_str)
        .map(str::to_owned);

      settings.push(json!({
        "scope": scopes,
        "foreground": foreground,
        "fontStyle": font_style,
      }));
    }
  }

  serde_json::to_string(&json!({
    "name": obj.get("name").and_then(Value::as_str).unwrap_or(fallback_name),
    "type": obj.get("type").and_then(Value::as_str).unwrap_or("dark"),
    "fg": fg,
    "bg": bg,
    "settings": settings,
  }))
  .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

fn normalize_language_grammar_json(raw: &str, language_id: &str) -> io::Result<String> {
  let mut value: Value = serde_json::from_str(raw)
    .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;

  if matches!(language_id, "javascript" | "typescript") {
    patch_function_call_begin_patterns(&mut value);
  }
  if language_id == "vue" {
    patch_vue_tag_stuff_begins(&mut value);
  }

  serde_json::to_string(&value)
    .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

fn patch_function_call_begin_patterns(grammar: &mut Value) {
  let Some(repository) = grammar.get_mut("repository").and_then(Value::as_object_mut) else {
    return;
  };
  let Some(function_call) = repository.get_mut("function-call").and_then(Value::as_object_mut) else {
    return;
  };
  let Some(patterns) = function_call.get_mut("patterns").and_then(Value::as_array_mut) else {
    return;
  };
  let Some(first_pattern) = patterns.get_mut(0).and_then(Value::as_object_mut) else {
    return;
  };

  // Ferroni does not currently match Shiki's very large upstream function-call begin
  // pattern reliably. This reduced variant keeps the same intent for ordinary call
  // chains (`foo()`, `foo.bar()`, `foo?.bar()`, `fn<T>()`) while remaining
  // compatible with Ferriki's regex engine.
  first_pattern.insert(
    "begin".to_owned(),
    Value::String(
      r"(?=((#?[$_[:alpha:]][$_[:alnum:]]*)(\s*\??\.\s*(#?[$_[:alpha:]][$_[:alnum:]]*))*)\s*(?:(\?\.\s*)|(!))?(<[^>\n]+>\s*)?\()".to_owned(),
    ),
  );
}

fn patch_vue_tag_stuff_begins(grammar: &mut Value) {
  let Some(repository) = grammar.get_mut("repository").and_then(Value::as_object_mut) else {
    return;
  };

  for key in ["multi-line-script-tag-stuff", "multi-line-style-tag-stuff", "tag-stuff"] {
    let Some(rule) = repository.get_mut(key).and_then(Value::as_object_mut) else {
      continue;
    };
    if key == "tag-stuff" {
      rule.insert("begin".to_owned(), Value::String(r"\G(?=[^>\n])".to_owned()));
      continue;
    }
    let Some(patterns) = rule.get_mut("patterns").and_then(Value::as_array_mut) else {
      continue;
    };
    let Some(first_pattern) = patterns.get_mut(0).and_then(Value::as_object_mut) else {
      continue;
    };
    first_pattern.insert(
      "begin".to_owned(),
      Value::String(r#"\G(?=[^>\n])(?!\blang\s*=\s*['"]?(?:tsx??|jsx|coffee|scss|stylus|less|postcss)\b)"#.to_owned()),
    );
  }
}

fn parse_font_style_bitmask(font_style: &str) -> u8 {
  if font_style.is_empty() {
    return 0;
  }

  let lower = font_style.to_ascii_lowercase();
  let mut mask = 0u8;
  if lower.contains("italic") {
    mask |= 1;
  }
  if lower.contains("bold") {
    mask |= 2;
  }
  if lower.contains("underline") {
    mask |= 4;
  }
  if lower.contains("strikethrough") {
    mask |= 8;
  }
  mask
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
    assert!(records[0].grammar_json.contains("\"scopeName\":\"source.js\""));
  }

  #[test]
  fn normalize_language_grammar_json_patches_js_function_call_begin() {
    let normalized = normalize_language_grammar_json(
      r##"{
        "scopeName":"source.js",
        "repository":{
          "function-call":{
            "patterns":[
              {"begin":"ORIGINAL","end":"END"}
            ]
          }
        }
      }"##,
      "javascript",
    )
    .expect("normalize");
    let value: Value = serde_json::from_str(&normalized).expect("json");
    assert_ne!(
      value["repository"]["function-call"]["patterns"][0]["begin"],
      Value::String("ORIGINAL".to_owned())
    );
  }

  #[test]
  fn loads_theme_records_from_upstream_layout() {
    let source_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("tests/fixtures/upstream/textmate-grammars-themes");
    let records = load_theme_records_from_upstream(&source_dir).expect("load");

    assert_eq!(records.len(), 1);
    assert_eq!(records[0].id, "vitesse-light");
    assert_eq!(records[0].theme_type.as_deref(), Some("light"));
    assert!(records[0].theme_json.contains("\"name\":\"Vitesse Light\""));
    assert!(records[0].theme_json.contains("\"fg\":\"\""));
    assert!(records[0].theme_json.contains("\"bg\":\"\""));
    assert!(records[0].theme_json.contains("\"settings\":"));
  }

  #[test]
  fn normalize_theme_json_converts_raw_vscode_theme_format() {
    let normalized = normalize_theme_json(
      r##"{
        "name":"Demo",
        "type":"light",
        "colors":{
          "editor.foreground":"#111111",
          "editor.background":"#222222"
        },
        "tokenColors":[
          {"scope":"keyword, keyword.control","settings":{"foreground":"#abcdef","fontStyle":"bold italic"}},
          {"scope":["string.quoted"],"settings":{"foreground":"#fedcba","fontStyle":"underline"}}
        ]
      }"##,
      "fallback",
    )
    .expect("normalize");
    let value: Value = serde_json::from_str(&normalized).expect("json");

    assert_eq!(value["name"], "Demo");
    assert_eq!(value["fg"], "#111111");
    assert_eq!(value["bg"], "#222222");
    assert_eq!(value["settings"][0]["scope"], json!(["keyword", "keyword.control"]));
    assert_eq!(value["settings"][0]["fontStyle"], 3);
    assert_eq!(value["settings"][1]["fontStyle"], 4);
  }
}
