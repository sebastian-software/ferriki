use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::Path;
use std::sync::Arc;

use ferriki_textmate::{
    BacktrackingWarning, EncodedTokenAttributes, FontStyle, GrammarConfiguration, RawGrammar,
    StandardTokenType, SyncRegistry, Theme, parse_raw_grammar,
};
use serde::Deserialize;
use serde::de::{self, DeserializeSeed, IntoDeserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;

use crate::asset_catalog::StandardAssetCatalogs;
use crate::render::{RenderOptions, render_html_lines};
use crate::theme_data::{ThemeData, parse_theme_data, parse_theme_object};
use crate::tokens::{
    HighlightThemeMetadata, HighlightThemeToken, HighlightThemeTokenStyle, HighlightToken,
    HighlightTokensResult, HighlightTokensWithThemesResult, TokenizeOptions, Utf16ToByteMap,
    convert_token_offsets_to_utf8, split_lines, token_from_metadata, utf16_to_byte_map_non_ascii,
};
use crate::{Error, ErrorKind, Result};

/// Compatibility bridge for the N-API host. Its token offsets are UTF-16.
/// Rust consumers should use [`Highlighter`] for UTF-8 byte offsets.
#[doc(hidden)]
pub struct HighlighterCore {
    standard_assets: Option<StandardAssetCatalogs>,
    registry: SyncRegistry,
    aliases: BTreeMap<String, String>,
    loaded_language_ids: BTreeSet<String>,
    prepared_language_scopes: BTreeSet<String>,
    delegated_language_scopes: BTreeSet<String>,
    attempted_precompiled_scopes: BTreeSet<String>,
    loaded_custom_language_ids: BTreeSet<String>,
    loaded_language_order: Vec<String>,
    language_aliases: BTreeMap<String, Vec<String>>,
    injections: BTreeMap<String, Vec<String>>,
    themes: BTreeMap<String, ThemeData>,
    compiled_themes: BTreeMap<String, Arc<Theme>>,
    active_theme: Option<String>,
    regex_mode: ferriki_textmate::RegexMode,
}

/// Reusable, synchronous highlighter for Rust consumers.
///
/// A highlighter lazily loads grammars and themes from its asset catalogs.
/// Its mutable API makes cache updates explicit; instances are not shared
/// across threads. Create one instance and reuse it across many documents.
///
/// ```no_run
/// use std::path::Path;
/// use ferriki::{Highlighter, RenderOptions, StandardAssetCatalogs};
///
/// fn main() -> Result<(), Box<dyn std::error::Error>> {
///     let assets = StandardAssetCatalogs::load_from_root(Path::new("assets/standard"))?;
///     let mut highlighter = Highlighter::builder().with_assets(assets).build()?;
///     let highlighted = highlighter.highlight_html_lines(
///         "fn main() {}", "rust", "nord", &RenderOptions::default(),
///     )?;
///     assert_eq!(highlighted.lines.len(), 1);
///     Ok(())
/// }
/// ```
pub struct Highlighter {
    core: HighlighterCore,
}

impl std::fmt::Debug for Highlighter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Highlighter")
            .field("loaded_languages", &self.core.loaded_languages())
            .finish_non_exhaustive()
    }
}

/// Escaped, balanced inner HTML and the theme colors for one code block.
///
/// Each entry in `lines` corresponds to one source line. A Markdown renderer
/// owns the outer markup and should apply `foreground` and `background` to its
/// code-block wrapper.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub struct HighlightedLines {
    pub lines: Vec<String>,
    pub foreground: String,
    pub background: String,
    pub theme_name: String,
}

/// A typed custom TextMate grammar registration.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct LanguageRegistration {
    /// Language identifier used by `highlight`.
    pub id: String,
    /// Parsed TextMate grammar with a non-empty scope name.
    pub grammar: RawGrammar,
    /// Additional language identifiers.
    pub aliases: Vec<String>,
    /// Scopes into which this grammar injects.
    pub inject_to: Vec<String>,
}

/// Configuration for a reusable highlighter.
#[derive(Debug, Default)]
pub struct HighlighterBuilder {
    assets: Option<StandardAssetCatalogs>,
    languages: Vec<String>,
    themes: Vec<String>,
    regex_mode: Option<ferriki_textmate::RegexMode>,
}

impl Highlighter {
    /// Starts a highlighter builder. Assets are optional for custom-only use.
    pub fn builder() -> HighlighterBuilder {
        HighlighterBuilder::default()
    }

    /// Highlights source into per-line themed tokens.
    pub fn highlight(
        &mut self,
        code: &str,
        language: &str,
        theme: &str,
    ) -> Result<HighlightTokensResult> {
        self.highlight_with_options(code, language, theme, &TokenizeOptions::default())
    }

    /// Highlights source with explicit tokenizer limits and metadata options.
    pub fn highlight_with_options(
        &mut self,
        code: &str,
        language: &str,
        theme: &str,
        options: &TokenizeOptions,
    ) -> Result<HighlightTokensResult> {
        let mut result = self.core.tokenize(code, language, theme, options)?;
        convert_token_offsets_to_utf8(
            result
                .tokens
                .iter_mut()
                .flatten()
                .map(|token| &mut token.offset),
            code,
        )?;
        Ok(result)
    }

    /// Highlights source into aligned tokens with named theme variants.
    ///
    /// Each pair is `(variant_name, registered_theme_name)`. Variant names
    /// must be non-empty and unique, and at least one theme is required.
    /// Token boundaries are the union of each theme's boundaries; offsets
    /// are UTF-8 byte positions in the full source. Metadata follows request
    /// order, while token styles are keyed by variant name.
    pub fn highlight_with_themes(
        &mut self,
        code: &str,
        language: &str,
        themes: &[(&str, &str)],
    ) -> Result<HighlightTokensWithThemesResult> {
        self.highlight_with_themes_and_options(code, language, themes, &TokenizeOptions::default())
    }

    /// Highlights named theme variants with explicit tokenizer options.
    ///
    /// Empty or duplicate variant names and an empty theme list return
    /// [`ErrorKind::Theme`]. Missing registrations and assets retain the same
    /// error categories as [`Self::highlight`]. Optional token types and scope
    /// paths come from the first requested theme.
    pub fn highlight_with_themes_and_options(
        &mut self,
        code: &str,
        language: &str,
        themes: &[(&str, &str)],
        options: &TokenizeOptions,
    ) -> Result<HighlightTokensWithThemesResult> {
        let mut names = BTreeSet::new();
        if themes.is_empty()
            || themes
                .iter()
                .any(|(name, _)| name.is_empty() || !names.insert(*name))
        {
            return Err(Error::new(
                ErrorKind::Theme,
                "At least one theme with non-empty, unique variant names is required.",
            ));
        }
        let themes: Vec<_> = themes
            .iter()
            .map(|(name, theme)| ((*name).to_owned(), (*theme).to_owned()))
            .collect();
        let mut result = self
            .core
            .tokenize_with_themes(code, language, &themes, options)?;
        convert_token_offsets_to_utf8(
            result
                .tokens
                .iter_mut()
                .flatten()
                .map(|token| &mut token.offset),
            code,
        )?;
        Ok(result)
    }

    /// Highlights source directly into escaped, balanced HTML.
    ///
    /// In inline mode, tokens stream directly into the HTML buffer without
    /// materializing an intermediate token tree.
    pub fn highlight_to_html(
        &mut self,
        code: &str,
        language: &str,
        theme: &str,
        render_options: &RenderOptions,
    ) -> Result<String> {
        self.core.highlight_to_html(
            code,
            language,
            theme,
            &TokenizeOptions::default().with_preserve_scope_boundaries(
                render_options.style_mode == crate::StyleMode::Classes,
            ),
            render_options,
        )
    }

    /// Highlights directly to escaped, balanced inner HTML per source line.
    ///
    /// This avoids converting token offsets when a Markdown renderer only
    /// needs line fragments. It does not include code-block or line wrappers.
    pub fn highlight_html_lines(
        &mut self,
        code: &str,
        language: &str,
        theme: &str,
        render_options: &RenderOptions,
    ) -> Result<HighlightedLines> {
        if render_options.style_mode == crate::StyleMode::Inline {
            return self.core.highlight_html_lines_inline(
                code,
                language,
                theme,
                &TokenizeOptions::default(),
                render_options,
            );
        }
        let tokens = self.core.tokenize(
            code,
            language,
            theme,
            &TokenizeOptions::default().with_preserve_scope_boundaries(true),
        )?;
        let lines = render_html_lines(&tokens, render_options);
        Ok(HighlightedLines {
            lines,
            foreground: tokens.foreground,
            background: tokens.background,
            theme_name: tokens.theme_name,
        })
    }

    /// Highlights nested scope classes and extracts CSS from an unchanged TextMate theme.
    pub fn highlight_html_with_css(
        &mut self,
        code: &str,
        language: &str,
        theme: &str,
        render_options: &RenderOptions,
    ) -> Result<crate::HtmlWithCss> {
        let result = self.core.tokenize(
            code,
            language,
            theme,
            &TokenizeOptions::default().with_preserve_scope_boundaries(true),
        )?;
        Ok(crate::render_html_with_css(&result, render_options))
    }

    /// Loads a standard language and its dependencies; returns false if absent.
    pub fn load_language(&mut self, language: &str) -> Result<bool> {
        self.core
            .load_standard_language(language)
            .map(|scope| scope.is_some())
    }

    /// Returns advisory regex backtracking warnings from the current compiled
    /// grammar instance for a language.
    ///
    /// Scanners compile lazily during tokenization, so an empty list can mean
    /// that no risky pattern has been found in the scanners built so far. The
    /// list does not cover rules that tokenized input has not reached. Returns
    /// `None` when the language is not registered. Registering a grammar or
    /// injection can invalidate the compiled grammar cache and reset this
    /// snapshot; tokenizing the language again rediscovers warnings as its
    /// scanners compile. Activating a different theme keeps the compiled
    /// grammar and its warnings. This is not a complete grammar lint.
    pub fn backtracking_warnings(
        &mut self,
        language: &str,
    ) -> Result<Option<Vec<BacktrackingWarning>>> {
        let Some(grammar) = self.core.grammar_for_language(language)? else {
            return Ok(None);
        };
        Ok(Some(grammar.backtracking_warnings()))
    }

    /// Loads a standard theme; returns false if absent.
    pub fn load_theme(&mut self, theme: &str) -> Result<bool> {
        self.core.load_standard_theme(theme)
    }

    /// Registers a custom grammar in Ferriki's JSON registration format.
    pub fn register_language_json(&mut self, source: &str) -> Result<()> {
        self.core.load_custom_language(source).map(|_| ())
    }

    /// Registers a typed custom grammar without a JSON intermediary.
    pub fn register_language(&mut self, registration: LanguageRegistration) -> Result<()> {
        self.core.register_language(registration).map(|_| ())
    }

    /// Registers a custom theme in Ferriki's JSON registration format.
    pub fn register_theme_json(&mut self, source: &str) -> Result<()> {
        self.core.load_custom_theme(source).map(|_| ())
    }

    /// Registers a parsed custom theme without a JSON intermediary.
    pub fn register_theme(&mut self, theme: ThemeData) -> Result<()> {
        self.core.register_theme(theme)
    }
}

impl HighlighterBuilder {
    /// Enables regex prefiltering (the default), or disables its construction.
    /// Prepared standard assets use Eager for static scanners; source-only and
    /// captured dynamic scanners retain Auto. Applies to every loaded grammar.
    pub fn with_regex_prefilter(mut self, enabled: bool) -> Self {
        self.regex_mode = Some(ferriki_textmate::RegexMode::from_prefilter(enabled));
        self
    }

    /// Selects classic source Off/Auto/Eager or optional prepared standard packages.
    /// The last regex policy setter wins; omitted policy keeps Prepared.
    pub fn with_regex_mode(mut self, mode: ferriki_textmate::RegexMode) -> Self {
        self.regex_mode = Some(mode);
        self
    }

    /// Uses portable asset catalogs prepared by a filesystem or memory source.
    pub fn with_assets(mut self, assets: StandardAssetCatalogs) -> Self {
        self.assets = Some(assets);
        self
    }

    /// Eagerly loads these languages while building the highlighter.
    pub fn load_languages<I, S>(mut self, languages: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.languages.extend(
            languages
                .into_iter()
                .map(|language| language.as_ref().to_owned()),
        );
        self
    }

    /// Eagerly loads these themes while building the highlighter.
    pub fn load_themes<I, S>(mut self, themes: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.themes
            .extend(themes.into_iter().map(|theme| theme.as_ref().to_owned()));
        self
    }

    /// Builds one reusable highlighter. Unknown requested assets are errors.
    pub fn build(self) -> Result<Highlighter> {
        let mut core = HighlighterCore::new_with_regex_mode(self.regex_mode.unwrap_or_default())?;
        core.standard_assets = self.assets;
        for language in self.languages {
            if core.load_standard_language(&language)?.is_none() {
                return Err(Error::new(
                    ErrorKind::UnknownLanguage,
                    format!("Unknown language `{language}`."),
                ));
            }
        }
        for theme in self.themes {
            if !core.load_standard_theme(&theme)? {
                return Err(Error::new(
                    ErrorKind::UnknownTheme,
                    format!("Unknown theme `{theme}`."),
                ));
            }
        }
        Ok(Highlighter { core })
    }
}

enum InlineLineEvent<'a> {
    Header {
        theme_name: &'a str,
        background: &'a str,
        foreground: &'a str,
    },
    Tokens(usize, &'a [crate::render::BorrowedInlineToken<'a>]),
    PlainLine(usize, &'a str),
}

impl HighlighterCore {
    pub fn new() -> Result<Self> {
        Self::new_with_regex_prefilter(true)
    }

    pub fn new_with_regex_prefilter(regex_prefilter: bool) -> Result<Self> {
        Self::new_with_regex_mode(ferriki_textmate::RegexMode::from_prefilter(regex_prefilter))
    }

    pub fn new_with_regex_mode(regex_mode: ferriki_textmate::RegexMode) -> Result<Self> {
        Ok(Self {
            standard_assets: None,
            registry: SyncRegistry::new(None, None).map_err(theme_error)?,
            aliases: BTreeMap::new(),
            loaded_language_ids: BTreeSet::new(),
            prepared_language_scopes: BTreeSet::new(),
            delegated_language_scopes: BTreeSet::new(),
            attempted_precompiled_scopes: BTreeSet::new(),
            loaded_custom_language_ids: BTreeSet::new(),
            loaded_language_order: Vec::new(),
            language_aliases: BTreeMap::new(),
            injections: BTreeMap::new(),
            themes: BTreeMap::new(),
            compiled_themes: BTreeMap::new(),
            active_theme: None,
            regex_mode,
        })
    }

    pub fn with_standard_assets(root: &Path) -> Result<Self> {
        Self::with_assets(StandardAssetCatalogs::load_from_root(root)?)
    }

    pub fn with_assets(assets: StandardAssetCatalogs) -> Result<Self> {
        Self::with_assets_and_regex_prefilter(assets, true)
    }

    pub fn with_assets_and_regex_prefilter(
        assets: StandardAssetCatalogs,
        regex_prefilter: bool,
    ) -> Result<Self> {
        let mut highlighter = Self::new_with_regex_prefilter(regex_prefilter)?;
        highlighter.standard_assets = Some(assets);
        Ok(highlighter)
    }

    pub fn with_assets_and_regex_mode(
        assets: StandardAssetCatalogs,
        mode: ferriki_textmate::RegexMode,
    ) -> Result<Self> {
        let mut highlighter = Self::new_with_regex_mode(mode)?;
        highlighter.standard_assets = Some(assets);
        Ok(highlighter)
    }

    pub fn regex_diagnostics(&self) -> Value {
        let mut value =
            serde_json::to_value(self.registry.regex_diagnostics()).expect("diagnostics serialize");
        value["mode"] = serde_json::to_value(self.regex_mode).expect("mode serializes");
        value
    }

    pub fn dispose(&mut self) {
        self.registry.dispose();
        self.standard_assets = None;
        self.aliases.clear();
        self.loaded_language_ids.clear();
        self.prepared_language_scopes.clear();
        self.delegated_language_scopes.clear();
        self.attempted_precompiled_scopes.clear();
        self.loaded_custom_language_ids.clear();
        self.loaded_language_order.clear();
        self.language_aliases.clear();
        self.injections.clear();
        self.themes.clear();
        self.compiled_themes.clear();
        self.active_theme = None;
    }

    pub fn load_standard_theme(&mut self, theme_id: &str) -> Result<bool> {
        if self.themes.contains_key(theme_id) {
            return Ok(true);
        }
        let Some(catalogs) = self.standard_assets.as_ref() else {
            return Ok(false);
        };
        let Some(asset) = catalogs.themes.load_asset(theme_id)? else {
            return Ok(false);
        };
        let theme = parse_theme_data(&asset.id, &asset.theme_json).map_err(|error| {
            Error::new(
                ErrorKind::AssetFormat,
                format!("Failed to parse standard theme `{}`: {error}", asset.id),
            )
        })?;
        self.compiled_themes.remove(&asset.id);
        self.themes.insert(asset.id.clone(), theme);
        Ok(true)
    }

    fn ensure_compiled_theme(&mut self, theme_id: &str) -> Result<Option<Arc<Theme>>> {
        if !self.load_standard_theme(theme_id)? {
            return Ok(None);
        }
        if let Some(compiled) = self.compiled_themes.get(theme_id) {
            return Ok(Some(Arc::clone(compiled)));
        }
        let theme = self
            .themes
            .get(theme_id)
            .ok_or_else(|| Error::from_reason("Loaded Ferriki theme disappeared."))?;
        let compiled = Arc::new(
            Theme::create_from_raw_theme(Some(&theme.raw_theme), None).map_err(theme_error)?,
        );
        self.compiled_themes
            .insert(theme_id.to_owned(), Arc::clone(&compiled));
        Ok(Some(compiled))
    }

    pub fn activate_theme(&mut self, theme_id: &str) -> Result<Option<&ThemeData>> {
        let Some(compiled) = self.ensure_compiled_theme(theme_id)? else {
            return Ok(None);
        };
        if self.active_theme.as_deref() != Some(theme_id) {
            self.registry.set_compiled_theme(compiled);
            self.active_theme = Some(theme_id.to_owned());
        }
        Ok(self.themes.get(theme_id))
    }

    pub fn load_standard_language(&mut self, requested: &str) -> Result<Option<String>> {
        self.load_standard_language_with_retry(requested, true)
    }

    /// Resolves an already-loaded grammar scope without retrying optional
    /// precompiled sidecars, falling back to a non-retrying standard load.
    pub fn resolve_or_load_language(&mut self, requested: &str) -> Result<Option<String>> {
        if let Some(scope) = self.resolve_scope(requested) {
            return Ok(Some(scope));
        }
        self.load_standard_language_with_retry(requested, false)?;
        Ok(self.resolve_scope(requested))
    }

    /// Whether `requested` (and its cooperating embedded languages when
    /// delegated) is already loaded with every applicable prepared sidecar
    /// attached, so an async host can skip re-planning without suppressing
    /// sidecar recovery after synchronous or corrupt-sidecar fallback loads.
    pub fn is_standard_language_ready(&self, requested: &str) -> bool {
        let Some(catalogs) = self.standard_assets.as_ref() else {
            return false;
        };
        let Some(root_id) = catalogs.languages.resolve_id(requested) else {
            return false;
        };
        if !self.loaded_language_ids.contains(root_id) {
            return false;
        }
        if self.regex_mode != ferriki_textmate::RegexMode::Prepared {
            return true;
        }
        // Mirror `NodeAssetHost::plan`'s `(id, prepared)` walk so readiness
        // requires sidecars only along edges where the planner requests them.
        let mut pending = vec![(root_id, true)];
        let mut visited = BTreeSet::new();
        while let Some((requested_id, prepared)) = pending.pop() {
            let Some(id) = catalogs.languages.resolve_id(requested_id) else {
                continue;
            };
            if !visited.insert((id, prepared)) {
                continue;
            }
            if !self.loaded_language_ids.contains(id) {
                return false;
            }
            let Some(scope) = catalogs.languages.scope_name(id) else {
                return false;
            };
            let format_version = catalogs.languages.precompiled_format_version(id);
            let delegated = prepared && format_version.is_some_and(|version| version >> 24 >= 3);
            if prepared
                && format_version
                    .is_some_and(ferriki_textmate::supports_precompiled_patterns_version)
                && !self.prepared_language_scopes.contains(scope)
            {
                return false;
            }
            if let Some(embedded) = catalogs.languages.embedded_langs(id) {
                pending.extend(embedded.iter().map(|child| (child.as_str(), delegated)));
            }
        }
        true
    }

    fn load_standard_language_with_retry(
        &mut self,
        requested: &str,
        retry_optional: bool,
    ) -> Result<Option<String>> {
        let scope = self.load_standard_language_inner(requested)?;
        if retry_optional && let Some(scope) = &scope {
            // An explicit load can follow a host prefetch that made a previously
            // absent optional file available. Tokenization does not retry I/O.
            self.attempted_precompiled_scopes.remove(scope);
        }
        if let Some(scope) = &scope
            && self.regex_mode == ferriki_textmate::RegexMode::Prepared
            && !self.prepared_language_scopes.contains(scope)
            && !self.attempted_precompiled_scopes.contains(scope)
            && let Some(catalogs) = &self.standard_assets
            && let Some(id) = catalogs.languages.resolve_id(scope)
        {
            self.attempted_precompiled_scopes.insert(scope.clone());
            // Attach the requested root first. Legacy complete roots remain
            // self-contained; cooperating roots attach registered packages below.
            if let Some(coverage) = catalogs
                .languages
                .attach_precompiled(id, &mut self.registry)
            {
                self.prepared_language_scopes.insert(scope.clone());
                if matches!(coverage, crate::asset_catalog::PreparedCoverage::Delegated) {
                    self.delegated_language_scopes.insert(scope.clone());
                }
            }
        }
        if scope
            .as_ref()
            .is_some_and(|scope| self.delegated_language_scopes.contains(scope))
            && let Some(catalogs) = &self.standard_assets
        {
            // Only already registered standard languages participate. Optional
            // fenced-code languages remain optional; they are not eagerly loaded.
            for id in &self.loaded_language_ids {
                let Some(dependency_scope) = catalogs.languages.scope_name(id) else {
                    continue;
                };
                if retry_optional {
                    self.attempted_precompiled_scopes.remove(dependency_scope);
                }
                if !self.prepared_language_scopes.contains(dependency_scope)
                    && !self.attempted_precompiled_scopes.contains(dependency_scope)
                {
                    self.attempted_precompiled_scopes
                        .insert(dependency_scope.to_owned());
                    if catalogs
                        .languages
                        .attach_precompiled(id, &mut self.registry)
                        .is_some()
                    {
                        self.prepared_language_scopes
                            .insert(dependency_scope.to_owned());
                    }
                }
            }
        }
        Ok(scope)
    }

    /// Register a user-provided TextMate grammar without pretending it is a
    /// bundled asset. The JSON shape intentionally stays close to Shiki's
    /// LanguageRegistration: the raw grammar fields are parsed by the same
    /// decoder as shipped grammars, while aliases and injection metadata are
    /// kept in the shared lookup model.
    pub fn load_custom_language(&mut self, source: &str) -> Result<Option<String>> {
        let mut captured_name = None;
        let mut deserializer = serde_json::Deserializer::from_str(source);
        let parsed = CustomLanguageJsonSeed {
            captured_name: &mut captured_name,
        }
        .deserialize(&mut deserializer)
        .and_then(|value| {
            deserializer.end()?;
            Ok(value)
        })
        .map_err(|error| {
            let message = match captured_name.as_ref().and_then(Option::as_deref) {
                Some(id) if !id.is_empty() => {
                    format!("Failed to parse custom grammar `{id}`: invalid JSON grammar: {error}")
                }
                _ => format!("Failed to parse custom language registration: {error}"),
            };
            Error::new(ErrorKind::InvalidRegistration, message)
        })?;
        let CustomLanguageJson::Object {
            name,
            aliases,
            inject_to,
            mut grammar,
        } = parsed
        else {
            return Err(Error::new(
                ErrorKind::InvalidRegistration,
                "Language registration must be a JSON object.",
            ));
        };
        let id = name
            .flatten()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                Error::new(
                    ErrorKind::InvalidRegistration,
                    "Language registration requires a non-empty `name`.",
                )
            })?;
        if grammar.scope_name.is_empty() {
            return Err(Error::new(
                ErrorKind::InvalidRegistration,
                format!("Language registration `{id}` requires a non-empty `scopeName`."),
            ));
        }
        let aliases = take_string_array(aliases, "aliases")?;
        let inject_to = take_string_array(inject_to, "injectTo")?;
        grammar.name = Some(id.clone());

        self.register_language(LanguageRegistration {
            id,
            grammar: *grammar,
            aliases,
            inject_to,
        })
        .map(Some)
    }

    pub fn register_language(&mut self, registration: LanguageRegistration) -> Result<String> {
        let LanguageRegistration {
            id,
            grammar,
            aliases,
            inject_to,
        } = registration;
        if id.is_empty() || grammar.scope_name.is_empty() {
            return Err(Error::new(
                ErrorKind::InvalidRegistration,
                "Language registration requires non-empty `id` and `scopeName`.",
            ));
        }
        if self.loaded_custom_language_ids.contains(&id) {
            return Ok(grammar.scope_name);
        }
        grammar
            .validate_scope_selector_depths()
            .map_err(theme_error)?;
        let scope_name = grammar.scope_name.clone();
        self.registry.add_grammar(
            grammar,
            self.injections
                .get(&scope_name)
                .cloned()
                .unwrap_or_default(),
        );
        self.aliases.insert(id.clone(), scope_name.clone());
        for alias in &aliases {
            // A user registration must never steal a key that belongs to the
            // standard catalog. The standard resolver can still load that
            // language later, regardless of registration order.
            if self
                .standard_assets
                .as_ref()
                .and_then(|catalogs| catalogs.languages.resolve_id(alias))
                .is_some()
            {
                continue;
            }
            self.aliases.insert(alias.clone(), scope_name.clone());
        }
        for target in &inject_to {
            {
                let injections = self.injections.entry(target.clone()).or_default();
                if !injections.contains(&scope_name) {
                    injections.push(scope_name.clone());
                }
            }
            self.refresh_injections(target);
        }
        self.language_aliases.insert(id.clone(), aliases);
        self.loaded_custom_language_ids.insert(id.clone());
        self.loaded_language_order.push(id);
        Ok(scope_name)
    }

    /// Register a user-provided theme using the same parser and TextMate
    /// theme cache as bundled themes. A simple `include` name is supported so
    /// custom themes can layer on a previously loaded standard/custom theme.
    pub fn load_custom_theme(&mut self, source: &str) -> Result<bool> {
        let value: Value = serde_json::from_str(source).map_err(|error| {
            Error::new(
                ErrorKind::InvalidRegistration,
                format!("Failed to parse custom theme registration: {error}"),
            )
        })?;
        let Value::Object(mut object) = value else {
            return Err(Error::new(
                ErrorKind::InvalidRegistration,
                "Theme registration must be a JSON object.",
            ));
        };
        let id = object
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                Error::new(
                    ErrorKind::InvalidRegistration,
                    "Theme registration requires a non-empty `name`.",
                )
            })?
            .to_owned();
        let include = object.remove("include");
        let explicit_foreground = object.get("fg").and_then(Value::as_str).is_some()
            || object
                .get("colors")
                .and_then(Value::as_object)
                .and_then(|colors| colors.get("editor.foreground"))
                .and_then(Value::as_str)
                .is_some();
        let explicit_background = object.get("bg").and_then(Value::as_str).is_some()
            || object
                .get("colors")
                .and_then(Value::as_object)
                .and_then(|colors| colors.get("editor.background"))
                .and_then(Value::as_str)
                .is_some();
        let mut theme = parse_theme_object(&id, object)?;
        if let Some(include) = include {
            let include = include.as_str().ok_or_else(|| {
                Error::new(
                    ErrorKind::InvalidRegistration,
                    "Theme registration `include` must be a theme name.",
                )
            })?;
            if !self.load_standard_theme(include)? {
                return Err(Error::new(
                    ErrorKind::InvalidRegistration,
                    format!("Theme `{include}` not found for custom theme include."),
                ));
            }
            let base = self
                .themes
                .get(include)
                .cloned()
                .ok_or_else(|| Error::from_reason("Included Ferriki theme disappeared."))?;
            if !explicit_foreground {
                theme.foreground = base.foreground.clone();
            }
            if !explicit_background {
                theme.background = base.background.clone();
            }
            let mut settings = base.raw_theme.settings;
            settings.extend(theme.raw_theme.settings);
            theme.raw_theme.settings = settings;
        }
        self.register_theme(theme)?;
        Ok(true)
    }

    pub fn register_theme(&mut self, theme: ThemeData) -> Result<()> {
        if theme.name.is_empty() {
            return Err(Error::new(
                ErrorKind::InvalidRegistration,
                "Theme registration requires a non-empty `name`.",
            ));
        }
        let compiled = Arc::new(
            Theme::create_from_raw_theme(Some(&theme.raw_theme), None)
                .map_err(custom_theme_registration_error)?,
        );
        if self.active_theme.as_deref() == Some(&theme.name) {
            self.active_theme = None;
        }
        self.compiled_themes.insert(theme.name.clone(), compiled);
        self.themes.insert(theme.name.clone(), theme);
        Ok(())
    }

    fn load_standard_language_inner(&mut self, requested: &str) -> Result<Option<String>> {
        let mut staged = Vec::new();
        let mut staged_ids = BTreeSet::new();
        let Some(scope) = self.stage_standard_language(requested, &mut staged_ids, &mut staged)?
        else {
            return Ok(None);
        };
        for (asset, raw_grammar) in staged {
            self.register_loaded_grammar(&asset, raw_grammar);
            self.refresh_injections(&asset.scope_name);
        }
        Ok(Some(scope))
    }

    fn stage_standard_language(
        &self,
        requested: &str,
        staged_ids: &mut BTreeSet<String>,
        staged: &mut Vec<(std::sync::Arc<ferriki_asset_gen::LanguageAsset>, RawGrammar)>,
    ) -> Result<Option<String>> {
        if self.registry.lookup(requested).is_some() {
            return Ok(Some(requested.to_owned()));
        }
        if let Some(scope_name) = self.aliases.get(requested) {
            return Ok(Some(scope_name.clone()));
        }

        let Some(catalogs) = self.standard_assets.as_ref() else {
            return Ok(None);
        };
        let Some(id) = catalogs.languages.resolve_id(requested) else {
            return Ok(None);
        };
        if self.loaded_language_ids.contains(id) || staged_ids.contains(id) {
            return Ok(catalogs.languages.scope_name(id).map(str::to_owned));
        }
        let Some(asset) = catalogs.languages.load_asset(id)? else {
            return Ok(None);
        };
        if self.loaded_language_ids.contains(&asset.id) || !staged_ids.insert(asset.id.clone()) {
            return Ok(Some(asset.scope_name.clone()));
        }

        let raw_grammar =
            parse_raw_grammar(&asset.grammar_json, Some("grammar.json")).map_err(|error| {
                Error::new(
                    ErrorKind::AssetFormat,
                    format!("Failed to parse standard grammar `{}`: {error}", asset.id),
                )
            })?;
        raw_grammar
            .validate_scope_selector_depths()
            .map_err(|error| {
                Error::new(
                    ErrorKind::AssetFormat,
                    format!(
                        "Invalid scope selector in standard grammar `{}`: {error}",
                        asset.id
                    ),
                )
            })?;

        for dependency in &asset.embedded_langs {
            self.stage_standard_language(dependency, staged_ids, staged)?;
        }

        let scope_name = asset.scope_name.clone();
        staged.push((asset, raw_grammar));
        Ok(Some(scope_name))
    }

    fn register_loaded_grammar(
        &mut self,
        asset: &ferriki_asset_gen::LanguageAsset,
        grammar: RawGrammar,
    ) {
        let scope_name = asset.scope_name.clone();
        self.registry.add_grammar(
            grammar,
            self.injections
                .get(&scope_name)
                .cloned()
                .unwrap_or_default(),
        );
        self.aliases.insert(asset.id.clone(), scope_name.clone());
        for alias in &asset.aliases {
            self.aliases.insert(alias.clone(), scope_name.clone());
        }
        for target in &asset.inject_to {
            let injections = self.injections.entry(target.clone()).or_default();
            if !injections.contains(&scope_name) {
                injections.push(scope_name.clone());
            }
            self.refresh_injections(target);
        }
        if self.loaded_language_ids.insert(asset.id.clone()) {
            self.loaded_language_order.push(asset.id.clone());
        }
        self.language_aliases
            .insert(asset.id.clone(), asset.aliases.clone());
    }

    fn refresh_injections(&mut self, target_scope: &str) {
        let injections = self
            .injections
            .iter()
            .filter(|(target, _)| scope_matches(target, target_scope))
            .flat_map(|(_, injections)| injections.iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        self.registry.set_injections(target_scope, injections);
    }

    pub fn resolve_scope(&self, requested: &str) -> Option<String> {
        if self.registry.lookup(requested).is_some() {
            return Some(requested.to_owned());
        }
        self.aliases.get(requested).cloned()
    }

    pub fn loaded_scopes(&self) -> Vec<String> {
        self.loaded_language_order
            .iter()
            .filter_map(|id| self.aliases.get(id).cloned())
            .collect()
    }

    pub fn loaded_languages(&self) -> Vec<String> {
        self.loaded_language_order
            .iter()
            .cloned()
            .chain(
                self.loaded_language_order
                    .iter()
                    .flat_map(|id| self.language_aliases.get(id).into_iter().flatten().cloned()),
            )
            .collect()
    }

    pub fn grammar_for_language(
        &mut self,
        requested: &str,
    ) -> Result<Option<std::rc::Rc<ferriki_textmate::Grammar>>> {
        let Some(scope_name) = self.load_standard_language_with_retry(requested, false)? else {
            return Ok(None);
        };
        self.registry
            .grammar_for_scope_name(
                &scope_name,
                GrammarConfiguration::default()
                    .with_regex_mode(self.regex_mode)
                    .with_initial_language_id(1)
                    .with_balanced_bracket_selectors(Some(vec!["*".to_owned()])),
            )
            .map_err(theme_error)
    }

    pub fn tokenize(
        &mut self,
        code: &str,
        language: &str,
        theme_id: &str,
        options: &TokenizeOptions,
    ) -> Result<HighlightTokensResult> {
        self.tokenize_with_grammar_state(code, language, theme_id, options, None, false)
            .map(|(result, _)| result)
    }

    /// Streams tokenization directly into escaped, balanced HTML for inline
    /// single-theme rendering without allocating an intermediate token tree.
    pub fn highlight_to_html(
        &mut self,
        code: &str,
        language: &str,
        theme_id: &str,
        tokenize_options: &TokenizeOptions,
        render_options: &RenderOptions,
    ) -> Result<String> {
        if render_options.style_mode == crate::StyleMode::Classes
            || tokenize_options.preserve_scope_boundaries
        {
            let tokens = self.tokenize(code, language, theme_id, tokenize_options)?;
            return Ok(crate::render::render_html(&tokens, render_options));
        }

        let mut html =
            String::with_capacity(crate::render::bounded_source_html_capacity(code.len()));
        self.stream_inline_lines(
            code,
            language,
            theme_id,
            tokenize_options,
            |event| match event {
                InlineLineEvent::Header {
                    theme_name,
                    background,
                    foreground,
                } => {
                    crate::render::write_inline_pre_open(
                        &mut html,
                        theme_name,
                        background,
                        foreground,
                        render_options,
                    );
                }
                InlineLineEvent::Tokens(line_index, tokens) => {
                    if line_index > 0 {
                        html.push('\n');
                    }
                    html.push_str("<span class=\"line\">");
                    crate::render::render_borrowed_inline_tokens(&mut html, tokens, render_options);
                    html.push_str("</span>");
                }
                InlineLineEvent::PlainLine(line_index, raw_line) => {
                    if line_index > 0 {
                        html.push('\n');
                    }
                    html.push_str("<span class=\"line\">");
                    if !raw_line.is_empty() {
                        html.push_str("<span>");
                        crate::render::write_escaped_html(&mut html, raw_line);
                        html.push_str("</span>");
                    }
                    html.push_str("</span>");
                }
            },
        )?;
        html.push_str("</code></pre>");
        Ok(html)
    }

    pub(crate) fn highlight_html_lines_inline(
        &mut self,
        code: &str,
        language: &str,
        theme_id: &str,
        tokenize_options: &TokenizeOptions,
        render_options: &RenderOptions,
    ) -> Result<HighlightedLines> {
        let mut lines = Vec::new();
        let (theme_name, background, foreground) = self.stream_inline_lines(
            code,
            language,
            theme_id,
            tokenize_options,
            |event| match event {
                InlineLineEvent::Header { .. } => {}
                InlineLineEvent::Tokens(_, tokens) => {
                    let mut content_bytes = 0usize;
                    for token in tokens {
                        content_bytes = content_bytes.saturating_add(token.content.len());
                    }
                    let cap = crate::render::bounded_token_html_capacity(
                        content_bytes,
                        tokens.len().saturating_mul(32),
                    );
                    let mut html = String::with_capacity(cap);
                    crate::render::render_borrowed_inline_tokens(&mut html, tokens, render_options);
                    lines.push(html);
                }
                InlineLineEvent::PlainLine(_, raw_line) => {
                    if raw_line.is_empty() {
                        lines.push(String::new());
                    } else {
                        let mut html = String::with_capacity(13 + raw_line.len());
                        html.push_str("<span>");
                        crate::render::write_escaped_html(&mut html, raw_line);
                        html.push_str("</span>");
                        lines.push(html);
                    }
                }
            },
        )?;
        Ok(HighlightedLines {
            lines,
            foreground,
            background,
            theme_name,
        })
    }

    fn stream_inline_lines(
        &mut self,
        code: &str,
        language: &str,
        theme_id: &str,
        tokenize_options: &TokenizeOptions,
        mut on_event: impl FnMut(InlineLineEvent<'_>),
    ) -> Result<(String, String, String)> {
        let theme = self.activate_theme(theme_id)?.ok_or_else(|| {
            Error::new(
                ErrorKind::UnknownTheme,
                format!("Unknown theme `{theme_id}`."),
            )
        })?;
        let foreground = theme.foreground.clone();
        let background = theme.background.clone();
        let theme_name = theme.name.clone();

        if is_plain_language(language) || language == "ansi" {
            on_event(InlineLineEvent::Header {
                theme_name: &theme_name,
                background: &background,
                foreground: &foreground,
            });
            for (line_index, (line, _)) in split_lines(code).into_iter().enumerate() {
                on_event(InlineLineEvent::PlainLine(line_index, line));
            }
            return Ok((theme_name, background, foreground));
        }

        let grammar = self.grammar_for_language(language)?.ok_or_else(|| {
            Error::new(
                ErrorKind::UnknownLanguage,
                format!("Unknown language `{language}`."),
            )
        })?;
        let compiled_theme = self
            .compiled_themes
            .get(theme_id)
            .cloned()
            .ok_or_else(|| Error::from_reason("Compiled Ferriki theme disappeared."))?;
        let color_map = compiled_theme.color_map();
        let sanitized_colors: Vec<Option<std::borrow::Cow<'_, str>>> = color_map
            .iter()
            .map(|color| crate::render::normalize_safe_css_color(color))
            .collect();

        on_event(InlineLineEvent::Header {
            theme_name: &theme_name,
            background: &background,
            foreground: &foreground,
        });

        let mut state = None;
        let lines = split_lines(code);
        let mut boundaries = Vec::new();
        let mut line_tokens = Vec::new();

        for (line_index, (line, _)) in lines.into_iter().enumerate() {
            let line_is_ascii = line.is_ascii();
            let line_length = if line_is_ascii {
                line.len()
            } else {
                line.encode_utf16().count()
            };
            if tokenize_options.max_line_length > 0
                && line_length >= tokenize_options.max_line_length
            {
                on_event(InlineLineEvent::PlainLine(line_index, line));
                continue;
            }

            let result = grammar
                .tokenize_line2(line, state, tokenize_options.time_limit_millis)
                .map_err(|error| {
                    Error::new(
                        ErrorKind::Tokenization,
                        format!("Failed to tokenize `{language}` line: {error}"),
                    )
                })?;
            let binary_tokens = result.tokens;
            state = Some(result.rule_stack);

            let utf16_map = if line_is_ascii {
                Utf16ToByteMap::Ascii(line.len())
            } else {
                utf16_to_byte_map_non_ascii(line, line_length)
            };

            boundaries.clear();
            boundaries.extend(
                binary_tokens
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|token| token[0] as usize)
                    .filter(|start| *start < line_length),
            );
            boundaries.push(line_length);

            line_tokens.clear();
            let mut token_index = 0;
            for range in boundaries.windows(2) {
                let start_index = range[0];
                let end_index = range[1];
                while binary_tokens
                    .get(token_index * 2 + 2)
                    .is_some_and(|next| *next as usize <= start_index)
                {
                    token_index += 1;
                }
                if start_index >= end_index {
                    continue;
                }
                let (Some(start_byte), Some(end_byte)) =
                    (utf16_map.get(start_index), utf16_map.get(end_index))
                else {
                    continue;
                };
                let Some(content) = line.get(start_byte..end_byte) else {
                    continue;
                };
                let attributes = EncodedTokenAttributes::new(binary_tokens[token_index * 2 + 1]);
                let color = sanitized_colors
                    .get(attributes.foreground() as usize)
                    .and_then(|color| color.as_deref());
                line_tokens.push(crate::render::BorrowedInlineToken {
                    content,
                    color,
                    font_style: attributes.font_style(),
                });
            }
            on_event(InlineLineEvent::Tokens(line_index, &line_tokens));
        }

        Ok((theme_name, background, foreground))
    }

    /// Node's serializable continuation bridge. The public Rust highlighter
    /// keeps its existing stack-based API; this method transports only the
    /// JSON representation needed by the JS facade.
    #[doc(hidden)]
    pub fn tokenize_with_grammar_state(
        &mut self,
        code: &str,
        language: &str,
        theme_id: &str,
        options: &TokenizeOptions,
        serialized_state: Option<&str>,
        capture_state: bool,
    ) -> Result<(HighlightTokensResult, Option<String>)> {
        let theme = self.activate_theme(theme_id)?.ok_or_else(|| {
            Error::new(
                ErrorKind::UnknownTheme,
                format!("Unknown theme `{theme_id}`."),
            )
        })?;
        // Tokenization only needs the output defaults. Cloning ThemeData here
        // also copies every raw theme rule on each warm highlight.
        let foreground = theme.foreground.clone();
        let background = theme.background.clone();
        let theme_name = theme.name.clone();
        if is_plain_language(language) || language == "ansi" {
            if serialized_state.is_some() || capture_state {
                return Err(Error::new(
                    ErrorKind::Tokenization,
                    "Invalid grammar state: plain language does not have grammar state.",
                ));
            }
            let tokens = split_lines(code)
                .into_iter()
                .map(|(line, offset)| {
                    if line.is_empty() {
                        Vec::new()
                    } else {
                        vec![HighlightToken {
                            content: line.to_owned(),
                            offset,
                            color: None,
                            font_style: None,
                            token_type: None,
                            scope_names: None,
                        }]
                    }
                })
                .collect();
            return Ok((
                HighlightTokensResult {
                    tokens,
                    foreground,
                    background,
                    theme_name,
                },
                None,
            ));
        }
        let grammar = self.grammar_for_language(language)?.ok_or_else(|| {
            Error::new(
                ErrorKind::UnknownLanguage,
                format!("Unknown language `{language}`."),
            )
        })?;
        let compiled_theme = self
            .compiled_themes
            .get(theme_id)
            .cloned()
            .ok_or_else(|| Error::from_reason("Compiled Ferriki theme disappeared."))?;
        let color_map = compiled_theme.color_map();
        let mut state = serialized_state
            .map(|serialized| grammar.deserialize_state_stack(serialized))
            .transpose()
            .map_err(|reason| Error::new(ErrorKind::Tokenization, reason))?;
        let lines = split_lines(code);
        let mut output_lines = Vec::with_capacity(lines.len());
        let mut boundaries = Vec::new();

        for (line, line_offset) in lines {
            // Empty lines still advance TextMate rules, even though they emit no output tokens.
            let line_is_ascii = line.is_ascii();
            let line_length = if line_is_ascii {
                line.len()
            } else {
                line.encode_utf16().count()
            };
            if options.max_line_length > 0 && line_length >= options.max_line_length {
                output_lines.push(vec![HighlightToken {
                    content: line.to_owned(),
                    offset: line_offset,
                    color: Some(String::new()),
                    font_style: Some(FontStyle::NONE),
                    token_type: options
                        .include_token_type
                        .then_some(StandardTokenType::Other),
                    scope_names: None,
                }]);
                continue;
            }

            let (scope_tokens, binary_tokens, rule_stack) =
                if options.include_scopes || options.preserve_scope_boundaries {
                    let result = grammar
                        .tokenize_line_with_scopes(line, state, options.time_limit_millis)
                        .map_err(|error| {
                            Error::new(
                                ErrorKind::Tokenization,
                                format!("Failed to tokenize `{language}` line scopes: {error}"),
                            )
                        })?;
                    (Some(result.tokens), result.binary_tokens, result.rule_stack)
                } else {
                    let result = grammar
                        .tokenize_line2(line, state, options.time_limit_millis)
                        .map_err(|error| {
                            Error::new(
                                ErrorKind::Tokenization,
                                format!("Failed to tokenize `{language}` line: {error}"),
                            )
                        })?;
                    (None, result.tokens, result.rule_stack)
                };
            let utf16_map = if line_is_ascii {
                Utf16ToByteMap::Ascii(line.len())
            } else {
                utf16_to_byte_map_non_ascii(line, line_length)
            };
            let mut line_tokens = Vec::with_capacity(binary_tokens.len() / 2);
            boundaries.clear();
            boundaries.extend(
                binary_tokens
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|token| token[0] as usize)
                    .filter(|start| *start < line_length),
            );
            boundaries.push(line_length);
            if options.preserve_scope_boundaries {
                for token in scope_tokens
                    .as_ref()
                    .expect("scope boundaries were requested")
                {
                    boundaries.push(token.start_index.min(line_length));
                    boundaries.push(token.end_index.min(line_length));
                }
                boundaries.sort_unstable();
                boundaries.dedup();
            }
            let mut token_index = 0;
            let mut scope_index = 0;
            for range in boundaries.windows(2) {
                let start_index = range[0];
                let end_index = range[1];
                while binary_tokens
                    .get(token_index * 2 + 2)
                    .is_some_and(|next| *next as usize <= start_index)
                {
                    token_index += 1;
                }
                if let Some(token) = token_from_metadata(
                    line,
                    &utf16_map,
                    start_index..end_index,
                    line_offset,
                    binary_tokens[token_index * 2 + 1],
                    color_map,
                    options.include_token_type,
                    scope_tokens.as_deref().and_then(|scopes| {
                        find_covering_scope_monotonic(
                            scopes,
                            &mut scope_index,
                            start_index,
                            end_index,
                        )
                    }),
                ) {
                    line_tokens.push(token);
                }
            }
            state = Some(rule_stack);
            output_lines.push(line_tokens);
        }

        let continuation = capture_state
            .then(|| grammar.serialize_state_stack(state.as_ref()))
            .transpose()
            .map_err(|reason| Error::new(ErrorKind::Tokenization, reason))?;
        Ok((
            HighlightTokensResult {
                tokens: output_lines,
                foreground,
                background,
                theme_name,
            },
            continuation,
        ))
    }

    pub fn tokenize_with_themes(
        &mut self,
        code: &str,
        language: &str,
        themes: &[(String, String)],
        options: &TokenizeOptions,
    ) -> Result<HighlightTokensWithThemesResult> {
        self.tokenize_with_grammar_state_and_themes(code, language, themes, options, None, false)
            .map(|(result, _)| result)
    }

    /// Multi-theme counterpart of [`Self::tokenize_with_grammar_state`].
    #[doc(hidden)]
    pub fn tokenize_with_grammar_state_and_themes(
        &mut self,
        code: &str,
        language: &str,
        themes: &[(String, String)],
        options: &TokenizeOptions,
        serialized_state: Option<&str>,
        capture_state: bool,
    ) -> Result<(HighlightTokensWithThemesResult, Option<String>)> {
        if themes.is_empty() {
            return Err(Error::from_reason("At least one theme is required."));
        }

        if themes.len() == 1 {
            let (variant_key, theme_id) = &themes[0];
            let (result, continuation) = self.tokenize_with_grammar_state(
                code,
                language,
                theme_id,
                options,
                serialized_state,
                capture_state,
            )?;
            let tokens = result
                .tokens
                .into_iter()
                .map(|line| {
                    line.into_iter()
                        .map(|token| HighlightThemeToken {
                            content: token.content,
                            offset: token.offset,
                            variants: BTreeMap::from([(
                                variant_key.clone(),
                                HighlightThemeTokenStyle {
                                    color: token.color,
                                    font_style: token.font_style,
                                },
                            )]),
                            token_type: token.token_type,
                            scope_names: token.scope_names,
                        })
                        .collect()
                })
                .collect();
            return Ok((
                HighlightTokensWithThemesResult {
                    tokens,
                    themes: vec![HighlightThemeMetadata {
                        color: variant_key.clone(),
                        name: result.theme_name,
                        foreground: result.foreground,
                        background: result.background,
                    }],
                },
                continuation,
            ));
        }

        // Validate and activate the first theme before checking the language so
        // error precedence matches running each theme independently.
        let (first_variant, first_theme_id) = &themes[0];
        let first_meta = {
            let theme = self.activate_theme(first_theme_id)?.ok_or_else(|| {
                Error::new(
                    ErrorKind::UnknownTheme,
                    format!("Unknown theme `{first_theme_id}`."),
                )
            })?;
            HighlightThemeMetadata {
                color: first_variant.clone(),
                name: theme.name.clone(),
                foreground: theme.foreground.clone(),
                background: theme.background.clone(),
            }
        };

        if is_plain_language(language) || language == "ansi" {
            if serialized_state.is_some() || capture_state {
                return Err(Error::new(
                    ErrorKind::Tokenization,
                    "Invalid grammar state: plain language does not have grammar state.",
                ));
            }
            let mut theme_metadata = Vec::with_capacity(themes.len());
            theme_metadata.push(first_meta);
            for (variant_key, theme_id) in &themes[1..] {
                let theme = self.activate_theme(theme_id)?.ok_or_else(|| {
                    Error::new(
                        ErrorKind::UnknownTheme,
                        format!("Unknown theme `{theme_id}`."),
                    )
                })?;
                theme_metadata.push(HighlightThemeMetadata {
                    color: variant_key.clone(),
                    name: theme.name.clone(),
                    foreground: theme.foreground.clone(),
                    background: theme.background.clone(),
                });
            }
            let tokens = split_lines(code)
                .into_iter()
                .map(|(line, offset)| {
                    if line.is_empty() {
                        Vec::new()
                    } else {
                        let mut variants = BTreeMap::new();
                        for (variant_key, _) in themes {
                            variants.insert(
                                variant_key.clone(),
                                HighlightThemeTokenStyle {
                                    color: None,
                                    font_style: None,
                                },
                            );
                        }
                        vec![HighlightThemeToken {
                            content: line.to_owned(),
                            offset,
                            variants,
                            token_type: None,
                            scope_names: None,
                        }]
                    }
                })
                .collect();
            return Ok((
                HighlightTokensWithThemesResult {
                    tokens,
                    themes: theme_metadata,
                },
                None,
            ));
        }

        let grammar = self.grammar_for_language(language)?.ok_or_else(|| {
            Error::new(
                ErrorKind::UnknownLanguage,
                format!("Unknown language `{language}`."),
            )
        })?;
        let mut state = serialized_state
            .map(|serialized| grammar.deserialize_state_stack(serialized))
            .transpose()
            .map_err(|reason| Error::new(ErrorKind::Tokenization, reason))?;

        let mut compiled_themes = Vec::with_capacity(themes.len());
        let mut theme_metadata = Vec::with_capacity(themes.len());
        let mut last_valid_theme_id = first_theme_id.as_str();
        compiled_themes.push(
            self.compiled_themes
                .get(first_theme_id)
                .cloned()
                .ok_or_else(|| Error::from_reason("Compiled Ferriki theme disappeared."))?,
        );
        theme_metadata.push(first_meta);

        // Defer lookup errors for themes[1..] until after the grammar scan and
        // state capture succeed so a tokenization failure on theme 0 keeps the
        // same error precedence as sequential per-theme runs.
        let mut deferred_theme_error = None;
        for (variant_key, theme_id) in &themes[1..] {
            match self.ensure_compiled_theme(theme_id) {
                Ok(Some(compiled)) => {
                    let theme = self
                        .themes
                        .get(theme_id)
                        .ok_or_else(|| Error::from_reason("Loaded Ferriki theme disappeared."))?;
                    compiled_themes.push(compiled);
                    theme_metadata.push(HighlightThemeMetadata {
                        color: variant_key.clone(),
                        name: theme.name.clone(),
                        foreground: theme.foreground.clone(),
                        background: theme.background.clone(),
                    });
                    last_valid_theme_id = theme_id.as_str();
                }
                Ok(None) => {
                    deferred_theme_error = Some(Error::new(
                        ErrorKind::UnknownTheme,
                        format!("Unknown theme `{theme_id}`."),
                    ));
                    break;
                }
                Err(error) => {
                    deferred_theme_error = Some(error);
                    break;
                }
            }
        }

        let need_scopes = deferred_theme_error.is_none()
            && (options.include_scopes || options.preserve_scope_boundaries);
        let lines = split_lines(code);
        let mut output_lines = if deferred_theme_error.is_none() {
            Vec::with_capacity(lines.len())
        } else {
            Vec::new()
        };
        let mut boundaries = Vec::new();
        let mut cursors = vec![0usize; compiled_themes.len()];
        for (line, line_offset) in lines {
            // Empty lines still advance TextMate rules, even though they emit no output tokens.
            let line_is_ascii = line.is_ascii();
            let line_length = if line_is_ascii {
                line.len()
            } else {
                line.encode_utf16().count()
            };
            if options.max_line_length > 0 && line_length >= options.max_line_length {
                if deferred_theme_error.is_none() {
                    let mut variants = BTreeMap::new();
                    for (variant_key, _) in themes {
                        variants.insert(
                            variant_key.clone(),
                            HighlightThemeTokenStyle {
                                color: Some(String::new()),
                                font_style: Some(FontStyle::NONE),
                            },
                        );
                    }
                    output_lines.push(vec![HighlightThemeToken {
                        content: line.to_owned(),
                        offset: line_offset,
                        variants,
                        token_type: options
                            .include_token_type
                            .then_some(StandardTokenType::Other),
                        scope_names: None,
                    }]);
                }
                continue;
            }

            let line_result = grammar
                .tokenize_line_with_themes(
                    line,
                    state,
                    if deferred_theme_error.is_some() {
                        &[]
                    } else {
                        &compiled_themes
                    },
                    need_scopes,
                    options.time_limit_millis,
                )
                .map_err(|error| {
                    Error::new(
                        ErrorKind::Tokenization,
                        format!("Failed to tokenize `{language}` line: {error}"),
                    )
                })?;
            state = Some(line_result.rule_stack);

            if deferred_theme_error.is_some() {
                continue;
            }

            if line_length == 0 {
                output_lines.push(Vec::new());
                continue;
            }

            let utf16_map = if line_is_ascii {
                Utf16ToByteMap::Ascii(line.len())
            } else {
                utf16_to_byte_map_non_ascii(line, line_length)
            };
            let binary_sets = &line_result.binary_tokens;
            let scope_tokens = line_result.tokens.as_deref();

            boundaries.clear();
            for binary_tokens in binary_sets {
                boundaries.extend(
                    binary_tokens
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|token| token[0] as usize)
                        .filter(|start| *start < line_length),
                );
            }
            boundaries.push(line_length);
            if options.preserve_scope_boundaries {
                for token in scope_tokens.expect("scope boundaries were requested") {
                    boundaries.push(token.start_index.min(line_length));
                    boundaries.push(token.end_index.min(line_length));
                }
            }
            boundaries.sort_unstable();
            boundaries.dedup();

            cursors.fill(0);
            let mut scope_index = 0usize;
            let mut line_tokens = Vec::with_capacity(boundaries.len().saturating_sub(1));

            for range in boundaries.windows(2) {
                let start_index = range[0];
                let end_index = range[1];
                if start_index >= end_index {
                    continue;
                }
                let Some(start_byte) = utf16_map.get(start_index) else {
                    continue;
                };
                let Some(end_byte) = utf16_map.get(end_index) else {
                    continue;
                };
                let Some(content) = line.get(start_byte..end_byte) else {
                    continue;
                };

                let mut variants = BTreeMap::new();
                let mut first_token_type = None;
                for (theme_index, binary_tokens) in binary_sets.iter().enumerate() {
                    let cursor = &mut cursors[theme_index];
                    while binary_tokens
                        .get(*cursor * 2 + 2)
                        .is_some_and(|next| *next as usize <= start_index)
                    {
                        *cursor += 1;
                    }
                    let attributes = EncodedTokenAttributes::new(binary_tokens[*cursor * 2 + 1]);
                    if theme_index == 0 && options.include_token_type {
                        first_token_type = Some(attributes.token_type());
                    }
                    let color_map = compiled_themes[theme_index].color_map();
                    variants.insert(
                        themes[theme_index].0.clone(),
                        HighlightThemeTokenStyle {
                            color: Some(
                                color_map
                                    .get(attributes.foreground() as usize)
                                    .cloned()
                                    .unwrap_or_default(),
                            ),
                            font_style: Some(attributes.font_style()),
                        },
                    );
                }

                let scope_names = scope_tokens.and_then(|scopes| {
                    let (scope_start, scope_end) = if options.preserve_scope_boundaries {
                        (start_index, end_index)
                    } else {
                        let binary0 = &binary_sets[0];
                        let c0 = cursors[0];
                        let s0 = binary0[c0 * 2] as usize;
                        let e0 = binary0
                            .get(c0 * 2 + 2)
                            .map_or(line_length, |next| (*next as usize).min(line_length));
                        (s0, e0)
                    };
                    find_covering_scope_monotonic(scopes, &mut scope_index, scope_start, scope_end)
                });

                line_tokens.push(HighlightThemeToken {
                    content: content.to_owned(),
                    offset: line_offset + start_index,
                    variants,
                    token_type: first_token_type,
                    scope_names,
                });
            }
            output_lines.push(line_tokens);
        }

        let continuation = capture_state
            .then(|| grammar.serialize_state_stack(state.as_ref()))
            .transpose()
            .map_err(|reason| Error::new(ErrorKind::Tokenization, reason))?;

        // Leave the last valid theme active, matching multi-pass activation order
        // only after tokenization and state serialization succeed.
        if let Some(last_compiled) = compiled_themes.last()
            && self.active_theme.as_deref() != Some(last_valid_theme_id)
        {
            self.registry.set_compiled_theme(Arc::clone(last_compiled));
            self.active_theme = Some(last_valid_theme_id.to_owned());
        }

        if let Some(error) = deferred_theme_error {
            return Err(error);
        }
        Ok((
            HighlightTokensWithThemesResult {
                tokens: output_lines,
                themes: theme_metadata,
            },
            continuation,
        ))
    }
}

/// Finds the unique non-overlapping scope token covering `[start_index, end_index)`
/// using a monotonic cursor, matching `scopes.iter().find(...)` in O(1) amortized time.
fn find_covering_scope_monotonic(
    scopes: &[ferriki_textmate::Token],
    scope_index: &mut usize,
    start_index: usize,
    end_index: usize,
) -> Option<Vec<String>> {
    let mut entries_examined = 0;
    find_covering_scope_monotonic_counted(
        scopes,
        scope_index,
        start_index,
        end_index,
        &mut entries_examined,
    )
}

fn find_covering_scope_monotonic_counted(
    scopes: &[ferriki_textmate::Token],
    scope_index: &mut usize,
    start_index: usize,
    end_index: usize,
    entries_examined: &mut usize,
) -> Option<Vec<String>> {
    while scopes.get(*scope_index).is_some_and(|token| {
        *entries_examined += 1;
        token.end_index <= start_index
    }) {
        *scope_index += 1;
    }
    scopes
        .get(*scope_index)
        .filter(|token| {
            *entries_examined += 1;
            token.start_index <= start_index && token.end_index >= end_index
        })
        .map(|token| token.scopes.clone())
}

fn scope_matches(candidate: &str, scope_name: &str) -> bool {
    candidate == scope_name
        || scope_name
            .strip_prefix(candidate)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

enum CustomLanguageJson {
    NotObject,
    Object {
        name: Option<Option<String>>,
        aliases: Option<Value>,
        inject_to: Option<Value>,
        grammar: Box<RawGrammar>,
    },
}

struct CustomLanguageJsonSeed<'a> {
    captured_name: &'a mut Option<Option<String>>,
}

impl<'de> DeserializeSeed<'de> for CustomLanguageJsonSeed<'_> {
    type Value = CustomLanguageJson;

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(CustomLanguageVisitor {
            captured_name: self.captured_name,
        })
    }
}

struct CustomLanguageVisitor<'a> {
    captured_name: &'a mut Option<Option<String>>,
}

impl<'de> Visitor<'de> for CustomLanguageVisitor<'_> {
    type Value = CustomLanguageJson;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON object representing a custom language registration")
    }

    fn visit_bool<E>(self, _: bool) -> std::result::Result<Self::Value, E> {
        Ok(CustomLanguageJson::NotObject)
    }

    fn visit_i64<E>(self, _: i64) -> std::result::Result<Self::Value, E> {
        Ok(CustomLanguageJson::NotObject)
    }

    fn visit_u64<E>(self, _: u64) -> std::result::Result<Self::Value, E> {
        Ok(CustomLanguageJson::NotObject)
    }

    fn visit_f64<E>(self, _: f64) -> std::result::Result<Self::Value, E> {
        Ok(CustomLanguageJson::NotObject)
    }

    fn visit_str<E>(self, _: &str) -> std::result::Result<Self::Value, E> {
        Ok(CustomLanguageJson::NotObject)
    }

    fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> {
        Ok(CustomLanguageJson::NotObject)
    }

    fn visit_seq<A>(self, mut seq: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while seq.next_element::<de::IgnoredAny>()?.is_some() {}
        Ok(CustomLanguageJson::NotObject)
    }

    fn visit_map<A>(self, map: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut aliases = None;
        let mut inject_to = None;
        let grammar = RawGrammar::deserialize(SingleMapDeserializer(InterceptingMapAccess {
            inner: map,
            name: self.captured_name,
            aliases: &mut aliases,
            inject_to: &mut inject_to,
        }))?;
        Ok(CustomLanguageJson::Object {
            name: self.captured_name.take(),
            aliases,
            inject_to,
            grammar: Box::new(grammar),
        })
    }
}

struct InterceptingMapAccess<'a, A> {
    inner: A,
    name: &'a mut Option<Option<String>>,
    aliases: &'a mut Option<Value>,
    inject_to: &'a mut Option<Value>,
}

impl<'de, A> MapAccess<'de> for InterceptingMapAccess<'_, A>
where
    A: MapAccess<'de>,
{
    type Error = A::Error;

    fn next_key_seed<K>(&mut self, seed: K) -> std::result::Result<Option<K::Value>, Self::Error>
    where
        K: DeserializeSeed<'de>,
    {
        while let Some(key) = self.inner.next_key::<Cow<'de, str>>()? {
            match key.as_ref() {
                "name" => {
                    if self.name.is_some() {
                        return Err(de::Error::duplicate_field("name"));
                    }
                    let value = self.inner.next_value::<Value>()?;
                    *self.name = Some(match value {
                        Value::String(name) => Some(name),
                        _ => None,
                    });
                }
                "aliases" => {
                    *self.aliases = Some(self.inner.next_value::<Value>()?);
                }
                "injectTo" => {
                    *self.inject_to = Some(self.inner.next_value::<Value>()?);
                }
                _ => return seed.deserialize(key.into_deserializer()).map(Some),
            }
        }
        Ok(None)
    }

    fn next_value_seed<V>(&mut self, seed: V) -> std::result::Result<V::Value, Self::Error>
    where
        V: DeserializeSeed<'de>,
    {
        self.inner.next_value_seed(seed)
    }
}

struct SingleMapDeserializer<A>(A);

impl<'de, A> serde::Deserializer<'de> for SingleMapDeserializer<A>
where
    A: MapAccess<'de>,
{
    type Error = A::Error;

    fn deserialize_any<V>(self, visitor: V) -> std::result::Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        visitor.visit_map(self.0)
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf option unit unit_struct newtype_struct seq tuple
        tuple_struct map struct enum identifier ignored_any
    }
}

fn take_string_array(value: Option<Value>, key: &str) -> Result<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Value::Array(values) = value else {
        return Err(Error::new(
            ErrorKind::InvalidRegistration,
            format!("Language registration `{key}` must be an array."),
        ));
    };
    values
        .into_iter()
        .map(|value| match value {
            Value::String(item) => Ok(item),
            _ => Err(Error::new(
                ErrorKind::InvalidRegistration,
                format!("Language registration `{key}` must contain strings."),
            )),
        })
        .collect()
}

fn is_plain_language(language: &str) -> bool {
    matches!(language, "text" | "txt" | "plain" | "plaintext")
}

fn custom_theme_registration_error(error: ferriki_textmate::ThemeError) -> Error {
    match error {
        ferriki_textmate::ThemeError::ColorMapOverflow { .. } => Error::new(
            ErrorKind::InvalidRegistration,
            format!("Invalid TextMate theme registration: {error}"),
        ),
        other => theme_error(other),
    }
}

fn theme_error(error: ferriki_textmate::ThemeError) -> Error {
    match error {
        ferriki_textmate::ThemeError::InvalidScopeSelector(message) => Error::new(
            ErrorKind::InvalidRegistration,
            format!("Invalid TextMate scope selector: {message}"),
        ),
        ferriki_textmate::ThemeError::InvalidLanguageId { .. } => Error::new(
            ErrorKind::InvalidRegistration,
            format!("Invalid TextMate language configuration: {error}"),
        ),
        other => Error::new(
            ErrorKind::Theme,
            format!("Failed to resolve TextMate theme: {other}"),
        ),
    }
}

impl LanguageRegistration {
    /// Registers a parsed grammar under a language ID, without aliases or injections.
    pub fn new(id: impl Into<String>, grammar: RawGrammar) -> Self {
        Self {
            id: id.into(),
            grammar,
            aliases: Vec::new(),
            inject_to: Vec::new(),
        }
    }
    #[must_use]
    pub fn with_aliases(mut self, aliases: impl IntoIterator<Item = String>) -> Self {
        self.aliases = aliases.into_iter().collect();
        self
    }
    #[must_use]
    pub fn with_injections(mut self, scopes: impl IntoIterator<Item = String>) -> Self {
        self.inject_to = scopes.into_iter().collect();
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::utf16_to_byte_map;

    fn standard_highlighter() -> HighlighterCore {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/standard");
        HighlighterCore::with_standard_assets(&root).expect("highlighter")
    }

    fn unlimited_tokenize_options() -> TokenizeOptions {
        TokenizeOptions {
            time_limit_millis: 0,
            ..TokenizeOptions::default()
        }
    }

    #[test]
    fn retained_scope_boundaries_are_independent_of_theme_merging() {
        let mut highlighter = standard_highlighter();
        let code = "{\"message\":\"hello😀\"}";
        let options = unlimited_tokenize_options().with_preserve_scope_boundaries(true);
        let monokai = highlighter
            .tokenize(code, "json", "monokai", &options)
            .expect("tokens");
        let nord = highlighter
            .tokenize(code, "json", "nord", &options)
            .expect("tokens");
        let paths = |result: &HighlightTokensResult| {
            result.tokens[0]
                .iter()
                .map(|token| (token.content.clone(), token.scope_names.clone()))
                .collect::<Vec<_>>()
        };
        assert_eq!(paths(&monokai), paths(&nord));
        assert_eq!(
            monokai.tokens[0]
                .iter()
                .map(|token| token.content.as_str())
                .collect::<String>(),
            code
        );
        let value = monokai.tokens[0]
            .iter()
            .find(|token| token.content == "hello😀")
            .expect("JSON value");
        assert_eq!(value.color.as_deref(), Some("#CFCFC2"));
        assert!(
            value
                .scope_names
                .as_ref()
                .expect("scopes")
                .iter()
                .any(|scope| scope == "meta.structure.dictionary.json")
        );
    }

    #[test]
    fn opens_registered_packages_without_optional_fenced_languages() {
        let mut highlighter = standard_highlighter();
        highlighter.load_standard_language("vue").unwrap();
        let catalogs = highlighter.standard_assets.as_ref().unwrap();
        let expected = highlighter
            .loaded_language_ids
            .iter()
            .map(|id| catalogs.languages.scope_name(id).unwrap().to_owned())
            .collect::<BTreeSet<_>>();
        assert_eq!(highlighter.prepared_language_scopes, expected);
        assert!(!highlighter.prepared_language_scopes.contains("source.rust"));
        assert!(highlighter.resolve_scope("typescript").is_some());
        highlighter.load_standard_language("ts").unwrap();
        assert_eq!(
            highlighter.prepared_language_scopes, expected,
            "an explicit load reuses the already registered dependency package"
        );
        assert!(highlighter.prepared_language_scopes.contains("source.ts"));
        highlighter.dispose();
        assert!(highlighter.prepared_language_scopes.is_empty());
        assert!(highlighter.delegated_language_scopes.is_empty());
    }

    #[test]
    fn loads_standard_language_dependencies_and_aliases() {
        let mut highlighter = standard_highlighter();

        assert_eq!(
            highlighter.load_standard_language("vue").expect("language"),
            Some("text.html.vue".to_owned())
        );
        assert_eq!(
            highlighter.resolve_scope("vue"),
            Some("text.html.vue".to_owned())
        );
        assert!(
            highlighter
                .loaded_scopes()
                .contains(&"source.js".to_owned())
        );
        assert!(
            highlighter
                .loaded_scopes()
                .contains(&"text.html.basic".to_owned())
        );
        assert!(
            highlighter
                .loaded_languages()
                .contains(&"javascript".to_owned())
        );
        assert!(highlighter.loaded_languages().contains(&"js".to_owned()));
        assert!(!highlighter.loaded_languages().contains(&"scss".to_owned()));
        assert!(
            highlighter
                .grammar_for_language("vue")
                .expect("grammar")
                .is_some()
        );
    }

    #[test]
    fn activates_standard_theme_in_textmate_registry() {
        let mut highlighter = standard_highlighter();
        let theme = highlighter
            .activate_theme("nord")
            .expect("theme")
            .expect("nord");

        assert_eq!(theme.name, "nord");
        assert_eq!(theme.foreground.to_ascii_uppercase(), "#D8DEE9FF");
        assert_eq!(theme.background.to_ascii_uppercase(), "#2E3440FF");
    }

    #[test]
    fn external_injections_are_loaded_for_target_scope() {
        let mut highlighter = standard_highlighter();
        highlighter
            .load_standard_language("typescript")
            .expect("typescript");
        highlighter
            .load_standard_language("es-tag-css")
            .expect("css injection");
        highlighter
            .load_standard_language("es-tag-html")
            .expect("html injection");

        let injections = highlighter.registry.injections("source.ts");
        assert!(injections.contains(&"inline.es6-css".to_owned()));
        assert!(injections.contains(&"inline.es6-html".to_owned()));
    }

    #[test]
    fn tokenizes_vue_directives_with_embedded_typescript() {
        let mut highlighter = standard_highlighter();
        let grammar = highlighter
            .grammar_for_language("vue")
            .expect("grammar")
            .expect("vue grammar");
        let line = r#"<h1 v-if="count == 1 ? true : 'str'.toUpperCase()"></h1>"#;

        let result = grammar.tokenize_line(line, None, 0).expect("tokens");
        let actual = result
            .tokens
            .iter()
            .map(|token| {
                (
                    &line[token.start_index..token.end_index],
                    token.scopes.last().map(String::as_str),
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            actual,
            [
                ("<", Some("punctuation.definition.tag.begin.html.vue")),
                ("h1", Some("entity.name.tag.h1.html.vue")),
                (" ", Some("meta.tag-stuff")),
                ("v-if", Some("keyword.control.conditional.vue")),
                ("=", Some("punctuation.separator.key-value.html.vue")),
                ("\"", Some("punctuation.definition.string.begin.html.vue")),
                ("count", Some("variable.other.readwrite.ts")),
                (" ", Some("source.ts.embedded.html.vue")),
                ("==", Some("keyword.operator.comparison.ts")),
                (" ", Some("source.ts.embedded.html.vue")),
                ("1", Some("constant.numeric.decimal.ts")),
                (" ", Some("source.ts.embedded.html.vue")),
                ("?", Some("keyword.operator.ternary.ts")),
                (" ", Some("source.ts.embedded.html.vue")),
                ("true", Some("constant.language.boolean.true.ts")),
                (" ", Some("source.ts.embedded.html.vue")),
                (":", Some("keyword.operator.ternary.ts")),
                (" ", Some("source.ts.embedded.html.vue")),
                ("'", Some("punctuation.definition.string.begin.ts")),
                ("str", Some("string.quoted.single.ts")),
                ("'", Some("punctuation.definition.string.end.ts")),
                (".", Some("punctuation.accessor.ts")),
                ("toUpperCase", Some("entity.name.function.ts")),
                ("(", Some("meta.brace.round.ts")),
                (")", Some("meta.brace.round.ts")),
                ("\"", Some("punctuation.definition.string.end.html.vue")),
                (">", Some("punctuation.definition.tag.end.html.vue")),
                ("</", Some("punctuation.definition.tag.begin.html.vue")),
                ("h1", Some("entity.name.tag.h1.html.vue")),
                (">", Some("punctuation.definition.tag.end.html.vue")),
            ]
        );
    }

    #[test]
    fn tokenizes_standard_javascript_with_textmate_theme_metadata() {
        let mut highlighter = standard_highlighter();
        let result = highlighter
            .tokenize(
                "console.log(\"Hi\")",
                "javascript",
                "nord",
                &unlimited_tokenize_options(),
            )
            .expect("tokens");

        let pairs = result.tokens[0]
            .iter()
            .map(|token| {
                (
                    token.content.as_str(),
                    token.color.as_deref().expect("styled token"),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            pairs,
            [
                ("console", "#D8DEE9"),
                (".", "#ECEFF4"),
                ("log", "#88C0D0"),
                ("(", "#D8DEE9FF"),
                ("\"", "#ECEFF4"),
                ("Hi", "#A3BE8C"),
                ("\"", "#ECEFF4"),
                (")", "#D8DEE9FF"),
            ]
        );
        assert_eq!(result.theme_name, "nord");
        assert_eq!(result.tokens[0][0].offset, 0);
        assert_eq!(result.tokens[0][1].offset, 7);
    }

    #[test]
    fn tokenizes_multiline_utf16_offsets_and_optional_types() {
        let mut highlighter = standard_highlighter();
        let result = highlighter
            .tokenize(
                "\"😀\"\r\n// x\n",
                "javascript",
                "nord",
                &TokenizeOptions {
                    time_limit_millis: 0,
                    include_token_type: true,
                    ..TokenizeOptions::default()
                },
            )
            .expect("tokens");

        assert_eq!(result.tokens.len(), 3);
        assert_eq!(result.tokens[1][0].offset, 6);
        assert_eq!(
            result.tokens[1][0].token_type,
            Some(StandardTokenType::Comment)
        );
        assert!(result.tokens[2].is_empty());
    }

    #[test]
    fn retains_scope_paths_when_requested_for_explanations() {
        let mut highlighter = standard_highlighter();
        let result = highlighter
            .tokenize(
                "console.log(1)",
                "javascript",
                "nord",
                &TokenizeOptions {
                    time_limit_millis: 0,
                    include_scopes: true,
                    ..TokenizeOptions::default()
                },
            )
            .expect("tokens");

        let console = &result.tokens[0][0];
        assert_eq!(console.content, "console");
        assert!(
            console
                .scope_names
                .as_ref()
                .is_some_and(|scopes| scopes.iter().any(|scope| scope == "source.js"))
        );
    }

    #[test]
    fn emits_unstyled_plaintext_tokens_without_loading_a_grammar() {
        let mut highlighter = standard_highlighter();
        let result = highlighter
            .tokenize("plain\n", "text", "nord", &TokenizeOptions::default())
            .expect("tokens");

        assert_eq!(result.tokens.len(), 2);
        assert_eq!(result.tokens[0][0].content, "plain");
        assert_eq!(result.tokens[0][0].color, None);
        assert_eq!(result.tokens[0][0].font_style, None);
        assert!(result.tokens[1].is_empty());
    }

    #[test]
    fn continuation_after_empty_line_matches_textmate_state_advancement() {
        let mut highlighter = HighlighterCore::new().expect("highlighter");
        highlighter
            .register_theme(parse_theme_data("blank-end-theme", "{}").expect("theme"))
            .expect("theme registration");
        let raw = parse_raw_grammar(
            r#"{"scopeName":"source.blank-end","patterns":[{"begin":"BEGIN","end":"^$","name":"meta.block"}]}"#,
            Some("blank-end.json"),
        )
        .expect("grammar");
        highlighter
            .register_language(LanguageRegistration::new("blank-end", raw))
            .expect("grammar registration");
        let grammar = highlighter
            .grammar_for_language("blank-end")
            .expect("compiled grammar")
            .expect("registered grammar");

        let opened = grammar
            .tokenize_line2("BEGIN", None, 0)
            .expect("begin line");
        let expected = grammar
            .tokenize_line2("", Some(opened.rule_stack), 0)
            .expect("empty line")
            .rule_stack;
        let expected = grammar
            .serialize_state_stack(Some(&expected))
            .expect("serialized lower-level state");

        let (_, actual) = highlighter
            .tokenize_with_grammar_state(
                "BEGIN\n",
                "blank-end",
                "blank-end-theme",
                &unlimited_tokenize_options(),
                None,
                true,
            )
            .expect("high-level continuation");
        assert_eq!(actual.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn dispose_releases_assets_registrations_and_compiled_state() {
        let mut highlighter = standard_highlighter();
        highlighter
            .load_standard_language("javascript")
            .expect("javascript");
        highlighter.load_standard_theme("nord").expect("nord");
        highlighter
            .grammar_for_language("javascript")
            .expect("grammar")
            .expect("javascript grammar");
        assert!(highlighter.standard_assets.is_some());
        assert!(!highlighter.themes.is_empty());

        highlighter.dispose();

        assert!(highlighter.standard_assets.is_none());
        assert!(highlighter.themes.is_empty());
        assert!(highlighter.compiled_themes.is_empty());
        assert!(highlighter.loaded_languages().is_empty());
        assert!(highlighter.registry.lookup("source.js").is_none());
    }

    /// Reference multi-pass merge mirroring the pre-single-pass implementation,
    /// used in parity tests and benchmarks to verify exact equivalence.
    fn reference_multi_theme_tokenize(
        highlighter: &mut HighlighterCore,
        code: &str,
        language: &str,
        themes: &[(String, String)],
        options: &TokenizeOptions,
        serialized_state: Option<&str>,
        capture_state: bool,
    ) -> Result<(HighlightTokensWithThemesResult, Option<String>)> {
        reference_multi_theme_tokenize_with_mode(
            highlighter,
            code,
            language,
            themes,
            options,
            serialized_state,
            capture_state,
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn reference_multi_theme_tokenize_with_mode(
        highlighter: &mut HighlighterCore,
        code: &str,
        language: &str,
        themes: &[(String, String)],
        options: &TokenizeOptions,
        serialized_state: Option<&str>,
        capture_state: bool,
        recompile_each_switch: bool,
    ) -> Result<(HighlightTokensWithThemesResult, Option<String>)> {
        let results = themes
            .iter()
            .map(|(_, theme)| {
                if recompile_each_switch {
                    highlighter.compiled_themes.remove(theme);
                    if highlighter.active_theme.as_deref() == Some(theme.as_str()) {
                        highlighter.active_theme = None;
                    }
                }
                highlighter.tokenize_with_grammar_state(
                    code,
                    language,
                    theme,
                    options,
                    serialized_state,
                    capture_state,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        let mut output_lines = Vec::new();
        for line_index in 0..results[0].0.tokens.len() {
            let lines: Vec<_> = results
                .iter()
                .map(|result| &result.0.tokens[line_index])
                .collect();
            let mut boundaries = BTreeSet::new();
            for line in &lines {
                for token in *line {
                    boundaries.insert(token.offset);
                    boundaries.insert(token.offset + token.content.encode_utf16().count());
                }
            }
            let boundaries: Vec<_> = boundaries.into_iter().collect();
            let mut cursors = vec![0; lines.len()];
            let mut tokens = Vec::new();
            for range in boundaries.windows(2) {
                let start = range[0];
                let end = range[1];
                let mut variants = BTreeMap::new();
                let mut base = None;
                for (index, line) in lines.iter().enumerate() {
                    while line[cursors[index]].offset
                        + line[cursors[index]].content.encode_utf16().count()
                        <= start
                    {
                        cursors[index] += 1;
                    }
                    let token = &line[cursors[index]];
                    base.get_or_insert(token);
                    variants.insert(
                        themes[index].0.clone(),
                        HighlightThemeTokenStyle {
                            color: token.color.clone(),
                            font_style: token.font_style,
                        },
                    );
                }
                let token = base.expect("a token boundary has a source token");
                let map = utf16_to_byte_map(&token.content);
                let start_byte = map.get(start - token.offset).expect("start in token");
                let end_byte = map.get(end - token.offset).expect("end in token");
                tokens.push(HighlightThemeToken {
                    content: token.content[start_byte..end_byte].to_owned(),
                    offset: start,
                    variants,
                    token_type: token.token_type,
                    scope_names: token.scope_names.clone(),
                });
            }
            output_lines.push(tokens);
        }
        let continuation = results
            .first()
            .and_then(|(_, continuation)| continuation.clone());
        Ok((
            HighlightTokensWithThemesResult {
                tokens: output_lines,
                themes: themes
                    .iter()
                    .zip(results.iter())
                    .map(|((color, _), (result, _))| HighlightThemeMetadata {
                        color: color.clone(),
                        name: result.theme_name.clone(),
                        foreground: result.foreground.clone(),
                        background: result.background.clone(),
                    })
                    .collect(),
            },
            continuation,
        ))
    }

    #[test]
    fn monotonic_scope_cursor_matches_linear_find_and_scales_linearly() {
        let mut highlighter = HighlighterCore::new().expect("highlighter");
        highlighter
            .register_theme(
                parse_theme_data(
                    "pair-theme",
                    r##"{
                        "colors": { "editor.foreground": "#dddddd", "editor.background": "#111111" },
                        "tokenColors": [
                            { "scope": "keyword.a", "settings": { "foreground": "#ff0000" } },
                            { "scope": "keyword.b", "settings": { "foreground": "#ff0000" } }
                        ]
                    }"##,
                )
                .expect("theme"),
            )
            .expect("theme registration");
        let raw = parse_raw_grammar(
            r#"{
                "scopeName": "source.pairs",
                "patterns": [
                    { "match": "a", "name": "keyword.a" },
                    { "match": "b", "name": "keyword.b" },
                    { "match": "c", "name": "string.c" }
                ]
            }"#,
            Some("pairs.json"),
        )
        .expect("grammar");
        highlighter
            .register_language(LanguageRegistration::new("pairs", raw))
            .expect("grammar registration");

        // Verify exact parity against linear scan across sub-ranges, merged multi-scope spans,
        // exact boundaries, and trailing ranges past the end of scopes.
        let grammar = highlighter
            .grammar_for_language("pairs")
            .expect("grammar lookup")
            .expect("grammar");
        let scopes = grammar
            .tokenize_line("abccba", None, 0)
            .expect("scopes")
            .tokens;
        let ranges = [
            (0, 1),
            (0, 2), // spans two scopes -> None
            (1, 2),
            (2, 3),
            (2, 4), // spans two scopes -> None
            (3, 4),
            (4, 5),
            (5, 6),
            (6, 7), // past end -> None
        ];
        let mut cursor = 0;
        for (start, end) in ranges {
            let linear = scopes
                .iter()
                .find(|token| token.start_index <= start && token.end_index >= end)
                .map(|token| token.scopes.clone());
            let monotonic = find_covering_scope_monotonic(&scopes, &mut cursor, start, end);
            assert_eq!(monotonic, linear, "range {start}..{end}");
        }
        let mut empty_cursor = 0;
        assert_eq!(
            find_covering_scope_monotonic(&[], &mut empty_cursor, 0, 1),
            None
        );

        // Long line with 24,000 short tokens: verify end-to-end scope output and
        // deterministically assert O(T) scope-entry examinations via the cursor.
        let long_line = "ab".repeat(12_000);
        let options = TokenizeOptions {
            time_limit_millis: 0,
            include_scopes: true,
            preserve_scope_boundaries: true,
            ..TokenizeOptions::default()
        };
        let result = highlighter
            .tokenize(&long_line, "pairs", "pair-theme", &options)
            .expect("long line tokens");

        assert_eq!(result.tokens.len(), 1);
        assert_eq!(result.tokens[0].len(), 24_000);
        assert_eq!(
            result.tokens[0][0].scope_names.as_deref(),
            Some(&["source.pairs".to_owned(), "keyword.a".to_owned()][..])
        );
        assert_eq!(
            result.tokens[0][23_999].scope_names.as_deref(),
            Some(&["source.pairs".to_owned(), "keyword.b".to_owned()][..])
        );

        let long_scopes = grammar
            .tokenize_line(&long_line, None, 0)
            .expect("long scopes")
            .tokens;
        assert_eq!(long_scopes.len(), 24_000);
        let mut long_cursor = 0;
        let mut entries_examined = 0;
        for (index, token) in long_scopes.iter().enumerate() {
            let matched = find_covering_scope_monotonic_counted(
                &long_scopes,
                &mut long_cursor,
                token.start_index,
                token.end_index,
                &mut entries_examined,
            );
            assert_eq!(matched.as_ref(), Some(&token.scopes));
            assert_eq!(
                result.tokens[0][index].scope_names.as_ref(),
                matched.as_ref()
            );
        }
        // Linear cursor visits each entry at most O(1) times (vs ~2.88e8 for O(T^2)).
        assert!(
            entries_examined <= 3 * long_scopes.len(),
            "expected linear scope cursor work (<= {}), examined {entries_examined}",
            3 * long_scopes.len()
        );
    }

    #[test]
    fn repeated_theme_switching_reuses_compiled_arc_and_invalidates_on_reregister() {
        let mut highlighter = HighlighterCore::new().expect("highlighter");
        let raw = parse_raw_grammar(
            r#"{"scopeName":"source.switch","patterns":[{"match":"x","name":"keyword.x"}]}"#,
            Some("switch.json"),
        )
        .expect("grammar");
        highlighter
            .register_language(LanguageRegistration::new("switch", raw))
            .expect("grammar registration");
        highlighter
            .register_theme(
                parse_theme_data(
                    "light",
                    r##"{"tokenColors":[{"scope":"keyword.x","settings":{"foreground":"#111111"}}]}"##,
                )
                .expect("light"),
            )
            .expect("light registration");
        highlighter
            .register_theme(
                parse_theme_data(
                    "dark",
                    r##"{"tokenColors":[{"scope":"keyword.x","settings":{"foreground":"#eeeeee"}}]}"##,
                )
                .expect("dark"),
            )
            .expect("dark registration");

        let opts = unlimited_tokenize_options();
        let first_light = highlighter
            .tokenize("x", "switch", "light", &opts)
            .expect("light");
        assert_eq!(first_light.tokens[0][0].color.as_deref(), Some("#111111"));
        let light_arc = Arc::clone(
            highlighter
                .compiled_themes
                .get("light")
                .expect("cached light"),
        );

        let first_dark = highlighter
            .tokenize("x", "switch", "dark", &opts)
            .expect("dark");
        assert_eq!(first_dark.tokens[0][0].color.as_deref(), Some("#EEEEEE"));
        let dark_arc = Arc::clone(
            highlighter
                .compiled_themes
                .get("dark")
                .expect("cached dark"),
        );

        // Repeated alternating switches must keep the exact same compiled Arc<Theme> instances.
        for _ in 0..5 {
            let light = highlighter
                .tokenize("x", "switch", "light", &opts)
                .expect("light");
            let dark = highlighter
                .tokenize("x", "switch", "dark", &opts)
                .expect("dark");
            assert_eq!(light, first_light);
            assert_eq!(dark, first_dark);
            assert!(Arc::ptr_eq(
                highlighter
                    .compiled_themes
                    .get("light")
                    .expect("cached light"),
                &light_arc
            ));
            assert!(Arc::ptr_eq(
                highlighter
                    .compiled_themes
                    .get("dark")
                    .expect("cached dark"),
                &dark_arc
            ));
        }

        // Re-registering both an active theme (`dark`) and an inactive theme (`light`)
        // must invalidate their cached compiled themes and reflect updated colors.
        highlighter
            .register_theme(
                parse_theme_data(
                    "dark",
                    r##"{"tokenColors":[{"scope":"keyword.x","settings":{"foreground":"#224466"}}]}"##,
                )
                .expect("updated dark"),
            )
            .expect("re-register dark");
        highlighter
            .register_theme(
                parse_theme_data(
                    "light",
                    r##"{"tokenColors":[{"scope":"keyword.x","settings":{"foreground":"#664422"}}]}"##,
                )
                .expect("updated light"),
            )
            .expect("re-register light");
        assert!(!Arc::ptr_eq(
            highlighter
                .compiled_themes
                .get("dark")
                .expect("replaced dark"),
            &dark_arc
        ));
        assert!(!Arc::ptr_eq(
            highlighter
                .compiled_themes
                .get("light")
                .expect("replaced light"),
            &light_arc
        ));

        let updated_dark = highlighter
            .tokenize("x", "switch", "dark", &opts)
            .expect("updated dark");
        let updated_light = highlighter
            .tokenize("x", "switch", "light", &opts)
            .expect("updated light");
        assert_eq!(updated_dark.tokens[0][0].color.as_deref(), Some("#224466"));
        assert_eq!(updated_light.tokens[0][0].color.as_deref(), Some("#664422"));
        assert!(!Arc::ptr_eq(
            highlighter.compiled_themes.get("dark").expect("new dark"),
            &dark_arc
        ));
        assert!(!Arc::ptr_eq(
            highlighter.compiled_themes.get("light").expect("new light"),
            &light_arc
        ));

        highlighter.dispose();
        assert!(highlighter.compiled_themes.is_empty());
    }

    #[test]
    fn failed_theme_reregistration_with_overflowing_colors_preserves_working_theme() {
        let mut highlighter = HighlighterCore::new().expect("highlighter");
        let raw = parse_raw_grammar(
            r#"{"scopeName":"source.overflowtheme","patterns":[{"match":"x","name":"keyword.x"}]}"#,
            Some("overflowtheme.json"),
        )
        .expect("grammar");
        highlighter
            .register_language(LanguageRegistration::new("overflowtheme", raw))
            .expect("grammar registration");
        highlighter
            .register_theme(
                parse_theme_data(
                    "t",
                    r##"{"tokenColors":[{"scope":"keyword.x","settings":{"foreground":"#112233"}}]}"##,
                )
                .expect("working theme"),
            )
            .expect("register working theme");

        let opts = unlimited_tokenize_options();
        let before = highlighter
            .tokenize("x", "overflowtheme", "t", &opts)
            .expect("initial highlight");
        assert_eq!(before.tokens[0][0].color.as_deref(), Some("#112233"));

        // Attempt to replace "t" with a theme exceeding the 9-bit foreground color cap (512 distinct colors).
        let token_colors: Vec<String> = (3..=512)
            .map(|id| {
                format!(
                    r##"{{"scope":"scope.fg{id:03}","settings":{{"foreground":"#{id:06X}"}}}}"##
                )
            })
            .collect();
        let oversized_json = format!(
            r#"{{"name":"t","tokenColors":[{}]}}"#,
            token_colors.join(",")
        );
        let oversized = parse_theme_data("t", &oversized_json).expect("parse oversized theme");
        let err = highlighter
            .register_theme(oversized)
            .expect_err("oversized theme registration must fail");
        assert_eq!(err.kind(), ErrorKind::InvalidRegistration);

        let json_err = highlighter
            .load_custom_theme(&oversized_json)
            .expect_err("oversized JSON theme registration must fail");
        assert_eq!(json_err.kind(), ErrorKind::InvalidRegistration);

        // Existing working theme "t" must remain active and usable after the failed replacement.
        let after = highlighter
            .tokenize("x", "overflowtheme", "t", &opts)
            .expect("highlight after failed re-register");
        assert_eq!(after, before);
    }

    #[test]
    fn single_pass_multi_theme_matches_reference_across_options_embedded_and_continuations() {
        let mut highlighter = HighlighterCore::new().expect("highlighter");
        let host = parse_raw_grammar(
            r#"{
                "scopeName": "source.host",
                "patterns": [
                    {
                        "begin": "<%",
                        "end": "%>",
                        "name": "meta.embedded.block.inner",
                        "contentName": "source.inner",
                        "patterns": [{ "include": "source.inner" }]
                    },
                    {
                        "begin": "BEGIN",
                        "end": "^$",
                        "name": "meta.blank-end",
                        "patterns": [{ "match": "inside", "name": "constant.inside" }]
                    },
                    { "match": "foo", "name": "keyword.foo" },
                    { "match": "bar", "name": "string.bar" },
                    { "match": "//.*$", "name": "comment.line.host" }
                ]
            }"#,
            Some("host.json"),
        )
        .expect("host grammar");
        let inner = parse_raw_grammar(
            r#"{
                "scopeName": "source.inner",
                "patterns": [
                    { "match": "baz", "name": "variable.baz" },
                    { "match": "42", "name": "constant.numeric.inner" }
                ]
            }"#,
            Some("inner.json"),
        )
        .expect("inner grammar");
        let injection = parse_raw_grammar(
            r#"{
                "scopeName": "source.inject",
                "injectionSelector": "L:source.host",
                "patterns": [{ "match": "TODO", "name": "markup.todo" }]
            }"#,
            Some("inject.json"),
        )
        .expect("injection grammar");

        highlighter
            .register_language(LanguageRegistration::new("inner", inner))
            .expect("register inner");
        highlighter
            .register_language(LanguageRegistration::new("host", host))
            .expect("register host");
        highlighter
            .register_language(
                LanguageRegistration::new("inject", injection)
                    .with_injections(["source.host".to_owned()]),
            )
            .expect("register injection");

        // Notice: `light` gives `keyword.foo` and `string.bar` the same foreground as default
        // (causing them to merge when adjacent), whereas `dark` splits them and `contrast`
        // uses parent-scope rules and background differences.
        for (name, json) in [
            (
                "light",
                r##"{
                    "colors": { "editor.foreground": "#222222", "editor.background": "#ffffff" },
                    "tokenColors": [
                        { "scope": "constant.numeric", "settings": { "foreground": "#0055aa", "fontStyle": "bold" } },
                        { "scope": "markup.todo", "settings": { "foreground": "#cc0000", "fontStyle": "underline" } }
                    ]
                }"##,
            ),
            (
                "dark",
                r##"{
                    "colors": { "editor.foreground": "#dddddd", "editor.background": "#121212" },
                    "tokenColors": [
                        { "scope": "keyword.foo", "settings": { "foreground": "#88c0d0", "fontStyle": "italic" } },
                        { "scope": "string.bar", "settings": { "foreground": "#a3be8c" } },
                        { "scope": "source.inner variable.baz", "settings": { "foreground": "#ebcb8b", "fontStyle": "bold italic" } },
                        { "scope": "comment.line", "settings": { "foreground": "#616e88", "fontStyle": "italic" } }
                    ]
                }"##,
            ),
            (
                "contrast",
                r##"{
                    "colors": { "editor.foreground": "#ffffff", "editor.background": "#000000" },
                    "tokenColors": [
                        { "scope": "keyword.foo", "settings": { "foreground": "#ffffff", "background": "#222222" } },
                        { "scope": "constant.inside", "settings": { "foreground": "#ff00ff", "fontStyle": "strikethrough" } }
                    ]
                }"##,
            ),
        ] {
            highlighter
                .register_theme(parse_theme_data(name, json).expect("theme"))
                .expect("register theme");
        }

        let themes = vec![
            ("light".to_owned(), "light".to_owned()),
            ("dark".to_owned(), "dark".to_owned()),
            ("contrast".to_owned(), "contrast".to_owned()),
            ("light-dup".to_owned(), "light".to_owned()),
        ];

        let chunk1 = "😀foobar <% baz\nBEGIN\ninside TODO";
        // Use a Unicode escape for U+05D0 (Hebrew alef) so the test exercises
        // RTL non-merging at runtime without putting a literal RTL code point
        // into this source file, which the Shiki parity harness highlights.
        let chunk2 = "\n42 baz %> // TODO\r\n\u{05D0} foobar\n";

        let option_matrix = [
            unlimited_tokenize_options(),
            TokenizeOptions {
                time_limit_millis: 0,
                include_scopes: true,
                ..TokenizeOptions::default()
            },
            TokenizeOptions {
                time_limit_millis: 0,
                include_scopes: true,
                preserve_scope_boundaries: true,
                include_token_type: true,
                ..TokenizeOptions::default()
            },
            TokenizeOptions {
                time_limit_millis: 0,
                max_line_length: 12,
                include_token_type: true,
                ..TokenizeOptions::default()
            },
        ];

        let render_options = crate::multi_render::MultiThemeRenderOptions {
            render: RenderOptions::default(),
            default_color: Some("light".to_owned()),
            css_variable_prefix: "--shiki-".to_owned(),
        };

        for options in &option_matrix {
            let (actual_1, cont_1) = highlighter
                .tokenize_with_grammar_state_and_themes(
                    chunk1, "host", &themes, options, None, true,
                )
                .expect("single-pass chunk 1");
            assert_eq!(highlighter.active_theme.as_deref(), Some("light"));

            let (expected_1, expected_cont_1) = reference_multi_theme_tokenize(
                &mut highlighter,
                chunk1,
                "host",
                &themes,
                options,
                None,
                true,
            )
            .expect("reference chunk 1");
            assert_eq!(actual_1, expected_1, "chunk 1 tokens for {options:?}");
            assert_eq!(cont_1, expected_cont_1, "chunk 1 state for {options:?}");
            assert_eq!(
                crate::multi_render::render_html_with_themes(&actual_1, &render_options),
                crate::multi_render::render_html_with_themes(&expected_1, &render_options),
                "chunk 1 HTML for {options:?}"
            );

            let (actual_2, cont_2) = highlighter
                .tokenize_with_grammar_state_and_themes(
                    chunk2,
                    "host",
                    &themes,
                    options,
                    cont_1.as_deref(),
                    true,
                )
                .expect("single-pass chunk 2");
            let (expected_2, expected_cont_2) = reference_multi_theme_tokenize(
                &mut highlighter,
                chunk2,
                "host",
                &themes,
                options,
                expected_cont_1.as_deref(),
                true,
            )
            .expect("reference chunk 2");
            assert_eq!(actual_2, expected_2, "chunk 2 tokens for {options:?}");
            assert_eq!(cont_2, expected_cont_2, "chunk 2 state for {options:?}");
            assert_eq!(
                crate::multi_render::render_html_with_themes(&actual_2, &render_options),
                crate::multi_render::render_html_with_themes(&expected_2, &render_options),
                "chunk 2 HTML for {options:?}"
            );
        }

        // Plaintext multi-theme parity and error precedence.
        let (plain_actual, plain_cont) = highlighter
            .tokenize_with_grammar_state_and_themes(
                "hello\n\nworld",
                "plaintext",
                &themes[..2],
                &unlimited_tokenize_options(),
                None,
                false,
            )
            .expect("plain multi-theme");
        let (plain_expected, plain_expected_cont) = reference_multi_theme_tokenize(
            &mut highlighter,
            "hello\n\nworld",
            "plaintext",
            &themes[..2],
            &unlimited_tokenize_options(),
            None,
            false,
        )
        .expect("plain reference");
        assert_eq!(plain_actual, plain_expected);
        assert_eq!(plain_cont, plain_expected_cont);
        assert_eq!(highlighter.active_theme.as_deref(), Some("dark"));

        assert_eq!(
            highlighter
                .tokenize_with_grammar_state_and_themes(
                    "x",
                    "plaintext",
                    &themes[..2],
                    &unlimited_tokenize_options(),
                    None,
                    true,
                )
                .unwrap_err()
                .kind(),
            ErrorKind::Tokenization
        );
        assert_eq!(
            highlighter
                .tokenize_with_grammar_state_and_themes(
                    "x",
                    "missing-lang",
                    &[
                        ("light".to_owned(), "light".to_owned()),
                        ("dark".to_owned(), "missing-theme".to_owned()),
                    ],
                    &unlimited_tokenize_options(),
                    None,
                    false,
                )
                .unwrap_err()
                .kind(),
            ErrorKind::UnknownLanguage
        );
        assert_eq!(
            highlighter
                .tokenize_with_grammar_state_and_themes(
                    "x",
                    "host",
                    &[
                        ("light".to_owned(), "light".to_owned()),
                        ("dark".to_owned(), "missing-theme".to_owned()),
                    ],
                    &unlimited_tokenize_options(),
                    None,
                    false,
                )
                .unwrap_err()
                .kind(),
            ErrorKind::UnknownTheme
        );

        // Broken grammar compilation on theme 0 must still surface ErrorKind::Tokenization
        // ahead of an unknown later theme, matching sequential per-theme execution.
        let broken_grammar = parse_raw_grammar(
            r#"{"scopeName":"source.broken","patterns":[{"match":"[unclosed","name":"invalid.regex"}]}"#,
            Some("broken.json"),
        )
        .expect("broken grammar");
        highlighter
            .register_language(LanguageRegistration::new("broken", broken_grammar))
            .expect("register broken");
        assert_eq!(
            highlighter
                .tokenize_with_grammar_state_and_themes(
                    "x",
                    "broken",
                    &[
                        ("light".to_owned(), "light".to_owned()),
                        ("dark".to_owned(), "missing-theme".to_owned()),
                    ],
                    &unlimited_tokenize_options(),
                    None,
                    false,
                )
                .unwrap_err()
                .kind(),
            ErrorKind::Tokenization
        );

        // Failed continuation serialization (stack depth > 2,048) must leave
        // theme 0 active rather than switching the registry to a later theme.
        let deep_grammar = parse_raw_grammar(
            r#"{
                "scopeName": "source.deep-limit",
                "patterns": [{
                    "begin": "\\(",
                    "end": "\\)",
                    "name": "meta.group",
                    "patterns": [{ "include": "$self" }]
                }]
            }"#,
            Some("deep-limit.json"),
        )
        .expect("deep grammar");
        highlighter
            .register_language(LanguageRegistration::new("deep-limit", deep_grammar))
            .expect("register deep grammar");
        let err = highlighter
            .tokenize_with_grammar_state_and_themes(
                &"(".repeat(2_100),
                "deep-limit",
                &[
                    ("light".to_owned(), "light".to_owned()),
                    ("dark".to_owned(), "dark".to_owned()),
                ],
                &unlimited_tokenize_options(),
                None,
                true,
            )
            .unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Tokenization);
        assert_eq!(highlighter.active_theme.as_deref(), Some("light"));
    }

    #[test]
    #[ignore = "explicit release-mode performance benchmark for #389"]
    fn bench_warm_multi_theme_vs_sequential() {
        let mut highlighter = HighlighterCore::new().expect("highlighter");
        let grammar = parse_raw_grammar(
            r#"{
                "scopeName": "source.bench",
                "patterns": [
                    { "match": "//.*$", "name": "comment.line.double-slash.bench" },
                    {
                        "begin": "\"",
                        "end": "\"",
                        "name": "string.quoted.double.bench",
                        "patterns": [{ "match": "\\\\.", "name": "constant.character.escape.bench" }]
                    },
                    { "match": "\\b(async|await|const|let|function|return|if|else|for|while|export|import|from|type|interface)\\b", "name": "keyword.control.bench" },
                    { "match": "\\b(true|false|null|undefined)\\b", "name": "constant.language.bench" },
                    { "match": "\\b[0-9]+(\\.[0-9]+)?\\b", "name": "constant.numeric.bench" },
                    { "match": "\\b[A-Z][A-Za-z0-9_]*\\b", "name": "entity.name.type.bench" },
                    { "match": "\\b[a-z_][A-Za-z0-9_]*(?=\\s*\\()", "name": "entity.name.function.bench" },
                    { "match": "\\b[a-z_][A-Za-z0-9_]*\\b", "name": "variable.other.bench" },
                    { "match": "===|!==|=>|<=|>=|&&|\\|\\||[=+\\-*/<>!?:;.,(){}\\[\\]]", "name": "keyword.operator.bench" }
                ]
            }"#,
            Some("bench.json"),
        )
        .expect("bench grammar");
        highlighter
            .register_language(LanguageRegistration::new("bench", grammar))
            .expect("register bench");

        let make_theme = |name: &str, base_fg: &str, base_bg: &str, palette: [&str; 8]| {
            let mut rules = vec![
                format!(
                    r#"{{"scope":"comment","settings":{{"foreground":"{}","fontStyle":"italic"}}}}"#,
                    palette[0]
                ),
                format!(
                    r#"{{"scope":"string","settings":{{"foreground":"{}"}}}}"#,
                    palette[1]
                ),
                format!(
                    r#"{{"scope":"constant.character.escape","settings":{{"foreground":"{}","fontStyle":"bold"}}}}"#,
                    palette[2]
                ),
                format!(
                    r#"{{"scope":"keyword.control","settings":{{"foreground":"{}","fontStyle":"bold"}}}}"#,
                    palette[3]
                ),
                format!(
                    r#"{{"scope":"constant.language","settings":{{"foreground":"{}"}}}}"#,
                    palette[4]
                ),
                format!(
                    r#"{{"scope":"constant.numeric","settings":{{"foreground":"{}"}}}}"#,
                    palette[5]
                ),
                format!(
                    r#"{{"scope":"entity.name.type","settings":{{"foreground":"{}"}}}}"#,
                    palette[6]
                ),
                format!(
                    r#"{{"scope":"entity.name.function","settings":{{"foreground":"{}"}}}}"#,
                    palette[7]
                ),
            ];
            // Add realistic theme rule count (~120 rules, comparable to standard themes).
            for index in 0..112 {
                rules.push(format!(
                    r##"{{"scope":"meta.extra.rule{index}.bench","settings":{{"foreground":"#{:06x}"}}}}"##,
                    0x100000 + index * 17
                ));
            }
            let json = format!(
                r#"{{"name":"{name}","colors":{{"editor.foreground":"{base_fg}","editor.background":"{base_bg}"}},"tokenColors":[{}]}}"#,
                rules.join(",")
            );
            parse_theme_data(name, &json).expect("theme")
        };

        let light_theme = make_theme(
            "bench-light",
            "#24292f",
            "#ffffff",
            [
                "#6e7781", "#0a3069", "#8250df", "#cf222e", "#0550ae", "#0550ae", "#953800",
                "#8250df",
            ],
        );
        let dark_theme = make_theme(
            "bench-dark",
            "#c9d1d9",
            "#0d1117",
            [
                "#8b949e", "#a5d6ff", "#d2a8ff", "#ff7b72", "#79c0ff", "#79c0ff", "#ffa657",
                "#d2a8ff",
            ],
        );
        highlighter
            .register_theme(light_theme)
            .expect("register light");
        highlighter
            .register_theme(dark_theme)
            .expect("register dark");

        let snippet = [
            "export async function highlightDocument(input: string, count: number): Promise<Result> {",
            "  // Resolve tokens for each configured theme variant without repeating regex scans.",
            "  const header = \"escaped \\\"quote\\\" and value = 42\";",
            "  let total = count + 123.45;",
            "  if (total >= 100 && input !== null) {",
            "    return formatOutput(header, total, true);",
            "  }",
            "  return fallbackResult(undefined, false);",
            "}",
        ]
        .join("\n");
        let doc = (0..12)
            .map(|_| snippet.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let themes = vec![
            ("light".to_owned(), "bench-light".to_owned()),
            ("dark".to_owned(), "bench-dark".to_owned()),
        ];
        let options = unlimited_tokenize_options();

        // Warm up regex scanners and verify all 3 paths produce identical output.
        let single_check = highlighter
            .tokenize_with_themes(&doc, "bench", &themes, &options)
            .expect("warmup");
        let (cached_check, _) = reference_multi_theme_tokenize_with_mode(
            &mut highlighter,
            &doc,
            "bench",
            &themes,
            &options,
            None,
            false,
            false,
        )
        .expect("cached parity check");
        let (baseline_check, _) = reference_multi_theme_tokenize_with_mode(
            &mut highlighter,
            &doc,
            "bench",
            &themes,
            &options,
            None,
            false,
            true,
        )
        .expect("baseline parity check");
        assert_eq!(single_check, cached_check);
        assert_eq!(single_check, baseline_check);

        let iterations = 400;

        // 1. Pre-#389 baseline: sequential 2-pass + RawTheme recompile on every switch + merge.
        let baseline_start = std::time::Instant::now();
        for _ in 0..iterations {
            let result = reference_multi_theme_tokenize_with_mode(
                &mut highlighter,
                &doc,
                "bench",
                &themes,
                &options,
                None,
                false,
                true,
            )
            .expect("baseline two-pass");
            std::hint::black_box(result);
        }
        let baseline_ms = baseline_start.elapsed().as_secs_f64() * 1_000.0;

        // 2. Cached Arc<Theme> + 2-pass sequential + merge (isolating theme-cache win).
        let cached_two_pass_start = std::time::Instant::now();
        for _ in 0..iterations {
            let result = reference_multi_theme_tokenize_with_mode(
                &mut highlighter,
                &doc,
                "bench",
                &themes,
                &options,
                None,
                false,
                false,
            )
            .expect("cached two-pass");
            std::hint::black_box(result);
        }
        let cached_two_pass_ms = cached_two_pass_start.elapsed().as_secs_f64() * 1_000.0;

        // 3. New single-pass + cached Arc<Theme>.
        let single_pass_start = std::time::Instant::now();
        for _ in 0..iterations {
            let result = highlighter
                .tokenize_with_themes(&doc, "bench", &themes, &options)
                .expect("single-pass");
            std::hint::black_box(result);
        }
        let single_pass_ms = single_pass_start.elapsed().as_secs_f64() * 1_000.0;

        // 4. Long-line scope lookup: old O(T^2) `.iter().find(...)` vs monotonic cursor.
        let long_line = "const value = 123; ".repeat(1_500);
        let grammar = highlighter
            .grammar_for_language("bench")
            .expect("grammar")
            .expect("bench");
        let long_scopes = grammar
            .tokenize_line(&long_line, None, 0)
            .expect("long scopes")
            .tokens;
        let linear_start = std::time::Instant::now();
        let mut linear_hits = 0usize;
        for token in &long_scopes {
            if let Some(matched) = long_scopes
                .iter()
                .find(|candidate| {
                    candidate.start_index <= token.start_index
                        && candidate.end_index >= token.end_index
                })
                .map(|candidate| candidate.scopes.clone())
            {
                std::hint::black_box(matched);
                linear_hits += 1;
            }
        }
        let linear_ms = linear_start.elapsed().as_secs_f64() * 1_000.0;

        let monotonic_start = std::time::Instant::now();
        let mut cursor = 0usize;
        let mut monotonic_hits = 0usize;
        for token in &long_scopes {
            if let Some(matched) = find_covering_scope_monotonic(
                &long_scopes,
                &mut cursor,
                token.start_index,
                token.end_index,
            ) {
                std::hint::black_box(matched);
                monotonic_hits += 1;
            }
        }
        let monotonic_ms = monotonic_start.elapsed().as_secs_f64() * 1_000.0;
        assert_eq!(linear_hits, monotonic_hits);

        eprintln!(
            "=== #389 release benchmark ({iterations} iterations, {} lines, 2 themes x 120 rules) ===",
            doc.lines().count()
        );
        eprintln!(
            "  baseline (2-pass + RawTheme recompile): {baseline_ms:.2} ms ({:.3} ms/doc)",
            baseline_ms / f64::from(iterations)
        );
        eprintln!(
            "  cached Arc<Theme> (2-pass + merge):     {cached_two_pass_ms:.2} ms ({:.3} ms/doc, {:.2}x vs baseline)",
            cached_two_pass_ms / f64::from(iterations),
            baseline_ms / cached_two_pass_ms
        );
        eprintln!(
            "  single-pass + cached Arc<Theme>:        {single_pass_ms:.2} ms ({:.3} ms/doc, {:.2}x vs baseline, {:.2}x vs cached 2-pass)",
            single_pass_ms / f64::from(iterations),
            baseline_ms / single_pass_ms,
            cached_two_pass_ms / single_pass_ms
        );
        eprintln!(
            "=== #389 scope lookup ({} tokens on 1 line) ===",
            long_scopes.len()
        );
        eprintln!("  O(T^2) linear .find():                  {linear_ms:.2} ms");
        eprintln!(
            "  O(T) monotonic cursor:                  {monotonic_ms:.2} ms ({:.1}x faster)",
            linear_ms / monotonic_ms.max(0.001)
        );
    }

    #[test]
    fn rejects_invalid_custom_injection_selector_atomically_and_allows_retry() {
        let mut highlighter = HighlighterCore::new().expect("highlighter");
        highlighter
            .register_theme(ThemeData::new(
                "custom-theme",
                "#112233",
                "#ffffff",
                ferriki_textmate::RawTheme::default(),
            ))
            .expect("theme");

        let host_grammar = ferriki_textmate::parse_raw_grammar(
            r#"{
                "scopeName": "source.host",
                "patterns": [{ "match": "HOST", "name": "keyword.host" }]
            }"#,
            Some("host.json"),
        )
        .expect("host grammar");
        highlighter
            .register_language(LanguageRegistration::new("host", host_grammar))
            .expect("host registration");

        let deep_selector = format!("{}source.host{}", "(".repeat(200), ")".repeat(200));

        // 1) Over-depth external injectionSelector must fail atomically with InvalidRegistration.
        let bad_external = ferriki_textmate::parse_raw_grammar(
            &serde_json::json!({
                "scopeName": "source.bad-ext",
                "injectionSelector": deep_selector,
                "patterns": [{ "match": "TODO", "name": "comment.todo" }]
            })
            .to_string(),
            Some("bad-ext.json"),
        )
        .expect("bad external grammar");
        let err = highlighter
            .register_language(
                LanguageRegistration::new("my-inj", bad_external)
                    .with_injections(["source.host".to_owned()]),
            )
            .unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidRegistration);
        assert!(err.to_string().contains("depth limit"));
        assert!(
            !highlighter
                .loaded_languages()
                .iter()
                .any(|id| id == "my-inj")
        );

        // 2) Over-depth embedded injections key must also fail atomically.
        let bad_embedded = ferriki_textmate::parse_raw_grammar(
            &serde_json::json!({
                "scopeName": "source.bad-emb",
                "patterns": [],
                "injections": {
                    deep_selector: { "match": "TODO", "name": "comment.todo" }
                }
            })
            .to_string(),
            Some("bad-emb.json"),
        )
        .expect("bad embedded grammar");
        let err = highlighter
            .register_language(LanguageRegistration::new("bad-emb", bad_embedded))
            .unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidRegistration);
        assert!(
            !highlighter
                .loaded_languages()
                .iter()
                .any(|id| id == "bad-emb")
        );

        // 3) Target language remains completely functional after the failed registration.
        let before_retry = highlighter
            .tokenize(
                "HOST TODO",
                "host",
                "custom-theme",
                &unlimited_tokenize_options(),
            )
            .expect("host must remain usable after failed injection registration");
        assert!(
            before_retry.tokens[0]
                .iter()
                .all(|token| !token.content.eq("TODO") || token.color.as_deref() == Some("#112233"))
        );

        // 4) Retrying registration under the same ID with a valid selector succeeds and applies.
        let good_external = ferriki_textmate::parse_raw_grammar(
            r#"{
                "scopeName": "source.good-ext",
                "injectionSelector": "L:source.host",
                "patterns": [{ "match": "TODO", "name": "comment.todo" }]
            }"#,
            Some("good-ext.json"),
        )
        .expect("good external grammar");
        highlighter
            .register_language(
                LanguageRegistration::new("my-inj", good_external)
                    .with_injections(["source.host".to_owned()]),
            )
            .expect("retry with valid selector under same ID must succeed");
        assert!(
            highlighter
                .loaded_languages()
                .iter()
                .any(|id| id == "my-inj")
        );

        let grammar = highlighter
            .grammar_for_language("host")
            .expect("host grammar")
            .expect("registered host");
        let tokenized = grammar.tokenize_line("HOST TODO", None, 0).expect("tokens");
        assert!(
            tokenized
                .tokens
                .iter()
                .any(|token| token.scopes.iter().any(|scope| scope == "comment.todo")),
            "valid retried injection must apply to target language"
        );
    }

    #[test]
    fn rejects_catalog_grammar_with_overly_deep_selector_before_mutating_registry() {
        use std::borrow::Cow;
        use std::collections::HashMap;

        use ferriki_asset_gen::{
            FORMAT_VERSION, LanguageAsset, LanguageManifest, ThemeManifest, encode_language_asset,
            encode_language_manifest, encode_theme_manifest,
        };

        let deep_selector = format!("{}source.host{}", "(".repeat(200), ")".repeat(200));
        let host_asset: LanguageAsset = serde_json::from_value(serde_json::json!({
            "format_version": FORMAT_VERSION,
            "id": "host",
            "scope_name": "source.host",
            "display_name": null,
            "aliases": [],
            "embedded_langs": [],
            "embedded_langs_lazy": [],
            "inject_to": [],
            "grammar_json": r#"{
                "scopeName": "source.host",
                "patterns": [{ "match": "HOST", "name": "keyword.host" }]
            }"#,
        }))
        .expect("host asset struct");
        let valid_dep_asset: LanguageAsset = serde_json::from_value(serde_json::json!({
            "format_version": FORMAT_VERSION,
            "id": "valid-dep",
            "scope_name": "source.valid-dep",
            "display_name": null,
            "aliases": [],
            "embedded_langs": [],
            "embedded_langs_lazy": [],
            "inject_to": ["source.host"],
            "grammar_json": r#"{
                "scopeName": "source.valid-dep",
                "injectionSelector": "L:source.host",
                "patterns": [{ "match": "VALID", "name": "keyword.valid" }]
            }"#,
        }))
        .expect("valid-dep asset struct");
        let bad_inj_asset: LanguageAsset = serde_json::from_value(serde_json::json!({
            "format_version": FORMAT_VERSION,
            "id": "bad-inj",
            "scope_name": "source.bad-inj",
            "display_name": null,
            "aliases": [],
            "embedded_langs": ["valid-dep"],
            "embedded_langs_lazy": [],
            "inject_to": ["source.host"],
            "grammar_json": serde_json::json!({
                "scopeName": "source.bad-inj",
                "injectionSelector": deep_selector,
                "patterns": [{ "match": "TODO", "name": "comment.todo" }]
            })
            .to_string(),
        }))
        .expect("bad-inj asset struct");
        let wrapper_root_asset: LanguageAsset = serde_json::from_value(serde_json::json!({
            "format_version": FORMAT_VERSION,
            "id": "wrapper-root",
            "scope_name": "source.wrapper-root",
            "display_name": null,
            "aliases": [],
            "embedded_langs": ["valid-dep", "bad-inj"],
            "embedded_langs_lazy": [],
            "inject_to": [],
            "grammar_json": r#"{
                "scopeName": "source.wrapper-root",
                "patterns": [{ "match": "WRAP", "name": "keyword.wrap" }]
            }"#,
        }))
        .expect("wrapper-root asset struct");

        let language_manifest_struct: LanguageManifest =
            serde_json::from_value(serde_json::json!({
                "format_version": FORMAT_VERSION,
                "source": { "upstream": "test", "version": null, "commit": null },
                "entries": [
                    {
                        "id": "host",
                        "scope_name": "source.host",
                        "asset_file": "host.fkgram",
                        "display_name": null,
                        "aliases": [],
                        "embedded_langs": [],
                        "embedded_langs_lazy": [],
                        "inject_to": []
                    },
                    {
                        "id": "valid-dep",
                        "scope_name": "source.valid-dep",
                        "asset_file": "valid-dep.fkgram",
                        "display_name": null,
                        "aliases": [],
                        "embedded_langs": [],
                        "embedded_langs_lazy": [],
                        "inject_to": ["source.host"]
                    },
                    {
                        "id": "bad-inj",
                        "scope_name": "source.bad-inj",
                        "asset_file": "bad-inj.fkgram",
                        "display_name": null,
                        "aliases": [],
                        "embedded_langs": ["valid-dep"],
                        "embedded_langs_lazy": [],
                        "inject_to": ["source.host"]
                    },
                    {
                        "id": "wrapper-root",
                        "scope_name": "source.wrapper-root",
                        "asset_file": "wrapper-root.fkgram",
                        "display_name": null,
                        "aliases": [],
                        "embedded_langs": ["valid-dep", "bad-inj"],
                        "embedded_langs_lazy": [],
                        "inject_to": []
                    }
                ]
            }))
            .expect("language manifest struct");
        let theme_manifest_struct: ThemeManifest = serde_json::from_value(serde_json::json!({
            "format_version": FORMAT_VERSION,
            "source": { "upstream": "test", "version": null, "commit": null },
            "entries": []
        }))
        .expect("theme manifest struct");

        let language_manifest =
            encode_language_manifest(&language_manifest_struct).expect("language manifest");
        let theme_manifest = encode_theme_manifest(&theme_manifest_struct).expect("theme manifest");

        let mut language_assets: HashMap<String, Cow<'static, [u8]>> = HashMap::new();
        language_assets.insert(
            "host.fkgram".to_owned(),
            Cow::Owned(encode_language_asset(&host_asset).expect("host asset")),
        );
        language_assets.insert(
            "valid-dep.fkgram".to_owned(),
            Cow::Owned(encode_language_asset(&valid_dep_asset).expect("valid-dep asset")),
        );
        language_assets.insert(
            "bad-inj.fkgram".to_owned(),
            Cow::Owned(encode_language_asset(&bad_inj_asset).expect("bad-inj asset")),
        );
        language_assets.insert(
            "wrapper-root.fkgram".to_owned(),
            Cow::Owned(encode_language_asset(&wrapper_root_asset).expect("wrapper-root asset")),
        );

        let catalogs = StandardAssetCatalogs::from_embedded(
            &language_manifest,
            language_assets,
            &theme_manifest,
            HashMap::new(),
        )
        .expect("embedded catalogs");

        let mut highlighter = HighlighterCore::with_assets(catalogs).expect("highlighter");
        assert_eq!(
            highlighter.load_standard_language("host").expect("host"),
            Some("source.host".to_owned())
        );

        // 1) Loading a root with [valid-dep, bad-inj] must fail atomically:
        // neither valid-dep (with its injection) nor wrapper-root may be registered.
        let err = highlighter
            .load_standard_language("wrapper-root")
            .expect_err("transitive over-depth selector must fail atomically");
        assert_eq!(err.kind(), ErrorKind::AssetFormat);
        assert!(err.to_string().contains("depth limit"));
        for rejected in ["wrapper-root", "valid-dep", "bad-inj"] {
            assert!(
                !highlighter
                    .loaded_languages()
                    .iter()
                    .any(|id| id == rejected),
                "{rejected} must not be left loaded after failed closure validation"
            );
        }
        assert!(highlighter.registry.lookup("source.wrapper-root").is_none());
        assert!(highlighter.registry.lookup("source.valid-dep").is_none());
        assert!(highlighter.registry.lookup("source.bad-inj").is_none());

        // 2) Loading bad-inj directly must also fail without registering valid-dep.
        let err = highlighter
            .load_standard_language("bad-inj")
            .expect_err("over-depth catalog injection selector must fail load");
        assert_eq!(err.kind(), ErrorKind::AssetFormat);
        assert!(highlighter.registry.lookup("source.bad-inj").is_none());
        assert!(highlighter.registry.lookup("source.valid-dep").is_none());

        // Host language remains compilable and usable after the rejected catalog load.
        let host_grammar = highlighter
            .grammar_for_language("host")
            .expect("host grammar must stay healthy")
            .expect("host loaded");
        let result = host_grammar.tokenize_line("HOST", None, 0).expect("tokens");
        assert_eq!(result.tokens[0].scopes, ["source.host", "keyword.host"]);
    }

    #[test]
    fn custom_language_and_theme_single_pass_registration_preserves_contracts() {
        let mut highlighter = HighlighterCore::new().expect("highlighter");

        // Register a host language with aliases and verify alias + injection lookup.
        let scope = highlighter
            .load_custom_language(
                r#"{
                    "name": "demo-host",
                    "scopeName": "source.demo-host",
                    "aliases": ["dh"],
                    "patterns": [{"match": "\\bhello\\b", "name": "keyword.demo"}]
                }"#,
            )
            .expect("host language");
        assert_eq!(scope.as_deref(), Some("source.demo-host"));

        highlighter
            .load_custom_language(
                r#"{
                    "name": "demo-inject",
                    "scopeName": "source.demo-inject",
                    "injectionSelector": "L:source.demo-host",
                    "injectTo": ["source.demo-host"],
                    "patterns": [{"match": "\\bTODO\\b", "name": "comment.todo"}]
                }"#,
            )
            .expect("injection language");

        // Base theme + included custom theme inheriting background while overriding foreground.
        highlighter
            .load_custom_theme(
                r##"{
                    "name": "base-custom",
                    "fg": "#111111",
                    "bg": "#222222",
                    "tokenColors": [
                        {"scope": "keyword.demo", "settings": {"foreground": "#aa0000"}}
                    ]
                }"##,
            )
            .expect("base theme");
        highlighter
            .load_custom_theme(
                r##"{
                    "name": "overlay-custom",
                    "include": "base-custom",
                    "fg": "#333333",
                    "tokenColors": [
                        {"scope": "comment.todo", "settings": {"foreground": "#00aa00"}}
                    ]
                }"##,
            )
            .expect("overlay theme");

        let tokens = highlighter
            .tokenize(
                "hello TODO",
                "dh",
                "overlay-custom",
                &TokenizeOptions::default(),
            )
            .expect("tokens");
        assert_eq!(tokens.foreground, "#333333");
        assert_eq!(tokens.background, "#222222");
        assert_eq!(tokens.tokens[0][0].color.as_deref(), Some("#AA0000"));
        assert_eq!(tokens.tokens[0][2].color.as_deref(), Some("#00AA00"));

        // Validation error contracts remain intact.
        let err = highlighter
            .load_custom_language(r#"{"name":"bad","scopeName":"","patterns":[]}"#)
            .expect_err("empty scopeName");
        assert_eq!(err.kind(), ErrorKind::InvalidRegistration);
        assert!(err.to_string().contains("non-empty `scopeName`"));

        let err = highlighter
            .load_custom_language(
                r#"{"name":"bad","scopeName":"source.bad","aliases":"not-array","patterns":[]}"#,
            )
            .expect_err("non-array aliases");
        assert_eq!(err.kind(), ErrorKind::InvalidRegistration);
        assert!(err.to_string().contains("`aliases` must be an array"));

        let err = highlighter
            .load_custom_language(
                r#"{"name":"bad","scopeName":"source.bad","injectTo":[123],"patterns":[]}"#,
            )
            .expect_err("non-string injectTo");
        assert_eq!(err.kind(), ErrorKind::InvalidRegistration);
        assert!(err.to_string().contains("`injectTo` must contain strings"));

        let err = highlighter
            .load_custom_theme(r#"{"name":"bad-inc","include":123}"#)
            .expect_err("non-string include");
        assert_eq!(err.kind(), ErrorKind::InvalidRegistration);
        assert!(err.to_string().contains("`include` must be a theme name"));

        // Single-pass streaming deserialization rejects duplicate fields and retains line/column info.
        let dup_match = highlighter
            .load_custom_language(
                "{\n  \"name\": \"dup-match\",\n  \"scopeName\": \"source.dup\",\n  \"patterns\": [\n    {\"match\": \"a\", \"match\": \"b\"}\n  ]\n}",
            )
            .expect_err("duplicate match field must be rejected");
        assert_eq!(dup_match.kind(), ErrorKind::InvalidRegistration);
        assert!(dup_match.to_string().contains("duplicate field `match`"));
        assert!(dup_match.to_string().contains("line 5"));
        assert!(dup_match.to_string().contains("column "));

        let dup_top_level = highlighter
            .load_custom_language(
                "{\n  \"name\": \"dup-top\",\n  \"scopeName\": \"source.a\",\n  \"scopeName\": \"source.b\"\n}",
            )
            .expect_err("duplicate top-level scopeName must be rejected");
        assert_eq!(dup_top_level.kind(), ErrorKind::InvalidRegistration);
        assert!(
            dup_top_level
                .to_string()
                .contains("duplicate field `scopeName`")
        );
        assert!(dup_top_level.to_string().contains("line 4"));

        // Non-object JSON values and missing/non-string names keep their exact contracts.
        for non_object in ["[]", "[1, 2]", "\"text\"", "42", "true", "null"] {
            let err = highlighter
                .load_custom_language(non_object)
                .expect_err("non-object registration must fail");
            assert_eq!(err.kind(), ErrorKind::InvalidRegistration);
            assert!(
                err.to_string()
                    .contains("Language registration must be a JSON object.")
            );
        }
        for bad_name in [
            r#"{"scopeName":"source.missing"}"#,
            r#"{"name":"","scopeName":"source.empty"}"#,
            r#"{"name":123,"scopeName":"source.num"}"#,
        ] {
            let err = highlighter
                .load_custom_language(bad_name)
                .expect_err("missing/empty/non-string name must fail");
            assert_eq!(err.kind(), ErrorKind::InvalidRegistration);
            assert!(
                err.to_string()
                    .contains("Language registration requires a non-empty `name`.")
            );
        }
        let trailing = highlighter
            .load_custom_language(r#"{"name":"ok","scopeName":"source.ok","patterns":[]} trailing"#)
            .expect_err("trailing tokens after JSON must fail");
        assert_eq!(trailing.kind(), ErrorKind::InvalidRegistration);
        assert!(trailing.to_string().contains("line 1"));
    }

    #[test]
    fn streaming_highlight_to_html_and_lines_match_tokenized_render_byte_for_byte() {
        let mut highlighter = Highlighter::builder().build().expect("builder");
        highlighter
            .register_language_json(
                r#"{
                    "name": "stream-probe",
                    "scopeName": "source.stream",
                    "aliases": ["sp"],
                    "patterns": [
                        { "match": "\\b(fn|let)\\b", "name": "keyword.control.stream" },
                        { "match": "\"[^\"]*\"", "name": "string.quoted.stream" },
                        { "match": "UNDER", "name": "markup.underline.stream" },
                        { "match": "STRIKE", "name": "markup.strikethrough.stream" },
                        { "match": "[<&>]+", "name": "keyword.operator.stream" }
                    ]
                }"#,
            )
            .expect("lang");
        highlighter
            .register_theme_json(
                r##"{
                    "name": "stream-theme",
                    "type": "dark",
                    "fg": "#D8DEE9",
                    "bg": "#2E3440",
                    "settings": [
                        { "scope": "keyword.control", "settings": { "foreground": "#81A1C1", "fontStyle": "bold" } },
                        { "scope": "string", "settings": { "foreground": "#A3BE8C", "fontStyle": "italic" } },
                        { "scope": "markup.underline", "settings": { "foreground": "#EBCB8B", "fontStyle": "underline" } },
                        { "scope": "markup.strikethrough", "settings": { "foreground": "#BF616A", "fontStyle": "strikethrough" } },
                        { "scope": "keyword.operator", "settings": { "foreground": "#81A1C1", "fontStyle": "bold" } }
                    ]
                }"##,
            )
            .expect("theme");

        let code = "fn  let \"a<&😀\"\r\n  UNDER  STRIKE  <&>\n\nplain   ";
        for lang in ["stream-probe", "sp", "text", "ansi"] {
            for style_mode in [crate::StyleMode::Inline, crate::StyleMode::Classes] {
                for merge_whitespaces in [false, true] {
                    for merge_same_style_tokens in [false, true] {
                        for include_root_style in [false, true] {
                            let options = RenderOptions::default()
                                .with_style_mode(style_mode)
                                .with_merge_whitespaces(merge_whitespaces)
                                .with_merge_same_style_tokens(merge_same_style_tokens)
                                .with_include_root_style(include_root_style);
                            let tokens = highlighter
                                .highlight_with_options(
                                    code,
                                    lang,
                                    "stream-theme",
                                    &TokenizeOptions::default().with_preserve_scope_boundaries(
                                        style_mode == crate::StyleMode::Classes,
                                    ),
                                )
                                .expect("tokens");
                            let expected_html = crate::render_html(&tokens, &options);
                            let streamed_html = highlighter
                                .highlight_to_html(code, lang, "stream-theme", &options)
                                .expect("streamed html");
                            assert_eq!(streamed_html, expected_html, "{lang} {options:?}");

                            let expected_lines = crate::render_html_lines(&tokens, &options);
                            let streamed_lines = highlighter
                                .highlight_html_lines(code, lang, "stream-theme", &options)
                                .expect("streamed lines");
                            assert_eq!(streamed_lines.lines, expected_lines, "{lang} {options:?}");
                            assert_eq!(streamed_lines.theme_name, tokens.theme_name);
                            assert_eq!(streamed_lines.foreground, tokens.foreground);
                            assert_eq!(streamed_lines.background, tokens.background);
                        }
                    }
                }
            }
        }

        // Verify max_line_length parity in streaming core path.
        let tok_opts = TokenizeOptions::default().with_max_line_length(10);
        let render_opts = RenderOptions::default();
        let tokens = highlighter
            .core
            .tokenize(code, "stream-probe", "stream-theme", &tok_opts)
            .expect("max len tokens");
        let streamed = highlighter
            .core
            .highlight_to_html(
                code,
                "stream-probe",
                "stream-theme",
                &tok_opts,
                &render_opts,
            )
            .expect("max len streamed");
        assert_eq!(streamed, crate::render_html(&tokens, &render_opts));

        // Verify resolve_or_load_language returns cached scope for already-loaded custom languages.
        assert_eq!(
            highlighter
                .core
                .resolve_or_load_language("stream-probe")
                .expect("resolve"),
            Some("source.stream".to_owned())
        );
        assert_eq!(
            highlighter
                .core
                .resolve_or_load_language("sp")
                .expect("resolve alias"),
            Some("source.stream".to_owned())
        );
        assert_eq!(
            highlighter
                .core
                .resolve_or_load_language("unknown-lang")
                .expect("unknown"),
            None
        );

        // Verify error precedence matches `highlight`.
        let err = highlighter
            .highlight_to_html("fn", "stream-probe", "no-such-theme", &render_opts)
            .unwrap_err();
        assert_eq!(err.kind(), ErrorKind::UnknownTheme);
        let err = highlighter
            .highlight_to_html("fn", "no-such-lang", "stream-theme", &render_opts)
            .unwrap_err();
        assert_eq!(err.kind(), ErrorKind::UnknownLanguage);
    }
}
