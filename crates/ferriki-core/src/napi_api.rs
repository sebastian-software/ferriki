use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ferriki::__private::{NodeAssetHost, NodeAssetOptions};
use napi::bindgen_prelude::{AsyncTask, Either};
use napi::{Env, Error, Result, Task};
use napi_derive::napi;

use crate::native_types::*;
use crate::{HighlighterCore, RenderOptions, TokenizeOptions, render_html};

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
    type Output = Vec<AssetPlanEntry>;
    type JsValue = Vec<AssetPlanEntry>;

    fn compute(&mut self) -> Result<Self::Output> {
        match &self.assets {
            Some(assets) => Ok(native(assets.plan(&self.languages, &self.themes))?
                .into_iter()
                .map(AssetPlanEntry::from)
                .collect()),
            None => Ok(Vec::new()),
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
    pub fn get_html_render_data(
        &self,
        code: String,
        options: NativeTokenOptions,
    ) -> Result<HtmlRenderData> {
        let options = HighlightOptions::from(NativeHighlightOptions::from(options));
        let tokens = native(self.core.borrow_mut().tokenize(
            &code,
            &options.language,
            &options.theme,
            &options.tokenize,
        ))?;
        Ok(tokens.into())
    }

    #[napi(js_name = "getHtmlRenderDataWithThemes")]
    pub fn get_html_render_data_with_themes(
        &self,
        code: String,
        options: NativeTokenOptions,
    ) -> Result<HtmlRenderDataWithThemes> {
        let themes = options
            .theme_entries
            .as_ref()
            .ok_or_else(|| Error::from_reason("Multi-theme options require `themeEntries`."))?
            .iter()
            .map(|entry| (entry.color.clone(), entry.name.clone()))
            .collect::<Vec<_>>();
        let options = HighlightOptions::from(NativeHighlightOptions::from(options));
        let tokens = native(self.core.borrow_mut().tokenize_with_themes(
            &code,
            &options.language,
            &themes,
            &options.tokenize,
        ))?;
        Ok(tokens.into())
    }

    #[napi(js_name = "codeToHtml")]
    pub fn code_to_html(&self, code: String, options: NativeHighlightOptions) -> Result<String> {
        let options = HighlightOptions::from(options);
        let tokens = native(self.core.borrow_mut().tokenize(
            &code,
            &options.language,
            &options.theme,
            &options.tokenize,
        ))?;
        Ok(render_html(&tokens, &options.render))
    }

    /// Plans missing standard payloads for Node to fetch and install.
    #[napi(
        js_name = "planAssets",
        ts_return_type = "Promise<Array<AssetPlanEntry>>"
    )]
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
pub fn create_highlighter(options: NativeHighlighterOptions) -> Result<FerrikiHighlighter> {
    let Some(root) = options.standard_asset_root else {
        return Ok(FerrikiHighlighter {
            core: RefCell::new(native(HighlighterCore::new())?),
            assets: None,
        });
    };
    let options = options.assets.unwrap_or_default();
    let assets = Arc::new(native(NodeAssetHost::from_root(
        Path::new(&root),
        &NodeAssetOptions {
            remote: options.remote,
            base_url: options.base_url,
            cache_dir: options.cache_dir.map(PathBuf::from),
        },
    ))?);
    let core = native(HighlighterCore::with_assets(native(assets.catalogs())?))?;
    Ok(FerrikiHighlighter {
        core: RefCell::new(core),
        assets: Some(assets),
    })
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

impl From<NativeHighlightOptions> for HighlightOptions {
    fn from(options: NativeHighlightOptions) -> Self {
        let include_token_type =
            matches!(&options.include_explanation, Some(Either::A(value)) if value == "tokenType");
        let include_scopes = matches!(&options.include_explanation, Some(Either::B(true)))
            || matches!(&options.include_explanation, Some(Either::A(value)) if value == "scopeName");
        let root_style = match &options.root_style {
            Some(Either::A(value)) => Some(value.clone()),
            _ => None,
        };
        let include_root_style = !matches!(options.root_style, Some(Either::B(false)));
        let tabindex = match options.tabindex {
            Some(Either::A(value)) => Some(value),
            Some(Either::B(false)) => None,
            _ => Some("0".to_owned()),
        };
        // The facade validates numbers; fractional limits historically use defaults.
        let limit = |value: Option<f64>, default: u64| {
            value
                .filter(|v| v.is_finite() && *v >= 0.0 && v.fract() == 0.0 && *v < u64::MAX as f64)
                .map_or(default, |v| v as u64)
        };
        Self {
            language: options.lang,
            theme: options.theme,
            tokenize: TokenizeOptions::default()
                .with_time_limit_millis(limit(options.tokenize_time_limit, 500))
                .with_max_line_length(
                    usize::try_from(limit(options.tokenize_max_line_length, 0)).unwrap_or(0),
                )
                .with_include_token_type(include_token_type)
                .with_include_scopes(include_scopes)
                .with_preserve_scope_boundaries(options.style_mode.as_deref() == Some("classes")),
            render: RenderOptions::default()
                .with_merge_whitespaces(options.merge_whitespaces.unwrap_or(true))
                .with_merge_same_style_tokens(options.merge_same_style_tokens.unwrap_or(false))
                .with_root_style(root_style)
                .with_include_root_style(include_root_style)
                .with_tabindex(tabindex),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

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
        create_highlighter(NativeHighlighterOptions {
            standard_asset_root: Some(root.display().to_string()),
            assets: Some(NativeAssetOptions {
                remote: Some(false),
                cache_dir: Some(cache.display().to_string()),
                ..Default::default()
            }),
        })
        .expect("highlighter")
    }

    #[test]
    fn napi_surface_returns_private_html_render_data_and_html() {
        let highlighter = standard_highlighter();
        let options = NativeHighlightOptions {
            lang: "javascript".into(),
            theme: "nord".into(),
            include_explanation: Some(Either::A("tokenType".into())),
            tokenize_time_limit: Some(0.0),
            ..Default::default()
        };
        let tokens = highlighter
            .get_html_render_data("const x = 1".into(), options.clone().into())
            .expect("tokens");
        let html = highlighter
            .code_to_html("const x = 1".into(), options)
            .expect("html");
        assert_eq!(tokens.theme_name, "nord");
        assert!(tokens.tokens[0][0].token_type.is_some());
        assert!(html.starts_with("<pre class=\"shiki nord\""));
    }

    #[test]
    fn parses_render_controls_from_shiki_options() {
        let options = HighlightOptions::from(NativeHighlightOptions {
            lang: "js".into(),
            theme: "nord".into(),
            root_style: Some(Either::B(false)),
            tabindex: Some(Either::A("-1".into())),
            merge_whitespaces: Some(false),
            tokenize_time_limit: Some(42.0),
            ..Default::default()
        });
        assert!(!options.render.include_root_style);
        assert_eq!(options.render.tabindex.as_deref(), Some("-1"));
        assert!(!options.render.merge_whitespaces);
        assert_eq!(options.tokenize.time_limit_millis, 42);
    }

    #[test]
    fn emits_aligned_multi_theme_tokens_from_one_grammar_pass() {
        let highlighter = standard_highlighter();
        let options = NativeHighlightOptions {
            lang: "javascript".into(),
            theme: "vitesse-light".into(),
            theme_entries: Some(vec![
                ThemeEntry {
                    color: "light".into(),
                    name: "vitesse-light".into(),
                },
                ThemeEntry {
                    color: "dark".into(),
                    name: "nord".into(),
                },
            ]),
            tokenize_time_limit: Some(0.0),
            ..Default::default()
        };
        let result = highlighter
            .get_html_render_data_with_themes("const x = 1".into(), options.into())
            .expect("tokens");
        assert_eq!(result.themes.len(), 2);
        assert_eq!(result.tokens[0][0].content, "const");
        assert!(result.tokens[0][0].variants.0["light"].color.is_some());
        assert!(result.tokens[0][0].variants.0["dark"].color.is_some());
    }
}
