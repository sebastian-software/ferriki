use std::cell::RefCell;
use std::path::Path;

use napi::{Error, Result};
use napi_derive::napi;
use serde_json::Value;

use crate::{HighlighterCore, RenderOptions, TokenizeOptions, render_hast, render_html};

#[napi]
pub struct FerrikiHighlighter {
    core: RefCell<HighlighterCore>,
}

#[napi]
impl FerrikiHighlighter {
    #[napi(js_name = "loadStandardTheme")]
    pub fn load_standard_theme(&self, theme_id: String) -> Result<bool> {
        self.core.borrow_mut().load_standard_theme(&theme_id)
    }

    #[napi(js_name = "loadStandardGrammar")]
    pub fn load_standard_grammar(&self, language: String) -> Result<Option<String>> {
        self.core.borrow_mut().load_standard_language(&language)
    }

    #[napi(js_name = "loadCustomGrammar")]
    pub fn load_custom_grammar(&self, registration_json: String) -> Result<Option<String>> {
        self.core
            .borrow_mut()
            .load_custom_language(&registration_json)
    }

    #[napi(js_name = "loadCustomTheme")]
    pub fn load_custom_theme(&self, registration_json: String) -> Result<bool> {
        self.core.borrow_mut().load_custom_theme(&registration_json)
    }

    #[napi(js_name = "resolveGrammarScope")]
    pub fn resolve_grammar_scope(&self, language: String) -> Result<Option<String>> {
        let mut core = self.core.borrow_mut();
        core.load_standard_language(&language)?;
        Ok(core.resolve_scope(&language))
    }

    #[napi(js_name = "getLoadedGrammarScopes")]
    pub fn get_loaded_grammar_scopes(&self) -> Vec<String> {
        self.core.borrow().loaded_scopes()
    }

    #[napi(js_name = "getLoadedLanguages")]
    pub fn get_loaded_languages(&self) -> Vec<String> {
        self.core.borrow().loaded_languages()
    }

    #[napi(js_name = "codeToTokens")]
    pub fn code_to_tokens(&self, code: String, options_json: String) -> Result<String> {
        let options = HighlightOptions::parse(&options_json)?;
        let tokens = self.core.borrow_mut().tokenize(
            &code,
            &options.language,
            &options.theme,
            &options.tokenize,
        )?;
        serde_json::to_string(&tokens)
            .map_err(|error| Error::from_reason(format!("Failed to serialize tokens: {error}")))
    }

    #[napi(js_name = "codeToTokensWithThemes")]
    pub fn code_to_tokens_with_themes(&self, code: String, options_json: String) -> Result<String> {
        let options = HighlightOptions::parse(&options_json)?;
        let value: Value = serde_json::from_str(&options_json).map_err(|error| {
            Error::from_reason(format!("Failed to parse multi-theme options: {error}"))
        })?;
        let themes = value
            .get("themeEntries")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::from_reason("Multi-theme options require `themeEntries`."))?
            .iter()
            .map(|entry| {
                let color = entry
                    .get("color")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::from_reason("Theme entries require `color`."))?;
                let name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::from_reason("Theme entries require `name`."))?;
                Ok((color.to_owned(), name.to_owned()))
            })
            .collect::<Result<Vec<_>>>()?;
        let tokens = self.core.borrow_mut().tokenize_with_themes(
            &code,
            &options.language,
            &themes,
            &options.tokenize,
        )?;
        serde_json::to_string(&tokens).map_err(|error| {
            Error::from_reason(format!("Failed to serialize themed tokens: {error}"))
        })
    }

    #[napi(js_name = "codeToHast")]
    pub fn code_to_hast(&self, code: String, options_json: String) -> Result<String> {
        let options = HighlightOptions::parse(&options_json)?;
        let tokens = self.core.borrow_mut().tokenize(
            &code,
            &options.language,
            &options.theme,
            &options.tokenize,
        )?;
        serde_json::to_string(&render_hast(&tokens, &options.render))
            .map_err(|error| Error::from_reason(format!("Failed to serialize HAST: {error}")))
    }

    #[napi(js_name = "codeToHtml")]
    pub fn code_to_html(&self, code: String, options_json: String) -> Result<String> {
        let options = HighlightOptions::parse(&options_json)?;
        let tokens = self.core.borrow_mut().tokenize(
            &code,
            &options.language,
            &options.theme,
            &options.tokenize,
        )?;
        Ok(render_html(&tokens, &options.render))
    }

    #[napi]
    pub fn dispose(&self) {
        self.core.borrow_mut().dispose();
    }
}

#[napi(js_name = "createHighlighter")]
pub fn create_highlighter(options_json: String) -> Result<FerrikiHighlighter> {
    let options: Value = serde_json::from_str(&options_json).map_err(|error| {
        Error::from_reason(format!("Failed to parse highlighter options: {error}"))
    })?;
    let standard_asset_root = options
        .get("standardAssetRoot")
        .and_then(Value::as_str)
        .map(Path::new);
    let core = match standard_asset_root {
        Some(root) => HighlighterCore::with_standard_assets(root)?,
        None => HighlighterCore::new()?,
    };
    Ok(FerrikiHighlighter {
        core: RefCell::new(core),
    })
}

struct HighlightOptions {
    language: String,
    theme: String,
    tokenize: TokenizeOptions,
    render: RenderOptions,
}

impl HighlightOptions {
    fn parse(source: &str) -> Result<Self> {
        let value: Value = serde_json::from_str(source).map_err(|error| {
            Error::from_reason(format!("Failed to parse highlight options: {error}"))
        })?;
        let language = required_string(&value, "lang")?;
        let theme = required_string(&value, "theme")?;
        let include_token_type =
            value.get("includeExplanation").and_then(Value::as_str) == Some("tokenType");
        let include_scopes = value.get("includeExplanation").is_some_and(|value| {
            value.as_bool() == Some(true) || value.as_str() == Some("scopeName")
        });
        let time_limit_millis = value
            .get("tokenizeTimeLimit")
            .and_then(Value::as_u64)
            .unwrap_or(500);
        let max_line_length = value
            .get("tokenizeMaxLineLength")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(0);
        let merge_whitespaces = value
            .get("mergeWhitespaces")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let merge_same_style_tokens = value
            .get("mergeSameStyleTokens")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let root_style = value
            .get("rootStyle")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let include_root_style = value.get("rootStyle").and_then(Value::as_bool) != Some(false);
        let tabindex = match value.get("tabindex") {
            Some(Value::Bool(false)) | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.clone()),
            Some(Value::Number(value)) => Some(value.to_string()),
            _ => Some("0".to_owned()),
        };

        Ok(Self {
            language,
            theme,
            tokenize: TokenizeOptions {
                time_limit_millis,
                max_line_length,
                include_token_type,
                include_scopes,
            },
            render: RenderOptions {
                merge_whitespaces,
                merge_same_style_tokens,
                root_style,
                include_root_style,
                tabindex,
            },
        })
    }
}

fn required_string(value: &Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| Error::from_reason(format!("Highlight options require `{key}`.")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn standard_highlighter() -> FerrikiHighlighter {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/shiki");
        create_highlighter(json!({ "standardAssetRoot": root.display().to_string() }).to_string())
            .expect("highlighter")
    }

    #[test]
    fn napi_surface_returns_json_tokens_and_html() {
        let highlighter = standard_highlighter();
        let options = json!({
            "lang": "javascript",
            "theme": "nord",
            "includeExplanation": "tokenType",
            "tokenizeTimeLimit": 0,
        })
        .to_string();

        let tokens: Value = serde_json::from_str(
            &highlighter
                .code_to_tokens("const x = 1".to_owned(), options.clone())
                .expect("tokens"),
        )
        .expect("json");
        let html = highlighter
            .code_to_html("const x = 1".to_owned(), options)
            .expect("html");

        assert_eq!(tokens["themeName"], "nord");
        assert!(tokens["tokens"][0][0].get("type").is_some());
        assert!(html.starts_with("<pre class=\"shiki nord\""));
    }

    #[test]
    fn parses_render_controls_from_shiki_options() {
        let options = HighlightOptions::parse(
            r#"{
                "lang": "js",
                "theme": "nord",
                "rootStyle": false,
                "tabindex": -1,
                "mergeWhitespaces": false,
                "tokenizeTimeLimit": 42
            }"#,
        )
        .expect("options");

        assert!(!options.render.include_root_style);
        assert_eq!(options.render.tabindex.as_deref(), Some("-1"));
        assert!(!options.render.merge_whitespaces);
        assert_eq!(options.tokenize.time_limit_millis, 42);
    }

    #[test]
    fn emits_aligned_multi_theme_tokens_from_one_grammar_pass() {
        let highlighter = standard_highlighter();
        let options = json!({
            "lang": "javascript",
            "theme": "vitesse-light",
            "themeEntries": [
                { "color": "light", "name": "vitesse-light" },
                { "color": "dark", "name": "nord" }
            ],
            "tokenizeTimeLimit": 0,
        })
        .to_string();
        let result: Value = serde_json::from_str(
            &highlighter
                .code_to_tokens_with_themes("const x = 1".to_owned(), options)
                .expect("multi-theme tokens"),
        )
        .expect("JSON result");

        assert_eq!(result["themes"].as_array().expect("themes").len(), 2);
        assert_eq!(result["tokens"][0][0]["content"], "const");
        assert!(result["tokens"][0][0]["variants"]["light"]["color"].is_string());
        assert!(result["tokens"][0][0]["variants"]["dark"]["color"].is_string());
    }
}
