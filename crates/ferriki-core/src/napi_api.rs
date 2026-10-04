use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ferriki::__private::{NodeAssetHost, NodeAssetOptions};
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Task};
use napi_derive::napi;
use serde_json::Value;

use crate::{HighlighterCore, RenderOptions, TokenizeOptions, render_html};

/// Semantically analyzes static inline `code` calls and React `Code` elements.
#[napi(js_name = "scanInlineCodeMacros")]
pub fn scan_inline_code_macros(source: String, filename: String) -> Result<String> {
    let scan =
        ferriki_macro::scan_inline_code_macros(&source, &filename).map_err(Error::from_reason)?;
    serde_json::to_string(&scan)
        .map_err(|error| Error::from_reason(format!("Failed to serialize macro scan: {error}")))
}

#[napi]
pub struct FerrikiHighlighter {
    core: RefCell<HighlighterCore>,
    assets: Option<Arc<NodeAssetHost>>,
}

/// Plans payloads on the libuv thread pool without doing network I/O.
pub struct PlanAssetsTask {
    assets: Option<Arc<NodeAssetHost>>,
    languages: Vec<String>,
    themes: Vec<String>,
}

impl Task for PlanAssetsTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        match &self.assets {
            Some(assets) => native(assets.plan_json(&self.languages, &self.themes)),
            None => Ok("[]".to_owned()),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
impl FerrikiHighlighter {
    #[napi(js_name = "loadStandardTheme")]
    pub fn load_standard_theme(&self, theme_id: String) -> Result<bool> {
        native(self.core.borrow_mut().load_standard_theme(&theme_id))
    }

    #[napi(js_name = "loadStandardGrammar")]
    pub fn load_standard_grammar(&self, language: String) -> Result<Option<String>> {
        native(self.core.borrow_mut().load_standard_language(&language))
    }

    #[napi(js_name = "loadCustomGrammar")]
    pub fn load_custom_grammar(&self, registration_json: String) -> Result<Option<String>> {
        native(
            self.core
                .borrow_mut()
                .load_custom_language(&registration_json),
        )
    }

    #[napi(js_name = "loadCustomTheme")]
    pub fn load_custom_theme(&self, registration_json: String) -> Result<bool> {
        native(self.core.borrow_mut().load_custom_theme(&registration_json))
    }

    #[napi(js_name = "resolveGrammarScope")]
    pub fn resolve_grammar_scope(&self, language: String) -> Result<Option<String>> {
        let mut core = self.core.borrow_mut();
        native(core.load_standard_language(&language))?;
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

    #[napi(js_name = "getHtmlRenderData")]
    pub fn get_html_render_data(&self, code: String, options_json: String) -> Result<String> {
        let options = HighlightOptions::parse(&options_json)?;
        let tokens = native(self.core.borrow_mut().tokenize(
            &code,
            &options.language,
            &options.theme,
            &options.tokenize,
        ))?;
        serde_json::to_string(&tokens)
            .map_err(|error| Error::from_reason(format!("Failed to serialize tokens: {error}")))
    }

    #[napi(js_name = "getHtmlRenderDataWithThemes")]
    pub fn get_html_render_data_with_themes(
        &self,
        code: String,
        options_json: String,
    ) -> Result<String> {
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
        let tokens = native(self.core.borrow_mut().tokenize_with_themes(
            &code,
            &options.language,
            &themes,
            &options.tokenize,
        ))?;
        serde_json::to_string(&tokens).map_err(|error| {
            Error::from_reason(format!("Failed to serialize themed tokens: {error}"))
        })
    }

    #[napi(js_name = "codeToHtml")]
    pub fn code_to_html(&self, code: String, options_json: String) -> Result<String> {
        let options = HighlightOptions::parse(&options_json)?;
        let tokens = native(self.core.borrow_mut().tokenize(
            &code,
            &options.language,
            &options.theme,
            &options.tokenize,
        ))?;
        Ok(render_html(&tokens, &options.render))
    }

    /// Plans missing standard payloads for Node to fetch and install.
    #[napi(js_name = "planAssets", ts_return_type = "Promise<string>")]
    pub fn plan_assets(
        &self,
        languages: Vec<String>,
        themes: Vec<String>,
    ) -> AsyncTask<PlanAssetsTask> {
        AsyncTask::new(PlanAssetsTask {
            assets: self.assets.clone(),
            languages,
            themes,
        })
    }

    #[napi(js_name = "assetCacheDir")]
    pub fn asset_cache_dir(&self) -> Option<String> {
        self.assets
            .as_ref()
            .map(|assets| assets.cache_dir().to_string_lossy().into_owned())
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
    let Some(root) = standard_asset_root else {
        return Ok(FerrikiHighlighter {
            core: RefCell::new(native(HighlighterCore::new())?),
            assets: None,
        });
    };
    let assets = Arc::new(native(NodeAssetHost::from_root(
        root,
        &node_asset_options(options.get("assets")),
    ))?);
    let core = native(HighlighterCore::with_assets(native(assets.catalogs())?))?;
    Ok(FerrikiHighlighter {
        core: RefCell::new(core),
        assets: Some(assets),
    })
}

/// Reads the Node asset options; environment and platform defaults are applied
/// by the network-free native asset host.
fn node_asset_options(value: Option<&Value>) -> NodeAssetOptions {
    let field = |name: &str| value.and_then(|value| value.get(name));
    let string = |name: &str| field(name).and_then(Value::as_str).map(str::to_owned);
    NodeAssetOptions {
        remote: field("remote").and_then(Value::as_bool),
        base_url: string("baseUrl"),
        cache_dir: string("cacheDir").map(PathBuf::from),
    }
}

fn native<T>(result: ferriki::Result<T>) -> Result<T> {
    result.map_err(|error| Error::from_reason(error.to_string()))
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
            tokenize: TokenizeOptions::default()
                .with_time_limit_millis(time_limit_millis)
                .with_max_line_length(max_line_length)
                .with_include_token_type(include_token_type)
                .with_include_scopes(include_scopes)
                .with_preserve_scope_boundaries(
                    value.get("styleMode").and_then(Value::as_str) == Some("classes"),
                ),
            render: RenderOptions::default()
                .with_merge_whitespaces(merge_whitespaces)
                .with_merge_same_style_tokens(merge_same_style_tokens)
                .with_root_style(root_style)
                .with_include_root_style(include_root_style)
                .with_tabindex(tabindex),
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

    /// Seeds a digest-addressed cache from the repository payloads once, so the
    /// tests never download and never touch the user's cache.
    fn test_cache(root: &Path) -> PathBuf {
        static CACHE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        CACHE
            .get_or_init(|| {
                let cache = std::env::temp_dir()
                    .join(format!("ferriki-core-test-cache-{}", std::process::id()));
                std::fs::create_dir_all(&cache).expect("cache directory");
                let release: Value = serde_json::from_str(
                    &std::fs::read_to_string(root.join("release-manifest.json"))
                        .expect("release manifest"),
                )
                .expect("release manifest json");
                for (path, asset) in release["assets"].as_object().expect("assets") {
                    let digest = asset["sha256"].as_str().expect("digest");
                    std::fs::copy(root.join(path), cache.join(digest)).expect("seed payload");
                }
                cache
            })
            .clone()
    }

    fn standard_highlighter() -> FerrikiHighlighter {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/shiki");
        let cache = test_cache(&root);
        create_highlighter(
            json!({
                "standardAssetRoot": root.display().to_string(),
                "assets": { "remote": false, "cacheDir": cache.display().to_string() },
            })
            .to_string(),
        )
        .expect("highlighter")
    }

    #[test]
    fn napi_surface_returns_private_html_render_data_and_html() {
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
                .get_html_render_data("const x = 1".to_owned(), options.clone())
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
                .get_html_render_data_with_themes("const x = 1".to_owned(), options)
                .expect("multi-theme tokens"),
        )
        .expect("JSON result");

        assert_eq!(result["themes"].as_array().expect("themes").len(), 2);
        assert_eq!(result["tokens"][0][0]["content"], "const");
        assert!(result["tokens"][0][0]["variants"]["light"]["color"].is_string());
        assert!(result["tokens"][0][0]["variants"]["dark"]["color"].is_string());
    }
}
