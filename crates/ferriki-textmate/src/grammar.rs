/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::sync::Arc;

use ferroni::error::RegexError;

use crate::attributed_scope_stack::{AttributedScopeStack, ScopeAttributesProvider};
use crate::basic_scope_attributes::{
    BasicScopeAttributes, BasicScopeAttributesProvider, EmbeddedLanguages,
};
use crate::encoded_token_attributes::{EncodedTokenAttributes, FontAttribute, StandardTokenType};
use crate::line_output::{
    BalancedBracketSelectors, FontInfo, LineFonts, LineTokens, Token, TokenTypeMatcher,
};
use crate::matcher::MatcherPriority;
use crate::raw_grammar::{RawGrammar, RuleId};
use crate::regexp::OnigString;
use crate::rule::RuleRegistry;
use crate::rule_factory::{GrammarProvider, RuleFactory};
use crate::state_stack::StateStack;
use crate::theme::{ScopeStack, StyleAttributes, Theme};
use crate::tokenize_string::{tokenize_string, Injection, TokenizeStringResult, TokenizerGrammar};

#[derive(Clone, Default)]
pub struct GrammarConfiguration {
    pub initial_language_id: u32,
    pub embedded_languages: EmbeddedLanguages,
    pub token_types: Vec<(String, StandardTokenType)>,
    pub balanced_bracket_selectors: Option<Vec<String>>,
    pub unbalanced_bracket_selectors: Vec<String>,
}

pub struct TokenizeLineResult {
    pub tokens: Vec<Token>,
    pub fonts: Vec<FontInfo>,
    pub rule_stack: Arc<StateStack>,
    pub stopped_early: bool,
}

pub struct TokenizeLineResult2 {
    pub tokens: Vec<u32>,
    pub fonts: Vec<FontInfo>,
    pub rule_stack: Arc<StateStack>,
    pub stopped_early: bool,
}

pub struct Grammar {
    root_id: RuleId,
    root_scope_name: String,
    registry: RuleRegistry,
    injections: Vec<Injection>,
    basic_scope_attributes: BasicScopeAttributesProvider,
    token_type_matchers: Vec<TokenTypeMatcher>,
    balanced_bracket_selectors: Option<BalancedBracketSelectors>,
    theme: Theme,
}

impl Grammar {
    #[must_use]
    pub fn new(
        raw_grammar: &RawGrammar,
        grammar_provider: &dyn GrammarProvider,
        theme: Theme,
        configuration: GrammarConfiguration,
    ) -> Self {
        let mut factory = RuleFactory::new(raw_grammar, grammar_provider);
        let root_id = factory.compile_root();
        let root_grammar = Arc::clone(factory.root_grammar());
        let mut injections = Vec::new();

        for (selector, rule) in &root_grammar.injections {
            let rule_id = factory.compile_raw_rule(Arc::clone(rule), &root_grammar.repository);
            injections.extend(Injection::from_selector(selector, rule_id));
        }

        for injection_scope_name in grammar_provider.injections(&root_grammar.scope_name) {
            let Some((injection_grammar, rule_id)) =
                factory.compile_external_grammar(&injection_scope_name)
            else {
                continue;
            };
            if let Some(selector) = injection_grammar.injection_selector.as_deref() {
                injections.extend(Injection::from_selector(selector, rule_id));
            }
        }
        injections.sort_by_key(|injection| priority_order(injection.priority));

        let (_, registry) = factory.into_parts();
        let token_type_matchers = configuration
            .token_types
            .iter()
            .flat_map(|(selector, token_type)| {
                TokenTypeMatcher::from_selector(selector, *token_type)
            })
            .collect();
        let balanced_bracket_selectors =
            configuration
                .balanced_bracket_selectors
                .as_ref()
                .map(|balanced| {
                    BalancedBracketSelectors::new(
                        balanced,
                        &configuration.unbalanced_bracket_selectors,
                    )
                });

        Self {
            root_id,
            root_scope_name: root_grammar.scope_name.clone(),
            registry,
            injections,
            basic_scope_attributes: BasicScopeAttributesProvider::new(
                configuration.initial_language_id,
                Some(&configuration.embedded_languages),
            ),
            token_type_matchers,
            balanced_bracket_selectors,
            theme,
        }
    }

    #[must_use]
    pub fn root_scope_name(&self) -> &str {
        &self.root_scope_name
    }

    #[must_use]
    pub const fn root_rule_id(&self) -> RuleId {
        self.root_id
    }

    #[must_use]
    pub fn color_map(&self) -> Vec<String> {
        self.theme.get_color_map()
    }

    pub fn tokenize_line(
        &self,
        line_text: &str,
        previous_state: Option<Arc<StateStack>>,
        time_limit_millis: u64,
    ) -> Result<TokenizeLineResult, RegexError> {
        let mut tokenized = self.tokenize(line_text, previous_state, false, time_limit_millis)?;
        Ok(TokenizeLineResult {
            tokens: tokenized
                .line_tokens
                .result(&tokenized.result.stack, tokenized.line_length),
            fonts: tokenized.line_fonts.result(),
            rule_stack: tokenized.result.stack,
            stopped_early: tokenized.result.stopped_early,
        })
    }

    pub fn tokenize_line2(
        &self,
        line_text: &str,
        previous_state: Option<Arc<StateStack>>,
        time_limit_millis: u64,
    ) -> Result<TokenizeLineResult2, RegexError> {
        let mut tokenized = self.tokenize(line_text, previous_state, true, time_limit_millis)?;
        Ok(TokenizeLineResult2 {
            tokens: tokenized
                .line_tokens
                .binary_result(&tokenized.result.stack, tokenized.line_length),
            fonts: tokenized.line_fonts.result(),
            rule_stack: tokenized.result.stack,
            stopped_early: tokenized.result.stopped_early,
        })
    }

    fn tokenize(
        &self,
        line_text: &str,
        previous_state: Option<Arc<StateStack>>,
        emit_binary_tokens: bool,
        time_limit_millis: u64,
    ) -> Result<TokenizedLine, RegexError> {
        let (is_first_line, previous_state) = match previous_state {
            Some(state) if state.rule_id().get() != 0 => {
                state.reset();
                (false, state)
            }
            _ => (true, self.initial_state()),
        };

        let line_text = format!("{line_text}\n");
        let onig_line_text = OnigString::new(&line_text);
        let line_length = onig_line_text.utf16_len();
        let mut line_tokens = LineTokens::new(
            emit_binary_tokens,
            &line_text,
            self.token_type_matchers.clone(),
            self.balanced_bracket_selectors.clone(),
        );
        let mut line_fonts = LineFonts::new();
        let result = tokenize_string(
            self,
            &onig_line_text,
            is_first_line,
            0,
            previous_state,
            &mut line_tokens,
            &mut line_fonts,
            true,
            time_limit_millis,
        )?;

        Ok(TokenizedLine {
            line_length,
            line_tokens,
            line_fonts,
            result,
        })
    }

    fn initial_state(&self) -> Arc<StateStack> {
        let raw_default_metadata = self.basic_scope_attributes.default_attributes();
        let default_style = self.theme.get_defaults();
        let default_metadata = EncodedTokenAttributes::default().set(
            raw_default_metadata.language_id,
            raw_default_metadata.token_type,
            None,
            default_style.font_style,
            default_style.foreground_id,
            default_style.background_id,
        );
        let font_attribute = FontAttribute::from(
            Some(default_style.font_family.clone()),
            Some(default_style.font_size),
            Some(default_style.line_height),
        );
        let root_scope_name = self
            .registry
            .get_rule(self.root_id)
            .get_name(None, None)
            .unwrap_or_else(|| "unknown".into());
        let scope_list = AttributedScopeStack::create_root_and_lookup_scope_name(
            root_scope_name,
            default_metadata,
            font_attribute,
            self,
        );
        StateStack::new(
            None,
            self.root_id,
            -1,
            -1,
            false,
            None,
            Some(Arc::clone(&scope_list)),
            Some(scope_list),
        )
    }
}

impl ScopeAttributesProvider for Grammar {
    fn metadata_for_scope(&self, scope_name: &str) -> BasicScopeAttributes {
        self.basic_scope_attributes
            .basic_scope_attributes(Some(scope_name))
    }

    fn theme_match(&self, scope_path: &ScopeStack) -> Option<StyleAttributes> {
        self.theme.match_scope(Some(scope_path))
    }
}

impl TokenizerGrammar for Grammar {
    fn rule_registry(&self) -> &RuleRegistry {
        &self.registry
    }

    fn injections(&self) -> &[Injection] {
        &self.injections
    }
}

struct TokenizedLine {
    line_length: usize,
    line_tokens: LineTokens,
    line_fonts: LineFonts,
    result: TokenizeStringResult,
}

const fn priority_order(priority: MatcherPriority) -> i8 {
    match priority {
        MatcherPriority::Left => -1,
        MatcherPriority::Normal => 0,
        MatcherPriority::Right => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::{Grammar, GrammarConfiguration};
    use crate::{
        EncodedTokenAttributes, GrammarStore, RawGrammar, RawTheme, StandardTokenType, Theme,
    };

    fn raw_grammar(source: &str) -> RawGrammar {
        serde_json::from_str(source).expect("test grammar should deserialize")
    }

    fn default_theme() -> Theme {
        Theme::create_from_raw_theme(None, None).unwrap()
    }

    #[test]
    fn tokenizes_text_and_carries_state_across_lines() {
        let raw = raw_grammar(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "\"",
                    "end": "\"",
                    "name": "string.quoted"
                }]
            }"#,
        );
        let grammar = Grammar::new(
            &raw,
            &GrammarStore::new(),
            default_theme(),
            GrammarConfiguration {
                initial_language_id: 7,
                ..GrammarConfiguration::default()
            },
        );

        let first = grammar.tokenize_line("\"open", None, 0).unwrap();
        assert_eq!(first.rule_stack.depth, 2);
        assert_eq!(first.tokens[0].scopes, ["source.test", "string.quoted"]);
        let second = grammar
            .tokenize_line("close\"", Some(first.rule_stack), 0)
            .unwrap();
        assert_eq!(second.rule_stack.depth, 1);
        assert!(!second.stopped_early);
    }

    #[test]
    fn resolves_binary_metadata_and_bracket_configuration() {
        let raw = raw_grammar(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "match": "x",
                    "name": "meta.embedded.test"
                }]
            }"#,
        );
        let grammar = Grammar::new(
            &raw,
            &GrammarStore::new(),
            default_theme(),
            GrammarConfiguration {
                initial_language_id: 7,
                token_types: vec![("meta.embedded".into(), StandardTokenType::String)],
                balanced_bracket_selectors: Some(vec!["*".into()]),
                ..GrammarConfiguration::default()
            },
        );

        let result = grammar.tokenize_line2("x", None, 0).unwrap();
        let metadata = EncodedTokenAttributes::new(result.tokens[1]);

        assert_eq!(result.tokens[0], 0);
        assert_eq!(metadata.language_id(), 7);
        assert_eq!(metadata.token_type(), StandardTokenType::String);
        assert!(metadata.contains_balanced_brackets());
    }

    #[test]
    fn applies_root_and_contributed_injections() {
        let root = raw_grammar(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "x", "name": "normal.test" }],
                "injections": {
                    "L:source.test": {
                        "match": "a",
                        "name": "root.injection"
                    }
                }
            }"#,
        );
        let external = raw_grammar(
            r#"{
                "scopeName": "source.injection",
                "injectionSelector": "L:source.test",
                "patterns": [{
                    "match": "x",
                    "name": "external.injection"
                }]
            }"#,
        );
        let mut store = GrammarStore::new();
        store.insert(external);
        store.set_injections("source.test", vec!["source.injection".into()]);
        let grammar = Grammar::new(
            &root,
            &store,
            default_theme(),
            GrammarConfiguration::default(),
        );

        let root_result = grammar.tokenize_line("a", None, 0).unwrap();
        assert_eq!(
            root_result.tokens[0].scopes,
            ["source.test", "root.injection"]
        );
        let external_result = grammar.tokenize_line("x", None, 0).unwrap();
        assert_eq!(
            external_result.tokens[0].scopes,
            ["source.test", "external.injection"]
        );
    }

    #[test]
    fn exposes_theme_color_map_and_scope_styles() {
        let raw = raw_grammar(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "x", "name": "keyword.test" }]
            }"#,
        );
        let raw_theme: RawTheme = serde_json::from_str(
            r##"{
                "settings": [
                    { "settings": { "foreground": "#010203" } },
                    {
                        "scope": "keyword",
                        "settings": { "foreground": "#aabbcc" }
                    }
                ]
            }"##,
        )
        .unwrap();
        let grammar = Grammar::new(
            &raw,
            &GrammarStore::new(),
            Theme::create_from_raw_theme(Some(&raw_theme), None).unwrap(),
            GrammarConfiguration::default(),
        );

        let result = grammar.tokenize_line2("x", None, 0).unwrap();
        let metadata = EncodedTokenAttributes::new(result.tokens[1]);

        assert_eq!(
            grammar.color_map()[metadata.foreground() as usize],
            "#AABBCC"
        );
    }
}
