use ferriki_textmate::{RawTheme, RawThemeScope, RawThemeSetting, RawThemeStyle};
use serde_json::{Map, Value};

use crate::{Error, ErrorKind, Result};

const FALLBACK_LIGHT_FG: &str = "#333333";
const FALLBACK_LIGHT_BG: &str = "#fffffe";
const FALLBACK_DARK_FG: &str = "#bbbbbb";
const FALLBACK_DARK_BG: &str = "#1e1e1e";

/// Normalized color theme ready to register with [`crate::Highlighter::register_theme`].
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct ThemeData {
    /// Theme name reported on highlighting results.
    pub name: String,
    /// Resolved default foreground color (for example `"#d8dee9"`).
    pub foreground: String,
    /// Resolved default background color (for example `"#2e3440"`).
    pub background: String,
    /// Underlying TextMate [`RawTheme`] token-color rules.
    pub raw_theme: RawTheme,
}

/// Parses a VS Code or TextMate JSON theme into a normalized [`ThemeData`].
///
/// Uses `id` as the fallback theme name when the JSON omits `"name"`, and
/// resolves default foreground and background colors from `"fg"`/`"bg"`,
/// global settings, `"colors"`, or light/dark fallbacks.
pub fn parse_theme_data(id: &str, source: &str) -> Result<ThemeData> {
    let value: Value = serde_json::from_str(source).map_err(|error| {
        Error::new(
            ErrorKind::InvalidRegistration,
            format!("Failed to parse theme JSON: {error}"),
        )
    })?;
    let Value::Object(object) = value else {
        return Err(Error::new(
            ErrorKind::InvalidRegistration,
            "Theme registration must be a JSON object.",
        ));
    };
    parse_theme_object(id, object)
}

pub(crate) fn parse_theme_object(id: &str, mut object: Map<String, Value>) -> Result<ThemeData> {
    let name = string_property(&object, "name").unwrap_or(id).to_owned();
    let is_light = string_property(&object, "type") == Some("light");
    let mut settings = parse_settings(&mut object)?;
    let global = settings
        .iter()
        .find(|setting| setting.name.is_none() && setting.scope.is_none())
        .and_then(|setting| setting.settings.as_ref());
    let colors = object.get("colors").and_then(Value::as_object);

    let foreground = string_property(&object, "fg")
        .or_else(|| global.and_then(|style| style.foreground.as_deref()))
        .or_else(|| color_property(colors, "editor.foreground"))
        .unwrap_or(if is_light {
            FALLBACK_LIGHT_FG
        } else {
            FALLBACK_DARK_FG
        })
        .to_owned();
    let background = string_property(&object, "bg")
        .or_else(|| global.and_then(|style| style.background.as_deref()))
        .or_else(|| color_property(colors, "editor.background"))
        .unwrap_or(if is_light {
            FALLBACK_LIGHT_BG
        } else {
            FALLBACK_DARK_BG
        })
        .to_owned();

    if !settings
        .first()
        .is_some_and(|setting| setting.scope.is_none() && setting.settings.is_some())
    {
        settings.insert(
            0,
            RawThemeSetting::default().with_settings(Some(
                RawThemeStyle::default()
                    .with_foreground(Some(foreground.clone()))
                    .with_background(Some(background.clone())),
            )),
        );
    }

    Ok(ThemeData {
        name: name.clone(),
        foreground,
        background,
        raw_theme: RawTheme::default()
            .with_name(Some(name))
            .with_settings(settings),
    })
}

fn parse_settings(object: &mut Map<String, Value>) -> Result<Vec<RawThemeSetting>> {
    let entries = match object.remove("tokenColors") {
        Some(Value::Array(entries)) => Some(entries),
        _ => match object.remove("settings") {
            Some(Value::Array(entries)) => Some(entries),
            _ => None,
        },
    };
    let Some(entries) = entries else {
        return Ok(Vec::new());
    };

    entries
        .into_iter()
        .filter_map(|entry| match entry {
            Value::Object(entry) => Some(entry),
            _ => None,
        })
        .map(|mut entry| {
            if entry.contains_key("settings") {
                return serde_json::from_value(Value::Object(entry)).map_err(|error| {
                    Error::new(
                        ErrorKind::InvalidRegistration,
                        format!("Failed to parse TextMate theme setting: {error}"),
                    )
                });
            }

            Ok(RawThemeSetting::default()
                .with_name(take_string_property(&mut entry, "name"))
                .with_scope(take_scope(entry.remove("scope")))
                .with_settings(Some(
                    RawThemeStyle::default()
                        .with_font_style(flattened_font_style(entry.get("fontStyle")))
                        .with_foreground(take_string_property(&mut entry, "foreground"))
                        .with_background(take_string_property(&mut entry, "background"))
                        .with_font_family(take_string_property(&mut entry, "fontFamily"))
                        .with_font_size(entry.get("fontSize").and_then(Value::as_f64))
                        .with_line_height(entry.get("lineHeight").and_then(Value::as_f64)),
                )))
        })
        .collect()
}

fn take_scope(value: Option<Value>) -> Option<RawThemeScope> {
    match value {
        Some(Value::String(scope)) => Some(RawThemeScope::String(scope)),
        Some(Value::Array(scopes)) => Some(RawThemeScope::Array(
            scopes
                .into_iter()
                .filter_map(|scope| match scope {
                    Value::String(scope) => Some(scope),
                    _ => None,
                })
                .collect(),
        )),
        _ => None,
    }
}

fn take_string_property(object: &mut Map<String, Value>, key: &str) -> Option<String> {
    match object.remove(key) {
        Some(Value::String(value)) => Some(value),
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

impl ThemeData {
    /// Creates explicit theme colors and TextMate rules. Registration validates the name.
    pub fn new(
        name: impl Into<String>,
        foreground: impl Into<String>,
        background: impl Into<String>,
        raw_theme: RawTheme,
    ) -> Self {
        Self {
            name: name.into(),
            foreground: foreground.into(),
            background: background.into(),
            raw_theme,
        }
    }
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
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/standard");
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

    #[test]
    fn parses_flattened_settings_and_falls_back_from_non_array_token_colors() {
        let theme = parse_theme_data(
            "flat",
            r##"{
                "tokenColors": null,
                "settings": [
                    {
                        "name": "keywords",
                        "scope": ["keyword.control", "keyword.operator"],
                        "foreground": "#cc00ff",
                        "fontStyle": 3
                    }
                ]
            }"##,
        )
        .expect("flattened theme");

        assert_eq!(theme.name, "flat");
        assert_eq!(theme.raw_theme.settings.len(), 2);
        let rule = &theme.raw_theme.settings[1];
        assert_eq!(rule.name.as_deref(), Some("keywords"));
        assert_eq!(
            rule.scope,
            Some(RawThemeScope::Array(vec![
                "keyword.control".to_owned(),
                "keyword.operator".to_owned(),
            ]))
        );
        let style = rule.settings.as_ref().expect("style");
        assert_eq!(style.foreground.as_deref(), Some("#cc00ff"));
        assert_eq!(style.font_style.as_deref(), Some("italic bold"));
    }

    #[test]
    fn rejects_invalid_theme_json_and_non_object_values() {
        let parse_err = parse_theme_data("bad", "{").expect_err("invalid JSON");
        assert_eq!(parse_err.kind(), ErrorKind::InvalidRegistration);
        assert!(parse_err.to_string().contains("Failed to parse theme JSON"));

        let non_object = parse_theme_data("bad", "[]").expect_err("non-object JSON");
        assert_eq!(non_object.kind(), ErrorKind::InvalidRegistration);
        assert!(
            non_object
                .to_string()
                .contains("Theme registration must be a JSON object.")
        );

        let bad_setting = parse_theme_data(
            "bad",
            r#"{"tokenColors": [{"scope": 123, "settings": {}}]}"#,
        )
        .expect_err("invalid setting");
        assert_eq!(bad_setting.kind(), ErrorKind::InvalidRegistration);
        assert!(
            bad_setting
                .to_string()
                .contains("Failed to parse TextMate theme setting")
        );
    }
}
