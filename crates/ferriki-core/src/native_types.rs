//! Private Node boundary types, independent of the published Rust API.
use napi::bindgen_prelude::Either;
use napi_derive::napi;

#[napi(object, object_to_js = false)]
#[derive(Default)]
pub struct NativeAssetOptions {
    pub remote: Option<bool>,
    pub base_url: Option<String>,
    pub cache_dir: Option<String>,
}

#[napi(object, object_to_js = false)]
#[derive(Default)]
pub struct NativeHighlighterOptions {
    pub standard_asset_root: Option<String>,
    pub assets: Option<NativeAssetOptions>,
    pub regex_prefilter: Option<bool>,
}

#[napi(object)]
#[derive(Clone)]
pub struct ThemeEntry {
    pub color: String,
    pub name: String,
}

#[napi(object, object_to_js = false)]
#[derive(Clone, Default)]
pub struct NativeHighlightOptions {
    pub lang: String,
    pub theme: String,
    pub include_explanation: Option<Either<String, bool>>,
    pub tokenize_time_limit: Option<f64>,
    pub tokenize_max_line_length: Option<f64>,
    pub merge_whitespaces: Option<bool>,
    pub merge_same_style_tokens: Option<bool>,
    pub root_style: Option<Either<String, bool>>,
    // The facade normalizes numbers to strings and null to false.
    pub tabindex: Option<Either<String, bool>>,
    pub style_mode: Option<String>,
    pub theme_entries: Option<Vec<ThemeEntry>>,
}

// Token calls do not read HTML-only render controls from the JS object.
#[napi(object, object_to_js = false)]
#[derive(Clone, Default)]
pub struct NativeTokenOptions {
    pub lang: String,
    pub theme: String,
    pub include_explanation: Option<Either<String, bool>>,
    pub tokenize_time_limit: Option<f64>,
    pub tokenize_max_line_length: Option<f64>,
    pub style_mode: Option<String>,
    pub theme_entries: Option<Vec<ThemeEntry>>,
}

impl From<NativeHighlightOptions> for NativeTokenOptions {
    fn from(options: NativeHighlightOptions) -> Self {
        Self {
            lang: options.lang,
            theme: options.theme,
            include_explanation: options.include_explanation,
            tokenize_time_limit: options.tokenize_time_limit,
            tokenize_max_line_length: options.tokenize_max_line_length,
            style_mode: options.style_mode,
            theme_entries: options.theme_entries,
        }
    }
}

impl From<NativeTokenOptions> for NativeHighlightOptions {
    fn from(options: NativeTokenOptions) -> Self {
        Self {
            lang: options.lang,
            theme: options.theme,
            include_explanation: options.include_explanation,
            tokenize_time_limit: options.tokenize_time_limit,
            tokenize_max_line_length: options.tokenize_max_line_length,
            style_mode: options.style_mode,
            theme_entries: options.theme_entries,
            ..Default::default()
        }
    }
}

#[napi(object, object_from_js = false, object_to_js = false)]
pub struct HtmlToken {
    pub content: String,
    pub offset: f64,
    pub color: Option<String>,
    pub font_style: Option<i32>,
    #[napi(js_name = "type")]
    pub token_type: Option<u32>,
    pub scope_names: Option<Vec<String>>,
}

impl From<ferriki::HighlightToken> for HtmlToken {
    fn from(token: ferriki::HighlightToken) -> Self {
        Self {
            content: token.content,
            offset: token.offset as f64,
            color: token.color,
            font_style: token.font_style.map(|style| style.bits()),
            token_type: token.token_type.map(|kind| kind as u32),
            scope_names: token.scope_names,
        }
    }
}

#[napi(object, object_from_js = false, object_to_js = false)]
pub struct HtmlRenderData {
    pub tokens: Vec<Vec<HtmlToken>>,
    pub fg: String,
    pub bg: String,
    pub theme_name: String,
}

impl From<ferriki::HighlightTokensResult> for HtmlRenderData {
    fn from(result: ferriki::HighlightTokensResult) -> Self {
        Self {
            tokens: result
                .tokens
                .into_iter()
                .map(|line| line.into_iter().map(Into::into).collect())
                .collect(),
            fg: result.foreground,
            bg: result.background,
            theme_name: result.theme_name,
        }
    }
}

#[napi(object, object_from_js = false, object_to_js = false)]
pub struct ThemeTokenStyle {
    pub color: Option<String>,
    pub font_style: Option<i32>,
}

#[napi(object, object_from_js = false, object_to_js = false)]
pub struct HtmlThemeToken {
    pub content: String,
    pub offset: f64,
    #[napi(ts_type = "Record<string, ThemeTokenStyle>")]
    pub variants: ThemeVariants,
    #[napi(js_name = "type")]
    pub token_type: Option<u32>,
    pub scope_names: Option<Vec<String>>,
}

#[napi(object, object_from_js = false, object_to_js = false)]
pub struct ThemeMetadata {
    pub color: String,
    pub name: String,
    pub foreground: String,
    pub background: String,
}

#[napi(object, object_from_js = false, object_to_js = false)]
pub struct HtmlRenderDataWithThemes {
    pub tokens: Vec<Vec<HtmlThemeToken>>,
    pub themes: Vec<ThemeMetadata>,
}

impl From<ferriki::HighlightTokensWithThemesResult> for HtmlRenderDataWithThemes {
    fn from(result: ferriki::HighlightTokensWithThemesResult) -> Self {
        Self {
            tokens: result
                .tokens
                .into_iter()
                .map(|line| {
                    line.into_iter()
                        .map(|token| HtmlThemeToken {
                            content: token.content,
                            offset: token.offset as f64,
                            variants: token
                                .variants
                                .into_iter()
                                .map(|(name, style)| {
                                    (
                                        name,
                                        ThemeTokenStyle {
                                            color: style.color,
                                            font_style: style.font_style.map(|style| style.bits()),
                                        },
                                    )
                                })
                                .collect(),
                            token_type: token.token_type.map(|kind| kind as u32),
                            scope_names: token.scope_names,
                        })
                        .collect()
                })
                .collect(),
            themes: result
                .themes
                .into_iter()
                .map(|theme| ThemeMetadata {
                    color: theme.color,
                    name: theme.name,
                    foreground: theme.foreground,
                    background: theme.background,
                })
                .collect(),
        }
    }
}

#[napi(object, object_from_js = false, object_to_js = false)]
pub struct AssetPlanEntry {
    pub path: String,
    pub digest: String,
    pub size: f64,
    pub url: String,
}

impl From<ferriki::__private::PlannedAsset> for AssetPlanEntry {
    fn from(asset: ferriki::__private::PlannedAsset) -> Self {
        Self {
            path: asset.path,
            digest: asset.digest,
            size: asset.size as f64,
            url: asset.url,
        }
    }
}

/// Defines theme keys as own data properties, including `__proto__` and NUL.
/// Entries keep the core's sorted, unique `BTreeMap` order without rebuilding
/// a map per token.
pub struct ThemeVariants(pub Vec<(String, ThemeTokenStyle)>);

impl FromIterator<(String, ThemeTokenStyle)> for ThemeVariants {
    fn from_iter<I: IntoIterator<Item = (String, ThemeTokenStyle)>>(entries: I) -> Self {
        Self(entries.into_iter().collect())
    }
}
