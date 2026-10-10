/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Synchronous raw-grammar, compiled-grammar, and theme registry.

use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::Arc;

use crate::grammar::{Grammar, GrammarConfiguration, ThemeProvider};
use crate::raw_grammar::RawGrammar;
use crate::regexp::ScannerPatternCache;
use crate::rule_factory::{GrammarProvider, GrammarStore};
use crate::theme::{RawTheme, Theme, ThemeError};

pub struct SyncRegistry {
    grammars: BTreeMap<String, Rc<Grammar>>,
    raw_grammars: GrammarStore,
    theme: ThemeProvider,
    color_map: Vec<String>,
    scanner_pattern_cache: ScannerPatternCache,
}

impl SyncRegistry {
    pub fn new(
        theme: Option<RawTheme>,
        color_map: Option<Vec<String>>,
    ) -> Result<Self, ThemeError> {
        let resolved_theme = Theme::create_from_raw_theme(theme.as_ref(), color_map)?;
        Ok(Self {
            grammars: BTreeMap::new(),
            raw_grammars: GrammarStore::new(),
            color_map: resolved_theme.get_color_map(),
            theme: ThemeProvider::new(resolved_theme),
            scanner_pattern_cache: ScannerPatternCache::new(),
        })
    }

    pub fn dispose(&mut self) {
        self.grammars.clear();
        self.scanner_pattern_cache.clear();
        self.raw_grammars.clear();
        self.theme.set_theme(
            Theme::create_from_raw_theme(None, None)
                .expect("the default theme has no frozen color map"),
        );
        self.color_map.clear();
    }

    /// Replaces the theme of this registry and of every grammar it compiled.
    ///
    /// As upstream, compiled grammars stay cached and read the theme at
    /// tokenize time. State stacks returned before the change still carry
    /// metadata encoded with the previous theme.
    pub fn set_theme(
        &mut self,
        theme: Option<RawTheme>,
        color_map: Option<Vec<String>>,
    ) -> Result<(), ThemeError> {
        let resolved_theme = Theme::create_from_raw_theme(theme.as_ref(), color_map)?;
        self.color_map = resolved_theme.get_color_map();
        self.theme.set_theme(resolved_theme);
        Ok(())
    }

    #[must_use]
    pub fn get_color_map(&self) -> Vec<String> {
        self.color_map.clone()
    }

    pub fn add_grammar(&mut self, grammar: RawGrammar, injection_scope_names: Vec<String>) {
        let scope_name = grammar.scope_name.clone();
        self.raw_grammars.insert(grammar);
        self.set_injections(scope_name, injection_scope_names);
    }

    pub fn set_injections(
        &mut self,
        target_scope: impl Into<String>,
        injection_scope_names: Vec<String>,
    ) {
        self.raw_grammars
            .set_injections(target_scope, injection_scope_names);
        // Compiled grammars can include or inject any registered grammar.
        // Registry loading completes before compilation upstream; clearing is
        // the equivalent safe behavior when Rust callers replace a grammar or
        // update a target's external injection list later.
        self.grammars.clear();
        self.scanner_pattern_cache.clear();
    }

    #[must_use]
    pub fn lookup(&self, scope_name: &str) -> Option<Arc<RawGrammar>> {
        self.raw_grammars.lookup(scope_name)
    }

    #[must_use]
    pub fn injections(&self, target_scope: &str) -> Vec<String> {
        self.raw_grammars.injections(target_scope)
    }

    pub fn grammar_for_scope_name(
        &mut self,
        scope_name: &str,
        configuration: GrammarConfiguration,
    ) -> Result<Option<Rc<Grammar>>, ThemeError> {
        if let Some(grammar) = self.grammars.get(scope_name) {
            return Ok(Some(Rc::clone(grammar)));
        }
        let Some(raw_grammar) = self.raw_grammars.lookup(scope_name) else {
            return Ok(None);
        };
        let grammar = Rc::new(Grammar::with_theme_provider(
            &raw_grammar,
            &self.raw_grammars,
            self.theme.clone(),
            configuration,
            self.scanner_pattern_cache.clone(),
        ));
        self.grammars
            .insert(scope_name.to_owned(), Rc::clone(&grammar));
        Ok(Some(grammar))
    }
}

impl GrammarProvider for SyncRegistry {
    fn lookup(&self, scope_name: &str) -> Option<Arc<RawGrammar>> {
        self.raw_grammars.lookup(scope_name)
    }

    fn injections(&self, scope_name: &str) -> Vec<String> {
        self.raw_grammars.injections(scope_name)
    }
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;

    use super::SyncRegistry;
    use crate::{
        EncodedTokenAttributes, GrammarConfiguration, RawGrammar, RawTheme, RawThemeScope,
        RawThemeSetting, RawThemeStyle,
    };

    fn grammar(source: &str) -> RawGrammar {
        serde_json::from_str(source).unwrap()
    }

    #[test]
    fn caches_grammars_and_invalidates_them_on_registration() {
        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(
            grammar(
                r#"{
                    "scopeName": "source.test",
                    "patterns": [{ "match": "x", "name": "keyword.test" }]
                }"#,
            ),
            Vec::new(),
        );
        let first = registry
            .grammar_for_scope_name("source.test", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        let cached = registry
            .grammar_for_scope_name("source.test", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        assert!(Rc::ptr_eq(&first, &cached));

        registry.add_grammar(
            grammar(
                r#"{
                    "scopeName": "source.test",
                    "patterns": [{ "match": "y", "name": "keyword.test" }]
                }"#,
            ),
            Vec::new(),
        );
        let replaced = registry
            .grammar_for_scope_name("source.test", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        assert!(!Rc::ptr_eq(&first, &replaced));
    }

    #[test]
    fn resolves_registered_injections_and_theme_changes() {
        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(
            grammar(
                r#"{
                    "scopeName": "source.test",
                    "patterns": [{ "match": "x", "name": "normal.test" }]
                }"#,
            ),
            vec!["source.inject".into()],
        );
        registry.add_grammar(
            grammar(
                r#"{
                    "scopeName": "source.inject",
                    "injectionSelector": "L:source.test",
                    "patterns": [{ "match": "x", "name": "injected.test" }]
                }"#,
            ),
            Vec::new(),
        );
        let grammar = registry
            .grammar_for_scope_name("source.test", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        let result = grammar.tokenize_line("x", None, 0).unwrap();
        assert_eq!(result.tokens[0].scopes, ["source.test", "injected.test"]);

        registry
            .set_theme(
                Some(RawTheme {
                    settings: vec![RawThemeSetting {
                        scope: Some(RawThemeScope::String("injected.test".into())),
                        settings: Some(RawThemeStyle {
                            foreground: Some("#112233".into()),
                            ..RawThemeStyle::default()
                        }),
                        ..RawThemeSetting::default()
                    }],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap();

        assert!(registry.get_color_map().contains(&"#112233".into()));
    }

    #[test]
    fn keeps_compiled_grammars_across_theme_changes() {
        fn theme(color: &str) -> RawTheme {
            RawTheme {
                settings: vec![RawThemeSetting {
                    scope: Some(RawThemeScope::String("keyword.test".into())),
                    settings: Some(RawThemeStyle {
                        foreground: Some(color.into()),
                        ..RawThemeStyle::default()
                    }),
                    ..RawThemeSetting::default()
                }],
                ..RawTheme::default()
            }
        }
        fn keyword_color(registry: &mut SyncRegistry) -> String {
            let grammar = registry
                .grammar_for_scope_name("source.test", GrammarConfiguration::default())
                .unwrap()
                .unwrap();
            let tokens = grammar.tokenize_line2("x", None, 0).unwrap().tokens;
            let foreground = EncodedTokenAttributes::new(tokens[1]).foreground();
            registry.get_color_map()[foreground as usize].clone()
        }
        let source = r#"{
            "scopeName": "source.test",
            "patterns": [{ "match": "x", "name": "keyword.test" }]
        }"#;

        let mut registry = SyncRegistry::new(Some(theme("#112233")), None).unwrap();
        registry.add_grammar(grammar(source), Vec::new());
        let compiled = registry
            .grammar_for_scope_name("source.test", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        assert_eq!(keyword_color(&mut registry), "#112233");

        registry.set_theme(Some(theme("#445566")), None).unwrap();
        let cached = registry
            .grammar_for_scope_name("source.test", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        assert!(Rc::ptr_eq(&compiled, &cached));
        assert_eq!(keyword_color(&mut registry), "#445566");
        assert_eq!(compiled.color_map(), registry.get_color_map());

        let mut fresh = SyncRegistry::new(Some(theme("#445566")), None).unwrap();
        fresh.add_grammar(grammar(source), Vec::new());
        let fresh_grammar = fresh
            .grammar_for_scope_name("source.test", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        assert_eq!(
            cached.tokenize_line2("x", None, 0).unwrap().tokens,
            fresh_grammar.tokenize_line2("x", None, 0).unwrap().tokens
        );

        registry.set_theme(Some(theme("#112233")), None).unwrap();
        assert_eq!(keyword_color(&mut registry), "#112233");
    }

    #[test]
    fn returns_none_for_an_unknown_scope() {
        let mut registry = SyncRegistry::new(None, None).unwrap();
        assert!(
            registry
                .grammar_for_scope_name("source.missing", GrammarConfiguration::default())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn updates_injections_after_the_target_was_registered() {
        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(
            grammar(
                r#"{
                    "scopeName": "source.test",
                    "patterns": [{ "match": "x", "name": "normal.test" }]
                }"#,
            ),
            Vec::new(),
        );
        registry.add_grammar(
            grammar(
                r#"{
                    "scopeName": "source.inject",
                    "injectionSelector": "L:source.test",
                    "patterns": [{ "match": "x", "name": "injected.test" }]
                }"#,
            ),
            Vec::new(),
        );

        let before = registry
            .grammar_for_scope_name("source.test", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        assert_eq!(
            before.tokenize_line("x", None, 0).unwrap().tokens[0].scopes,
            ["source.test", "normal.test"]
        );
        assert_eq!(registry.scanner_pattern_cache.len(), 1);

        registry.set_injections("source.test", vec!["source.inject".into()]);
        assert_eq!(registry.scanner_pattern_cache.len(), 0);
        assert_eq!(
            before.tokenize_line("x", None, 0).unwrap().tokens[0].scopes,
            ["source.test", "normal.test"]
        );

        let after = registry
            .grammar_for_scope_name("source.test", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        assert!(!Rc::ptr_eq(&before, &after));
        assert_eq!(
            after.tokenize_line("x", None, 0).unwrap().tokens[0].scopes,
            ["source.test", "injected.test"]
        );
        assert_eq!(registry.scanner_pattern_cache.len(), 1);
    }

    #[test]
    fn shares_static_patterns_across_grammars_and_keeps_prefilter_settings_separate() {
        let mut registry = SyncRegistry::new(None, None).unwrap();
        for scope_name in ["source.first", "source.second", "source.unfiltered"] {
            registry.add_grammar(
                grammar(&format!(
                    r#"{{
                        "scopeName": "{scope_name}",
                        "patterns": [{{ "match": "x", "name": "keyword.test" }}]
                    }}"#
                )),
                Vec::new(),
            );
        }

        let first = registry
            .grammar_for_scope_name("source.first", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        let first_tokens = first.tokenize_line("x", None, 0).unwrap().tokens;
        assert_eq!(registry.scanner_pattern_cache.len(), 1);

        let second = registry
            .grammar_for_scope_name("source.second", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        let second_tokens = second.tokenize_line("x", None, 0).unwrap().tokens;
        assert_eq!(registry.scanner_pattern_cache.len(), 1);

        let unfiltered = registry
            .grammar_for_scope_name(
                "source.unfiltered",
                GrammarConfiguration::default().with_regex_prefilter(false),
            )
            .unwrap()
            .unwrap();
        let unfiltered_tokens = unfiltered.tokenize_line("x", None, 0).unwrap().tokens;
        assert_eq!(registry.scanner_pattern_cache.len(), 2);

        assert_eq!(first_tokens[0].start_index, second_tokens[0].start_index);
        assert_eq!(first_tokens[0].end_index, second_tokens[0].end_index);
        assert_eq!(
            first_tokens[0].scopes.last(),
            second_tokens[0].scopes.last()
        );
        assert_eq!(
            first_tokens[0].start_index,
            unfiltered_tokens[0].start_index
        );
        assert_eq!(first_tokens[0].end_index, unfiltered_tokens[0].end_index);
        assert_eq!(
            first_tokens[0].scopes.last(),
            unfiltered_tokens[0].scopes.last()
        );
    }

    #[test]
    fn shared_patterns_keep_backtracking_warnings_on_each_grammar() {
        let mut registry = SyncRegistry::new(None, None).unwrap();
        for scope_name in ["source.first", "source.second"] {
            registry.add_grammar(
                grammar(&format!(
                    r#"{{
                        "scopeName": "{scope_name}",
                        "patterns": [{{
                            "match": "([0-9]+(_?))+(\\.)([0-9]+)",
                            "name": "number.risky"
                        }}]
                    }}"#
                )),
                Vec::new(),
            );
        }

        let first = registry
            .grammar_for_scope_name("source.first", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        first.tokenize_line("123.45", None, 0).unwrap();
        let first_warnings = first.backtracking_warnings();

        let second = registry
            .grammar_for_scope_name("source.second", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        second.tokenize_line("123.45", None, 0).unwrap();
        let second_warnings = second.backtracking_warnings();

        assert_eq!(registry.scanner_pattern_cache.len(), 1);
        assert_eq!(first_warnings.len(), 1);
        assert_eq!(second_warnings.len(), 1);
        assert_eq!(first_warnings[0].pattern, second_warnings[0].pattern);
        assert_eq!(first_warnings[0].risk, second_warnings[0].risk);
        assert_eq!(first_warnings[0].message, second_warnings[0].message);
    }

    #[test]
    fn dynamic_end_patterns_do_not_accumulate_in_registry_cache() {
        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(
            grammar(
                r#"{
                    "scopeName": "source.dynamic",
                    "patterns": [{
                        "begin": "(<[A-Z0-9]+>)",
                        "end": "\\1",
                        "name": "string.dynamic"
                    }]
                }"#,
            ),
            Vec::new(),
        );
        let grammar = registry
            .grammar_for_scope_name("source.dynamic", GrammarConfiguration::default())
            .unwrap()
            .unwrap();

        for index in 0..64 {
            let tag = format!("DOC{index}");
            let line = format!("<{tag}>body<{tag}>");
            let result = grammar.tokenize_line(&line, None, 0).unwrap();
            assert_eq!(
                result.rule_stack.depth, 1,
                "dynamic end did not close {tag}"
            );
            assert_eq!(
                result.tokens.last().unwrap().scopes,
                ["source.dynamic", "string.dynamic"],
                "dynamic end output changed for {tag}"
            );
            assert_eq!(registry.scanner_pattern_cache.len(), 1);
        }
    }

    #[test]
    fn dynamic_while_patterns_do_not_accumulate_in_registry_cache() {
        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(
            grammar(
                r#"{
                    "scopeName": "source.dynamic-while",
                    "patterns": [{
                        "begin": "(<[A-Z0-9]+>)",
                        "while": "\\1",
                        "name": "string.dynamic"
                    }]
                }"#,
            ),
            Vec::new(),
        );
        let grammar = registry
            .grammar_for_scope_name("source.dynamic-while", GrammarConfiguration::default())
            .unwrap()
            .unwrap();

        for index in 0..64 {
            let tag = format!("DOC{index}");
            let opening = format!("<{tag}>body");
            let first = grammar.tokenize_line(&opening, None, 0).unwrap();
            assert_eq!(first.rule_stack.depth, 2);

            let continued = format!("<{tag}>continued");
            let second = grammar
                .tokenize_line(&continued, Some(first.rule_stack), 0)
                .unwrap();
            assert_eq!(
                second.rule_stack.depth, 2,
                "dynamic while did not match the captured tag {tag}"
            );

            let mismatch = grammar
                .tokenize_line("plain close", Some(second.rule_stack), 0)
                .unwrap();
            assert_eq!(
                mismatch.rule_stack.depth, 1,
                "dynamic while retained the stack for a different tag {tag}"
            );
            assert_eq!(registry.scanner_pattern_cache.len(), 1);
        }
    }

    #[test]
    fn dispose_releases_raw_and_compiled_grammar_state() {
        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(
            grammar(
                r#"{
                    "scopeName": "source.test",
                    "patterns": [{ "match": "x", "name": "normal.test" }]
                }"#,
            ),
            vec!["source.inject".into()],
        );
        let grammar = registry
            .grammar_for_scope_name("source.test", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        grammar.tokenize_line("x", None, 0).unwrap();
        assert_eq!(registry.scanner_pattern_cache.len(), 1);
        assert!(registry.lookup("source.test").is_some());
        assert_eq!(registry.injections("source.test"), ["source.inject"]);

        registry.dispose();

        assert!(registry.lookup("source.test").is_none());
        assert!(registry.injections("source.test").is_empty());
        assert_eq!(registry.scanner_pattern_cache.len(), 0);
        assert_eq!(
            grammar.tokenize_line("x", None, 0).unwrap().tokens[0].scopes,
            ["source.test", "normal.test"]
        );
        assert!(
            registry
                .grammar_for_scope_name("source.test", GrammarConfiguration::default())
                .unwrap()
                .is_none()
        );
        assert!(registry.get_color_map().is_empty());
    }
}
