/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Synchronous raw-grammar, compiled-grammar, and theme registry.

use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::Arc;

use crate::grammar::{Grammar, GrammarConfiguration, ThemeProvider};
use crate::raw_grammar::RawGrammar;
use crate::rule_factory::{GrammarProvider, GrammarStore};
use crate::theme::{RawTheme, Theme, ThemeError};

pub struct SyncRegistry {
    grammars: BTreeMap<String, Rc<Grammar>>,
    raw_grammars: GrammarStore,
    theme: ThemeProvider,
    color_map: Vec<String>,
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
        })
    }

    pub fn dispose(&mut self) {
        self.grammars.clear();
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

        registry.set_injections("source.test", vec!["source.inject".into()]);

        let after = registry
            .grammar_for_scope_name("source.test", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        assert!(!Rc::ptr_eq(&before, &after));
        assert_eq!(
            after.tokenize_line("x", None, 0).unwrap().tokens[0].scopes,
            ["source.test", "injected.test"]
        );
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
        let _ = registry
            .grammar_for_scope_name("source.test", GrammarConfiguration::default())
            .unwrap();
        assert!(registry.lookup("source.test").is_some());
        assert_eq!(registry.injections("source.test"), ["source.inject"]);

        registry.dispose();

        assert!(registry.lookup("source.test").is_none());
        assert!(registry.injections("source.test").is_empty());
        assert!(
            registry
                .grammar_for_scope_name("source.test", GrammarConfiguration::default())
                .unwrap()
                .is_none()
        );
        assert!(registry.get_color_map().is_empty());
    }
}
