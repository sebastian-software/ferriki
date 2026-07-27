use ferriki_textmate::{RawTheme, RawThemeScope, RawThemeSetting, RawThemeStyle};
use napi::{Error, Result};
use serde_json::{Map, Value};

const FALLBACK_LIGHT_FG: &str = "#333333";
const FALLBACK_LIGHT_BG: &str = "#fffffe";
const FALLBACK_DARK_FG: &str = "#bbbbbb";
const FALLBACK_DARK_BG: &str = "#1e1e1e";

#[derive(Clone, Debug)]
pub struct ThemeData {
    pub name: String,
    pub foreground: String,
    pub background: String,
    pub raw_theme: RawTheme,
}

pub fn parse_theme_data(id: &str, source: &str) -> Result<ThemeData> {
    let value: Value = serde_json::from_str(source)
        .map_err(|error| Error::from_reason(format!("Failed to parse theme JSON: {error}")))?;
    let object = value
        .as_object()
        .ok_or_else(|| Error::from_reason("Theme registration must be a JSON object."))?;

    let name = string_property(object, "name").unwrap_or(id).to_owned();
    let theme_type = string_property(object, "type").unwrap_or("dark").to_owned();
    let mut settings = parse_settings(object)?;
    let global = settings
        .iter()
        .find(|setting| setting.name.is_none() && setting.scope.is_none())
        .and_then(|setting| setting.settings.as_ref());
    let colors = object.get("colors").and_then(Value::as_object);

    let foreground = string_property(object, "fg")
        .or_else(|| global.and_then(|style| style.foreground.as_deref()))
        .or_else(|| color_property(colors, "editor.foreground"))
        .unwrap_or_else(|| {
            if theme_type == "light" {
                FALLBACK_LIGHT_FG
            } else {
                FALLBACK_DARK_FG
            }
        })
        .to_owned();
    let background = string_property(object, "bg")
        .or_else(|| global.and_then(|style| style.background.as_deref()))
        .or_else(|| color_property(colors, "editor.background"))
        .unwrap_or_else(|| {
            if theme_type == "light" {
                FALLBACK_LIGHT_BG
            } else {
                FALLBACK_DARK_BG
            }
        })
        .to_owned();

    if !settings
        .first()
        .is_some_and(|setting| setting.scope.is_none() && setting.settings.is_some())
    {
        settings.insert(
            0,
            RawThemeSetting {
                settings: Some(RawThemeStyle {
                    foreground: Some(foreground.clone()),
                    background: Some(background.clone()),
                    ..RawThemeStyle::default()
                }),
                ..RawThemeSetting::default()
            },
        );
    }

    Ok(ThemeData {
        name: name.clone(),
        foreground,
        background,
        raw_theme: RawTheme {
            name: Some(name),
            settings,
        },
    })
}

fn parse_settings(object: &Map<String, Value>) -> Result<Vec<RawThemeSetting>> {
    let entries = object
        .get("tokenColors")
        .and_then(Value::as_array)
        .or_else(|| object.get("settings").and_then(Value::as_array));
    let Some(entries) = entries else {
        return Ok(Vec::new());
    };

    entries
        .iter()
        .filter_map(|entry| entry.as_object())
        .map(|entry| {
            if entry.get("settings").is_some() {
                return serde_json::from_value(Value::Object(entry.clone())).map_err(|error| {
                    Error::from_reason(format!("Failed to parse TextMate theme setting: {error}"))
                });
            }

            Ok(RawThemeSetting {
                name: string_property(entry, "name").map(str::to_owned),
                scope: parse_scope(entry.get("scope")),
                settings: Some(RawThemeStyle {
                    font_style: flattened_font_style(entry.get("fontStyle")),
                    foreground: string_property(entry, "foreground").map(str::to_owned),
                    background: string_property(entry, "background").map(str::to_owned),
                    font_family: string_property(entry, "fontFamily").map(str::to_owned),
                    font_size: entry.get("fontSize").and_then(Value::as_f64),
                    line_height: entry.get("lineHeight").and_then(Value::as_f64),
                }),
            })
        })
        .collect()
}

fn parse_scope(value: Option<&Value>) -> Option<RawThemeScope> {
    match value {
        Some(Value::String(scope)) => Some(RawThemeScope::String(scope.clone())),
        Some(Value::Array(scopes)) => Some(RawThemeScope::Array(
            scopes
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        )),
        _ => None,
    }
}

fn flattened_font_style(value: Option<&Value>) -> Option<String> {
    let bits = value.and_then(Value::as_u64)?;
    let mut styles = Vec::new();
    if bits & 1 != 0 {
        styles.push("italic");
    }
    if bits & 2 != 0 {
        styles.push("bold");
    }
    if bits & 4 != 0 {
        styles.push("underline");
    }
    if bits & 8 != 0 {
        styles.push("strikethrough");
    }
    Some(styles.join(" "))
}

fn string_property<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn color_property<'a>(colors: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a str> {
    colors?.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset_catalog::StandardAssetCatalogs;
    use std::path::Path;

    #[test]
    fn preserves_textmate_settings_and_derives_editor_colors() {
        let theme = parse_theme_data(
            "demo",
            r##"{
                "name": "demo",
                "type": "light",
                "colors": {
                    "editor.foreground": "#112233",
                    "editor.background": "#fefefe"
                },
                "tokenColors": [{
                    "scope": "keyword",
                    "settings": {
                        "foreground": "#aabbcc",
                        "fontStyle": "bold italic"
                    }
                }]
            }"##,
        )
        .expect("theme");

        assert_eq!(theme.foreground, "#112233");
        assert_eq!(theme.background, "#fefefe");
        assert_eq!(theme.raw_theme.settings.len(), 2);
        assert_eq!(
            theme.raw_theme.settings[1].scope,
            Some(RawThemeScope::String("keyword".to_owned()))
        );
        assert_eq!(
            theme.raw_theme.settings[1]
                .settings
                .as_ref()
                .and_then(|style| style.font_style.as_deref()),
            Some("bold italic")
        );
    }

    #[test]
    fn uses_shiki_fallback_colors_for_sparse_themes() {
        let light = parse_theme_data("light", r#"{"type":"light"}"#).expect("light");
        let dark = parse_theme_data("dark", r#"{}"#).expect("dark");

        assert_eq!(light.foreground, FALLBACK_LIGHT_FG);
        assert_eq!(light.background, FALLBACK_LIGHT_BG);
        assert_eq!(dark.foreground, FALLBACK_DARK_FG);
        assert_eq!(dark.background, FALLBACK_DARK_BG);
    }

    #[test]
    fn parses_generated_shiki_theme_without_flattening() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/shiki");
        let catalogs = StandardAssetCatalogs::load_from_root(&root).expect("catalogs");
        let asset = catalogs
            .themes
            .load_asset("nord")
            .expect("asset")
            .expect("nord");
        let theme = parse_theme_data(&asset.id, &asset.theme_json).expect("theme");

        assert_eq!(theme.name, "nord");
        assert_eq!(theme.foreground.to_ascii_uppercase(), "#D8DEE9FF");
        assert_eq!(theme.background.to_ascii_uppercase(), "#2E3440FF");
        assert!(theme.raw_theme.settings.len() > 10);
    }
}
