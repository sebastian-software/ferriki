mod asset_catalog;
mod grammar;
mod injection;
mod render;
mod rule;
mod scanner;
mod theme;
mod tokenize;
mod types;

use ferroni::regexec;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

pub use asset_catalog::{LanguageAssetCatalog, StandardAssetCatalogs, ThemeAssetCatalog};

use grammar::*;
use render::*;
use types::*;

#[napi(js_name = "ferrikiVersion")]
pub fn ferriki_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub struct FerrikiHighlighter {
    _options_json: String,
    standard_assets: Option<StandardAssetCatalogs>,
    grammars: RefCell<HashMap<String, Value>>,
    aliases: RefCell<HashMap<String, String>>,
    themes: RefCell<HashMap<String, ThemeData>>,
    compiled_grammars: RefCell<HashMap<String, CompiledGrammar>>,
    /// Maps target scope → list of injecting grammar scope names
    injection_map: RefCell<HashMap<String, Vec<String>>>,
}

#[napi]
impl FerrikiHighlighter {
    fn resolve_registered_scope(&self, lang_or_scope: &str) -> Option<String> {
        if self.grammars.borrow().contains_key(lang_or_scope) {
            return Some(lang_or_scope.to_owned());
        }
        if let Some(scope) = self.aliases.borrow().get(lang_or_scope).cloned() {
            return Some(scope);
        }
        self.ensure_standard_grammar_loaded(lang_or_scope)
            .ok()
            .flatten()
    }

    fn ensure_standard_theme_loaded(&self, theme_name: &str) -> Result<bool> {
        if self.themes.borrow().contains_key(theme_name) {
            return Ok(true);
        }
        let Some(catalogs) = &self.standard_assets else {
            return Ok(false);
        };
        let Some(asset) = catalogs.themes.load_asset(theme_name)? else {
            return Ok(false);
        };
        let theme = parse_theme_registration(&asset.theme_json)?;
        self.themes.borrow_mut().insert(theme.name.clone(), theme);
        Ok(true)
    }

    fn ensure_standard_themes_for_options(&self, options_json: &str) -> Result<()> {
        if let Some((light, dark)) = parse_dual_themes(options_json) {
            self.ensure_standard_theme_loaded(&light)?;
            self.ensure_standard_theme_loaded(&dark)?;
            return Ok(());
        }
        if let Some(theme) = parse_theme(options_json) {
            self.ensure_standard_theme_loaded(&theme)?;
        }
        Ok(())
    }

    fn ensure_standard_grammar_loaded(&self, lang_or_scope: &str) -> Result<Option<String>> {
        let mut visiting = HashSet::new();
        self.ensure_standard_grammar_loaded_inner(lang_or_scope, &mut visiting)
    }

    fn ensure_standard_grammar_loaded_inner(
        &self,
        lang_or_scope: &str,
        visiting: &mut HashSet<String>,
    ) -> Result<Option<String>> {
        if self.grammars.borrow().contains_key(lang_or_scope) {
            return Ok(Some(lang_or_scope.to_owned()));
        }
        if let Some(scope) = self.aliases.borrow().get(lang_or_scope).cloned() {
            return Ok(Some(scope));
        }

        let Some(catalogs) = &self.standard_assets else {
            return Ok(None);
        };
        let Some(asset) = catalogs.languages.load_asset(lang_or_scope)? else {
            return Ok(None);
        };
        let scope_name = asset.scope_name.clone();
        if self.grammars.borrow().contains_key(&scope_name) {
            return Ok(Some(scope_name));
        }

        let asset_id = asset.id.clone();
        if !visiting.insert(asset_id.clone()) {
            return Ok(Some(scope_name));
        }

        for dependency in asset
            .embedded_langs
            .iter()
            .chain(asset.embedded_langs_lazy.iter())
        {
            let _ = self.ensure_standard_grammar_loaded_inner(dependency, visiting)?;
        }

        let grammar = serde_json::from_str::<Value>(&asset.grammar_json).map_err(|err| {
            Error::from_reason(format!("Failed to parse standard grammar JSON: {err}"))
        })?;

        self.aliases
            .borrow_mut()
            .retain(|_, scope| scope != &scope_name);
        {
            let mut aliases = self.aliases.borrow_mut();
            for alias in &asset.aliases {
                aliases.insert(alias.clone(), scope_name.clone());
            }
        }
        self.grammars
            .borrow_mut()
            .insert(scope_name.clone(), grammar);
        self.compiled_grammars.borrow_mut().remove(&scope_name);

        if !asset.inject_to.is_empty() {
            let mut injection_map = self.injection_map.borrow_mut();
            for target_scope in &asset.inject_to {
                let entry = injection_map.entry(target_scope.clone()).or_default();
                if !entry.contains(&scope_name) {
                    entry.push(scope_name.clone());
                }
                self.compiled_grammars.borrow_mut().remove(target_scope);
            }
        }

        visiting.remove(&asset_id);
        Ok(Some(scope_name))
    }

    fn resolve_lang_mode(&self, options_json: &str) -> Result<LangMode> {
        let lang = resolve_lang_from_options(options_json)?;
        if let Some(mode) = resolve_lang_mode_from_lang(&lang) {
            return Ok(mode);
        }

        if let Some(scope) = self.resolve_registered_scope(&lang) {
            if let Some(mode) = lang_mode_from_scope(&scope) {
                return Ok(mode);
            }
            return Ok(LangMode::Grammar);
        }

        Err(Error::from_reason(
      "Ferriki currently supports text/txt/plain/plaintext/json and registered grammar skeleton mode.",
    ))
    }

    fn resolve_grammar_scope_from_options(&self, options_json: &str) -> Result<String> {
        let lang = resolve_lang_from_options(options_json)?;
        self.resolve_registered_scope(&lang).ok_or_else(|| {
            Error::from_reason(
                "Ferriki grammar mode could not resolve registered scope from `options.lang`.",
            )
        })
    }

    #[napi(js_name = "registerTheme")]
    pub fn register_theme(&mut self, payload_json: String) -> Result<()> {
        let theme = parse_theme_registration(&payload_json)?;
        let name = theme.name.clone();
        self.themes.borrow_mut().insert(name, theme);
        Ok(())
    }

    #[napi(js_name = "registerGrammar")]
    pub fn register_grammar(&mut self, payload_json: String) -> Result<()> {
        let registration = parse_grammar_registration(&payload_json)?;
        let scope_name = registration.scope_name.clone();
        let grammar = if registration.has_explicit_grammar {
            Some(registration.grammar)
        } else {
            self.grammars.borrow().get(&scope_name).cloned()
        };

        self.aliases
            .borrow_mut()
            .retain(|_, scope| scope != &scope_name);
        for alias in &registration.aliases {
            self.aliases
                .borrow_mut()
                .insert(alias.clone(), scope_name.clone());
        }
        if let Some(grammar) = grammar {
            self.grammars
                .borrow_mut()
                .insert(scope_name.clone(), grammar);
        }

        // Invalidate compiled grammar cache for this scope
        self.compiled_grammars.borrow_mut().remove(&scope_name);

        // Build external injection map entries
        if !registration.inject_to.is_empty() {
            for target_scope in &registration.inject_to {
                let mut injection_map = self.injection_map.borrow_mut();
                let entry = injection_map.entry(target_scope.clone()).or_default();
                if !entry.contains(&scope_name) {
                    entry.push(scope_name.clone());
                }
                // Invalidate compiled grammar cache for the target scope,
                // since it now has a new external injection
                self.compiled_grammars.borrow_mut().remove(target_scope);
            }
        }

        Ok(())
    }

    #[napi(js_name = "loadStandardTheme")]
    pub fn load_standard_theme(&mut self, theme_name: String) -> Result<bool> {
        self.ensure_standard_theme_loaded(&theme_name)
    }

    #[napi(js_name = "loadStandardGrammar")]
    pub fn load_standard_grammar(&mut self, lang_or_scope: String) -> Result<Option<String>> {
        self.ensure_standard_grammar_loaded(&lang_or_scope)
    }

    #[napi(js_name = "resolveGrammarScope")]
    pub fn resolve_grammar_scope(&self, lang_or_scope: String) -> Option<String> {
        self.resolve_registered_scope(&lang_or_scope)
    }

    #[napi(js_name = "getLoadedGrammarScopes")]
    pub fn get_loaded_grammar_scopes(&self) -> Vec<String> {
        let mut scopes = self.grammars.borrow().keys().cloned().collect::<Vec<_>>();
        scopes.sort();
        scopes
    }

    fn get_or_compile_grammar(&self, scope: &str) -> Result<()> {
        let needs_compile = !self.compiled_grammars.borrow().contains_key(scope);
        if needs_compile {
            let compiled = {
                let grammars = self.grammars.borrow();
                let injection_map = self.injection_map.borrow();
                let grammar = grammars
                    .get(scope)
                    .ok_or_else(|| Error::from_reason("Ferriki grammar not found in registry."))?;
                compile_grammar(grammar, &grammars, &injection_map)?
            };
            self.compiled_grammars
                .borrow_mut()
                .insert(scope.to_owned(), compiled);
        }
        Ok(())
    }

    #[napi(js_name = "codeToHtml")]
    pub fn code_to_html(&self, code: String, options_json: String) -> Result<String> {
        self.ensure_standard_themes_for_options(&options_json)?;
        match self.resolve_lang_mode(&options_json)? {
            LangMode::Plaintext => {
                let themes = self.themes.borrow();
                Ok(render_plain_html(&code, &options_json, &themes))
            }
            LangMode::Json => {
                let themes = self.themes.borrow();
                render_json_html(&code, &options_json, &themes)
            }
            LangMode::Grammar => {
                let scope = self.resolve_grammar_scope_from_options(&options_json)?;
                self.get_or_compile_grammar(&scope)?;
                let root_scope = Some(scope.as_str());
                let themes = self.themes.borrow();
                let mut cache = self.compiled_grammars.borrow_mut();
                let compiled = cache.get_mut(&scope).ok_or_else(|| {
                    Error::from_reason("Ferriki compiled grammar not found after compilation.")
                })?;
                render_grammar_html(&code, &options_json, compiled, root_scope, &themes)
            }
        }
    }

    #[napi(js_name = "codeToTokens")]
    pub fn code_to_tokens(&self, code: String, options_json: String) -> Result<String> {
        self.ensure_standard_themes_for_options(&options_json)?;
        match self.resolve_lang_mode(&options_json)? {
            LangMode::Plaintext => {
                let themes = self.themes.borrow();
                render_plain_tokens_json(&code, &options_json, &themes)
            }
            LangMode::Json => {
                let themes = self.themes.borrow();
                render_json_tokens_json(&code, &options_json, &themes)
            }
            LangMode::Grammar => {
                let scope = self.resolve_grammar_scope_from_options(&options_json)?;
                self.get_or_compile_grammar(&scope)?;
                let root_scope = Some(scope.as_str());
                let themes = self.themes.borrow();
                let mut cache = self.compiled_grammars.borrow_mut();
                let compiled = cache.get_mut(&scope).ok_or_else(|| {
                    Error::from_reason("Ferriki compiled grammar not found after compilation.")
                })?;
                render_grammar_tokens_json(&code, &options_json, compiled, root_scope, &themes)
            }
        }
    }

    #[napi(js_name = "codeToHast")]
    pub fn code_to_hast(&self, code: String, options_json: String) -> Result<String> {
        self.ensure_standard_themes_for_options(&options_json)?;
        match self.resolve_lang_mode(&options_json)? {
            LangMode::Plaintext => {
                let themes = self.themes.borrow();
                render_plain_hast_json(&code, &options_json, &themes)
            }
            LangMode::Json => {
                let themes = self.themes.borrow();
                render_json_hast_json(&code, &options_json, &themes)
            }
            LangMode::Grammar => {
                let scope = self.resolve_grammar_scope_from_options(&options_json)?;
                self.get_or_compile_grammar(&scope)?;
                let root_scope = Some(scope.as_str());
                let themes = self.themes.borrow();
                let mut cache = self.compiled_grammars.borrow_mut();
                let compiled = cache.get_mut(&scope).ok_or_else(|| {
                    Error::from_reason("Ferriki compiled grammar not found after compilation.")
                })?;
                render_grammar_hast_json(&code, &options_json, compiled, root_scope, &themes)
            }
        }
    }

    #[napi]
    pub fn dispose(&self) {
        // Placeholder for future explicit cleanup.
    }
}

#[napi(js_name = "createHighlighter")]
pub fn create_highlighter(options_json: String) -> FerrikiHighlighter {
    // Set oniguruma limits to prevent catastrophic backtracking
    regexec::onig_set_retry_limit_in_match(50_000);
    regexec::onig_set_retry_limit_in_search(50_000);
    regexec::onig_set_match_stack_limit(10_000);
    let standard_assets = parse_standard_asset_root(&options_json)
        .and_then(|root| StandardAssetCatalogs::load_from_root(std::path::Path::new(&root)).ok());

    FerrikiHighlighter {
        _options_json: options_json,
        standard_assets,
        grammars: RefCell::new(HashMap::new()),
        aliases: RefCell::new(HashMap::new()),
        themes: RefCell::new(HashMap::new()),
        compiled_grammars: RefCell::new(HashMap::new()),
        injection_map: RefCell::new(HashMap::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::injection::*;
    use crate::rule::*;
    use crate::theme::*;
    use ferriki_asset_gen::{generate_catalogs_from_upstream, AssetSourceRef};
    use ferroni::scanner::{OnigString, Scanner, ScannerFindOptions};
    use serde_json::json;
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_output_dir(label: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("ferriki-{label}-{nanos}"))
    }

    #[test]
    fn test_scope_component_matches_exact() {
        assert!(scope_component_matches("comment", "comment"));
    }

    #[test]
    fn test_scope_component_matches_prefix() {
        assert!(scope_component_matches("comment", "comment.line"));
        assert!(scope_component_matches("keyword", "keyword.control.ts"));
    }

    #[test]
    fn test_scope_component_no_partial() {
        assert!(!scope_component_matches("key", "keyword"));
        assert!(!scope_component_matches("comment.l", "comment.line"));
    }

    /// Test helper: split selector and call selector_matches_presplit
    fn selector_matches(selector: &str, scope_stack: &[&str]) -> Option<usize> {
        let parts: Vec<String> = selector.split_whitespace().map(str::to_owned).collect();
        selector_matches_presplit(&parts, scope_stack)
    }

    #[test]
    fn test_selector_matches_single() {
        let stack = vec!["source.ts", "keyword.control.ts"];
        assert!(selector_matches("keyword", &stack).is_some());
        assert!(selector_matches("keyword.control", &stack).is_some());
        assert!(selector_matches("keyword.control.ts", &stack).is_some());
        assert!(selector_matches("string", &stack).is_none());
    }

    #[test]
    fn test_selector_matches_ancestor_chain() {
        let stack = vec!["source.ts", "meta.block.ts", "keyword.control.ts"];
        assert!(selector_matches("source.ts keyword.control", &stack).is_some());
        assert!(selector_matches("meta.block keyword.control", &stack).is_some());
        assert!(selector_matches("source.ts meta.block keyword.control", &stack).is_some());
        assert!(selector_matches("string keyword.control", &stack).is_none());
    }

    #[test]
    fn test_selector_specificity_longer_wins() {
        let stack = vec!["source.ts", "comment.line.ts"];
        let score1 = selector_matches("comment", &stack).unwrap();
        let score2 = selector_matches("comment.line", &stack).unwrap();
        assert!(score2 > score1);
    }

    #[test]
    fn test_resolve_token_style_basic() {
        let theme = ThemeData {
            name: "test".to_owned(),
            fg: "#ffffff".to_owned(),
            fg_normalized: Arc::<str>::from("#FFFFFF"),
            bg: "#000000".to_owned(),
            settings: vec![
                ThemeRule::new(vec![], Some("#ffffff".to_owned()), 0),
                ThemeRule::new(vec!["comment".to_owned()], Some("#666666".to_owned()), 1),
                ThemeRule::new(vec!["keyword".to_owned()], Some("#ff0000".to_owned()), 0),
            ],
        };

        let style = resolve_token_style(&["source.ts", "comment.line.ts"], &theme);
        assert_eq!(style.foreground.as_deref(), Some("#666666"));
        assert_eq!(style.font_style, 1);

        let style2 = resolve_token_style(&["source.ts", "keyword.control.ts"], &theme);
        assert_eq!(style2.foreground.as_deref(), Some("#FF0000"));

        let style3 = resolve_token_style(&["source.ts", "variable.other.ts"], &theme);
        assert_eq!(style3.foreground.as_deref(), Some("#FFFFFF"));
    }

    #[test]
    fn test_resolve_token_style_specificity() {
        let theme = ThemeData {
            name: "test".to_owned(),
            fg: "#ffffff".to_owned(),
            fg_normalized: Arc::<str>::from("#FFFFFF"),
            bg: "#000000".to_owned(),
            settings: vec![
                ThemeRule::new(vec!["string".to_owned()], Some("#aaaaaa".to_owned()), 0),
                ThemeRule::new(
                    vec!["string.quoted".to_owned()],
                    Some("#bbbbbb".to_owned()),
                    0,
                ),
                ThemeRule::new(
                    vec!["string.quoted.double".to_owned()],
                    Some("#cccccc".to_owned()),
                    0,
                ),
            ],
        };

        let style = resolve_token_style(&["source.ts", "string.quoted.double.ts"], &theme);
        assert_eq!(style.foreground.as_deref(), Some("#CCCCCC"));
    }

    #[test]
    fn test_has_back_references() {
        assert!(has_back_references("\\1"));
        assert!(has_back_references("foo\\2bar"));
        assert!(!has_back_references("foo\\\\1"));
        assert!(!has_back_references("foo\\0bar"));
        assert!(!has_back_references("no backrefs here"));
    }

    #[test]
    fn test_init_grammar_creates_self_and_base() {
        let grammar = json!({
          "scopeName": "source.test",
          "patterns": [{"match": "foo"}],
          "repository": {
            "strings": {"match": "bar"}
          }
        });

        let initialized = init_grammar(&grammar, None);
        let repo = initialized.get("repository").unwrap().as_object().unwrap();
        assert!(repo.contains_key("$self"));
        assert!(repo.contains_key("$base"));

        let self_entry = repo.get("$self").unwrap();
        assert_eq!(
            self_entry.get("name").unwrap().as_str().unwrap(),
            "source.test"
        );
    }

    #[test]
    fn test_rule_registry_alloc_and_get() {
        let mut reg = RuleRegistry::new();
        let id1 = reg.alloc_id();
        let id2 = reg.alloc_id();
        assert_eq!(id1, 1);
        assert_eq!(id2, 2);

        reg.store(
            id1,
            Rule::Match {
                _id: id1,
                name: Some("test".to_owned()),
                match_re: "foo".to_owned(),
                captures: vec![],
            },
        );

        assert!(reg.get(id1).is_some());
        assert!(reg.get(id2).is_none()); // Not yet stored
        assert!(reg.get(END_RULE_ID).is_none()); // Negative
    }

    #[test]
    fn create_highlighter_can_load_standard_assets_from_root() {
        let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
        let output_dir = temp_output_dir("standard-asset-root");
        generate_catalogs_from_upstream(
            &upstream_dir,
            &output_dir,
            AssetSourceRef {
                upstream: "textmate-grammars-themes".to_owned(),
                version: Some("1.0.0".to_owned()),
                commit: Some("abc123".to_owned()),
            },
        )
        .expect("generate");

        let mut highlighter = create_highlighter(
            json!({ "standardAssetRoot": output_dir.display().to_string() }).to_string(),
        );

        assert!(highlighter
            .load_standard_theme("vitesse-light".to_owned())
            .expect("theme"));
        assert_eq!(
            highlighter
                .load_standard_grammar("js".to_owned())
                .expect("grammar"),
            Some("source.js".to_owned())
        );
        assert_eq!(
            highlighter.resolve_grammar_scope("mjs".to_owned()),
            Some("source.js".to_owned())
        );

        fs::remove_dir_all(output_dir).expect("cleanup");
    }

    #[test]
    fn load_standard_grammar_recursively_registers_embedded_standard_dependencies() {
        let asset_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/shiki");

        let mut highlighter = create_highlighter(
            json!({ "standardAssetRoot": asset_root.display().to_string() }).to_string(),
        );

        assert_eq!(
            highlighter
                .load_standard_grammar("vue".to_owned())
                .expect("grammar"),
            Some("text.html.vue".to_owned())
        );

        let scopes = highlighter.get_loaded_grammar_scopes();
        assert!(scopes.contains(&"text.html.vue".to_owned()));
        assert!(scopes.contains(&"text.html.basic".to_owned()));
        assert!(scopes.contains(&"source.js".to_owned()));
        assert!(scopes.contains(&"source.ts".to_owned()));
    }

    #[test]
    fn standard_js_function_calls_and_whitespace_match_expected_theme_scopes() {
        let asset_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/shiki");

        let highlighter = create_highlighter(
            json!({ "standardAssetRoot": asset_root.display().to_string() }).to_string(),
        );
        assert!(highlighter
            .ensure_standard_theme_loaded("nord")
            .expect("theme"));
        let themes = highlighter.themes.borrow();
        let nord = themes
            .get("Nord")
            .or_else(|| themes.get("nord"))
            .expect("nord theme");
        let direct_function_style =
            resolve_token_style(&["source.js", "entity.name.function.js"], nord);
        assert_eq!(direct_function_style.foreground.as_deref(), Some("#88C0D0"));
        let nested_function_style = resolve_token_style(
            &[
                "source.js",
                "meta.function-call.js",
                "entity.name.function.js",
            ],
            nord,
        );
        assert_eq!(nested_function_style.foreground.as_deref(), Some("#88C0D0"));
        drop(themes);

        let generated_catalogs =
            StandardAssetCatalogs::load_from_root(&asset_root).expect("catalogs");
        let generated_js_asset = generated_catalogs
            .languages
            .load_asset("javascript")
            .expect("asset")
            .expect("present");
        let js_grammar: Value =
            serde_json::from_str(&generated_js_asset.grammar_json).expect("grammar json");
        let function_call_begin = js_grammar["repository"]["function-call"]["patterns"][0]["begin"]
            .as_str()
            .expect("function-call begin");
        let mut function_call_scanner = Scanner::new(&[function_call_begin]).expect("scanner");
        let function_call_match = function_call_scanner.find_next_match_utf16(
            &OnigString::new("console.log("),
            0,
            ScannerFindOptions::from_bits(0),
        );
        assert!(
            function_call_match.is_some(),
            "Ferroni should match the JavaScript function-call begin rule for console.log("
        );

        let js_tokens = highlighter
            .code_to_tokens(
                "console.log(\"Hi\")".to_owned(),
                json!({
                  "lang": "javascript",
                  "theme": "nord",
                })
                .to_string(),
            )
            .expect("tokens");
        let js_payload: Value = serde_json::from_str(&js_tokens).expect("json");
        let js_line = js_payload["tokens"][0].as_array().expect("line");

        let js_pairs = js_line
            .iter()
            .map(|token| {
                (
                    token["content"].as_str().unwrap().to_owned(),
                    token["color"].as_str().unwrap().to_owned(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            js_pairs,
            vec![
                ("console".to_owned(), "#D8DEE9".to_owned()),
                (".".to_owned(), "#ECEFF4".to_owned()),
                ("log".to_owned(), "#88C0D0".to_owned()),
                ("(".to_owned(), "#D8DEE9FF".to_owned()),
                ("\"".to_owned(), "#ECEFF4".to_owned()),
                ("Hi".to_owned(), "#A3BE8C".to_owned()),
                ("\"".to_owned(), "#ECEFF4".to_owned()),
                (")".to_owned(), "#D8DEE9FF".to_owned()),
            ]
        );

        let whitespace_html = highlighter
            .code_to_html(
                "  space()\n\t\ttab()".to_owned(),
                json!({
                  "lang": "javascript",
                  "theme": "vitesse-light",
                })
                .to_string(),
            )
            .expect("html");
        assert_eq!(
      whitespace_html,
      "<pre class=\"shiki vitesse-light\" style=\"background-color:#ffffff;color:#393a34\" tabindex=\"0\"><code><span class=\"line\"><span style=\"color:#59873A\">  space</span><span style=\"color:#999999\">()</span></span>\n<span class=\"line\"><span style=\"color:#59873A\">\t\ttab</span><span style=\"color:#999999\">()</span></span></code></pre>"
    );
    }

    #[test]
    fn ferroni_matches_simple_after_tag_lookbehind() {
        let mut scanner = Scanner::new(&["(?<=>)"]).expect("scanner");
        let matched = scanner.find_next_match_utf16(
            &OnigString::new(">\n"),
            1,
            ScannerFindOptions::from_bits(0),
        );
        assert!(
            matched.is_some(),
            "Ferroni should match (?<=>) after a tag close."
        );
    }

    #[test]
    fn ferroni_reports_capture_groups_for_tag_end() {
        let mut scanner = Scanner::new(&["(>)"]).expect("scanner");
        let matched = scanner
            .find_next_match_utf16(&OnigString::new(">\n"), 0, ScannerFindOptions::from_bits(0))
            .expect("match");

        assert_eq!(matched.capture_indices.len(), 2);
        assert_eq!(matched.capture_indices[0].start, 0);
        assert_eq!(matched.capture_indices[0].end, 1);
        assert_eq!(matched.capture_indices[1].start, 0);
        assert_eq!(matched.capture_indices[1].end, 1);
    }

    #[test]
    fn ferroni_reports_all_begin_captures_in_multi_pattern_scanner() {
        let mut scanner = Scanner::new(&["(<)(template)\\b(>)", "(<)"]).expect("scanner");
        let matched = scanner
            .find_next_match_utf16(
                &OnigString::new("<template>\n"),
                0,
                ScannerFindOptions::from_bits(0),
            )
            .expect("match");

        assert_eq!(matched.index, 0);
        assert_eq!(matched.capture_indices.len(), 4);
        assert_eq!(matched.capture_indices[1].start, 0);
        assert_eq!(matched.capture_indices[1].end, 1);
        assert_eq!(matched.capture_indices[2].start, 1);
        assert_eq!(matched.capture_indices[2].end, 9);
        assert_eq!(matched.capture_indices[3].start, 9);
        assert_eq!(matched.capture_indices[3].end, 10);
    }

    #[test]
    fn compiled_injection_selector_uses_full_scope_stack() {
        let selector =
            compile_selector("L:meta.tag -meta.attribute, L:meta.element -meta.attribute");
        let tag_stack = vec!["text.html.vue".to_owned(), "meta.tag".to_owned()];
        let attr_stack = vec![
            "text.html.vue".to_owned(),
            "meta.tag".to_owned(),
            "meta.attribute".to_owned(),
        ];
        let element_stack = vec!["text.html.vue".to_owned(), "meta.element".to_owned()];

        assert!(selector_matches_compiled(&selector, &tag_stack));
        assert!(selector_matches_compiled(&selector, &element_stack));
        assert!(!selector_matches_compiled(&selector, &attr_stack));
    }

    #[test]
    fn vue_script_setup_while_assertions_keep_embedded_ts_active() {
        let asset_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/shiki");

        let highlighter = create_highlighter(
            json!({ "standardAssetRoot": asset_root.display().to_string() }).to_string(),
        );

        let html = highlighter
      .code_to_html(
        "<script setup lang=\"ts\">\nimport { ref } from 'vue'\nconst count = ref(0)\n</script>\n\n<template>\n  <div>\n    <h1 v-if=\"count == 1 ? true : 'str'.toUpperCase()\">{{ count * 2 }}</h1>\n  </div>\n</template>\n".to_owned(),
        json!({
          "lang": "vue",
          "theme": "vitesse-dark",
        })
        .to_string(),
      )
      .expect("html");

        assert!(html.contains("<span style=\"color:#4D9375\">import</span>"));
        assert!(html.contains("<span style=\"color:#CB7676\">const </span>"));
        assert!(html.contains("<span style=\"color:#666666\">&#x3C;/</span><span style=\"color:#4D9375\">script</span><span style=\"color:#666666\">></span>"));
        assert!(html.contains("<span style=\"color:#666666\">&#x3C;</span><span style=\"color:#4D9375\">template</span><span style=\"color:#666666\">></span>"));
    }
}
