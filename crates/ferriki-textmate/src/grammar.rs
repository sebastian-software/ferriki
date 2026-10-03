/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::sync::Arc;

use crate::BacktrackingWarning;
use crate::RegexError;

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
use crate::tokenize_string::{Injection, TokenizeStringResult, TokenizerGrammar, tokenize_string};

#[derive(Clone, Default)]
#[non_exhaustive]
pub struct GrammarConfiguration {
    pub initial_language_id: u32,
    pub embedded_languages: EmbeddedLanguages,
    pub token_types: Vec<(String, StandardTokenType)>,
    pub balanced_bracket_selectors: Option<Vec<String>>,
    pub unbalanced_bracket_selectors: Vec<String>,
}

impl GrammarConfiguration {
    /// Sets the language id encoded into tokens of the root grammar.
    #[must_use]
    pub fn with_initial_language_id(mut self, value: u32) -> Self {
        self.initial_language_id = value;
        self
    }

    /// Maps embedded scope names to language ids.
    #[must_use]
    pub fn with_embedded_languages(mut self, value: EmbeddedLanguages) -> Self {
        self.embedded_languages = value;
        self
    }

    /// Maps scope selectors to standard token types.
    #[must_use]
    pub fn with_token_types(mut self, value: Vec<(String, StandardTokenType)>) -> Self {
        self.token_types = value;
        self
    }

    /// Sets the scope selectors whose brackets count as balanced; `None` disables bracket tracking.
    #[must_use]
    pub fn with_balanced_bracket_selectors(mut self, value: Option<Vec<String>>) -> Self {
        self.balanced_bracket_selectors = value;
        self
    }

    /// Sets the scope selectors excluded from bracket balancing.
    #[must_use]
    pub fn with_unbalanced_bracket_selectors(mut self, value: Vec<String>) -> Self {
        self.unbalanced_bracket_selectors = value;
        self
    }
}

#[non_exhaustive]
pub struct TokenizeLineResult {
    pub tokens: Vec<Token>,
    pub fonts: Vec<FontInfo>,
    pub rule_stack: Arc<StateStack>,
    pub stopped_early: bool,
}

#[non_exhaustive]
pub struct TokenizeLineResult2 {
    pub tokens: Vec<u32>,
    pub fonts: Vec<FontInfo>,
    pub rule_stack: Arc<StateStack>,
    pub stopped_early: bool,
}

/// Scope tokens and themed binary tokens produced by a single grammar scan.
///
/// The two outputs retain their own UTF-16 boundaries: adjacent binary tokens
/// may merge when metadata is equal, while scope tokens keep grammar boundaries.
#[derive(Clone)]
#[non_exhaustive]
pub struct TokenizeLineResultWithScopes {
    /// Unmerged grammar tokens with scope paths and UTF-16 start/end offsets.
    pub tokens: Vec<Token>,
    /// Alternating UTF-16 start offsets and encoded metadata, as in `tokenize_line2`.
    pub binary_tokens: Vec<u32>,
    pub fonts: Vec<FontInfo>,
    pub rule_stack: Arc<StateStack>,
    pub stopped_early: bool,
}

impl std::fmt::Debug for TokenizeLineResultWithScopes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenizeLineResultWithScopes")
            .field("tokens", &self.tokens)
            .field("binary_tokens", &self.binary_tokens)
            .field("fonts", &self.fonts)
            .field("rule_stack", &format_args!("{}", self.rule_stack))
            .field("stopped_early", &self.stopped_early)
            .finish()
    }
}

impl PartialEq for TokenizeLineResultWithScopes {
    fn eq(&self, other: &Self) -> bool {
        self.tokens == other.tokens
            && self.binary_tokens == other.binary_tokens
            && self.fonts == other.fonts
            && self.rule_stack.equals(&other.rule_stack)
            && self.stopped_early == other.stopped_early
    }
}

enum TokenOutput {
    Scopes,
    Binary,
    Both,
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
    /// Compiles a grammar directly. Applications obtain grammars from
    /// [`crate::SyncRegistry::grammar_for_scope_name`].
    #[doc(hidden)]
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

    /// Returns advisory backtracking warnings discovered by scanners compiled
    /// so far while tokenizing this grammar.
    ///
    /// TextMate scanners are compiled lazily. The returned list can grow as
    /// more input reaches rules; it does not lint rules that have not yet been
    /// compiled and is not a complete grammar lint. Call this after
    /// tokenization to inspect the findings seen so far.
    #[must_use]
    pub fn backtracking_warnings(&self) -> Vec<BacktrackingWarning> {
        self.registry.backtracking_warnings()
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) const fn root_rule_id(&self) -> RuleId {
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
        let mut tokenized = self.tokenize(
            line_text,
            previous_state,
            TokenOutput::Scopes,
            time_limit_millis,
        )?;
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
        let mut tokenized = self.tokenize(
            line_text,
            previous_state,
            TokenOutput::Binary,
            time_limit_millis,
        )?;
        Ok(TokenizeLineResult2 {
            tokens: tokenized
                .line_tokens
                .binary_result(&tokenized.result.stack, tokenized.line_length),
            fonts: tokenized.line_fonts.result(),
            rule_stack: tokenized.result.stack,
            stopped_early: tokenized.result.stopped_early,
        })
    }

    /// Produces the outputs of [`Self::tokenize_line`] and [`Self::tokenize_line2`]
    /// together, including captures and injections, without repeating the scan.
    /// The time limit and returned state belong to this single scan.
    pub fn tokenize_line_with_scopes(
        &self,
        line_text: &str,
        previous_state: Option<Arc<StateStack>>,
        time_limit_millis: u64,
    ) -> Result<TokenizeLineResultWithScopes, RegexError> {
        let mut tokenized = self.tokenize(
            line_text,
            previous_state,
            TokenOutput::Both,
            time_limit_millis,
        )?;
        Ok(TokenizeLineResultWithScopes {
            tokens: tokenized
                .line_tokens
                .result(&tokenized.result.stack, tokenized.line_length),
            binary_tokens: tokenized
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
        output: TokenOutput,
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
            !matches!(output, TokenOutput::Scopes),
            &line_text,
            self.token_type_matchers.clone(),
            self.balanced_bracket_selectors.clone(),
        );
        if matches!(output, TokenOutput::Both) {
            line_tokens = line_tokens.with_scopes();
        }
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
        BacktrackingRisk, EncodedTokenAttributes, GrammarStore, RawGrammar, RawTheme,
        StandardTokenType, Theme,
    };

    fn raw_grammar(source: &str) -> RawGrammar {
        serde_json::from_str(source).expect("test grammar should deserialize")
    }

    fn default_theme() -> Theme {
        Theme::create_from_raw_theme(None, None).unwrap()
    }

    #[test]
    fn reports_lazy_backtracking_warnings_for_included_grammar_rules() {
        let root = raw_grammar(
            r#"{
                "scopeName": "source.host",
                "patterns": [
                    { "include": "source.embedded" },
                    { "match": "[a-z]+", "name": "word.clean" }
                ]
            }"#,
        );
        let embedded = raw_grammar(
            r#"{
                "scopeName": "source.embedded",
                "patterns": [{
                    "match": "([0-9]+(_?))+(\\.)([0-9]+)",
                    "name": "constant.numeric.risky",
                    "$vscodeTextmateLocation": {
                        "filename": "embedded.tmLanguage.json",
                        "line": 12,
                        "char": 4
                    }
                }, {
                    "match": "(a|aa)*Z",
                    "name": "comment.overlapping.risky"
                }]
            }"#,
        );
        let mut store = GrammarStore::new();
        store.insert(embedded);
        let grammar = Grammar::new(
            &root,
            &store,
            default_theme(),
            GrammarConfiguration::default(),
        );

        assert!(grammar.backtracking_warnings().is_empty());
        grammar.tokenize_line("123.45 clean", None, 0).unwrap();
        let warnings = grammar.backtracking_warnings();

        assert_eq!(warnings.len(), 2);
        let nested = warnings
            .iter()
            .find(|warning| warning.rule == "constant.numeric.risky")
            .expect("nested quantifier warning");
        assert_eq!(nested.grammar_scope_name, "source.embedded");
        assert_eq!(
            nested.rule_location.as_deref(),
            Some("embedded.tmLanguage.json:12:4")
        );
        assert_eq!(nested.pattern, r"([0-9]+(_?))+(\.)([0-9]+)");
        assert_eq!(nested.risk, BacktrackingRisk::NestedQuantifier);
        assert!(!nested.message.is_empty());
        let overlapping = warnings
            .iter()
            .find(|warning| warning.rule == "comment.overlapping.risky")
            .expect("overlapping alternatives warning");
        assert_eq!(overlapping.grammar_scope_name, "source.embedded");
        assert_eq!(overlapping.pattern, "(a|aa)*Z");
        assert_eq!(overlapping.risk, BacktrackingRisk::OverlappingAlternation);

        grammar.tokenize_line("aaZ clean", None, 0).unwrap();
        grammar.tokenize_line("99.1 clean", None, 0).unwrap();
        assert_eq!(grammar.backtracking_warnings(), warnings);
    }

    #[test]
    fn attributes_end_and_while_warnings_to_their_owning_rules() {
        let raw = raw_grammar(
            r#"{
                "scopeName": "source.test",
                "patterns": [
                    {
                        "begin": "(a+)+$",
                        "end": "Z",
                        "name": "meta.begin-risky",
                        "$vscodeTextmateLocation": {
                            "filename": "begin.tmLanguage.json",
                            "line": 7,
                            "char": 2
                        }
                    },
                    {
                        "begin": "END",
                        "end": "(c+)+$",
                        "name": "meta.end-risky",
                        "$vscodeTextmateLocation": {
                            "filename": "end.tmLanguage.json",
                            "line": 12,
                            "char": 5
                        }
                    },
                    {
                        "begin": "WHILE",
                        "while": "(b+)+$",
                        "name": "meta.while-risky",
                        "$vscodeTextmateLocation": {
                            "filename": "while.tmLanguage.json",
                            "line": 18,
                            "char": 3
                        }
                    }
                ]
            }"#,
        );
        let grammar = Grammar::new(
            &raw,
            &GrammarStore::new(),
            default_theme(),
            GrammarConfiguration::default(),
        );

        let begin_state = grammar.tokenize_line("aaa", None, 0).unwrap().rule_stack;
        grammar.tokenize_line("aaa", Some(begin_state), 0).unwrap();

        let end_state = grammar.tokenize_line("END", None, 0).unwrap().rule_stack;
        grammar.tokenize_line("ccc", Some(end_state), 0).unwrap();

        let while_state = grammar.tokenize_line("WHILE", None, 0).unwrap().rule_stack;
        grammar.tokenize_line("bbb", Some(while_state), 0).unwrap();

        let warnings = grammar.backtracking_warnings();
        assert_eq!(warnings.len(), 3);
        assert!(warnings.iter().any(|warning| {
            warning.grammar_scope_name == "source.test"
                && warning.rule == "meta.begin-risky"
                && warning.pattern == "(a+)+$"
                && warning.rule_location.as_deref() == Some("begin.tmLanguage.json:7:2")
        }));
        assert!(warnings.iter().any(|warning| {
            warning.grammar_scope_name == "source.test"
                && warning.rule == "meta.end-risky"
                && warning.pattern == "(c+)+$"
                && warning.rule_location.as_deref() == Some("end.tmLanguage.json:12:5")
        }));
        assert!(warnings.iter().any(|warning| {
            warning.grammar_scope_name == "source.test"
                && warning.rule == "meta.while-risky"
                && warning.pattern == "(b+)+$"
                && warning.rule_location.as_deref() == Some("while.tmLanguage.json:18:3")
        }));
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

    #[test]
    fn combined_scan_matches_both_outputs_without_repeating_regex_searches() {
        use crate::regexp::SCANNER_CALL_COUNT;

        let root = raw_grammar(
            r##"{
            "scopeName": "source.test",
            "patterns": [
                { "begin": "^(>)", "while": "^(>)", "name": "markup.block",
                  "beginCaptures": { "1": { "name": "punctuation.begin" } },
                  "whileCaptures": { "1": { "name": "punctuation.while" } },
                  "patterns": [{ "begin": "(<)", "end": "(>)", "name": "meta.embedded",
                    "contentName": "source.embedded",
                    "beginCaptures": { "1": { "name": "punctuation.begin" } },
                    "endCaptures": { "1": { "name": "punctuation.end" } },
                    "patterns": [{ "include": "#captured" }] }] },
                { "include": "#captured" },
                { "begin": "\"", "end": "\"", "name": "string.quoted" }
            ],
            "repository": { "captured": { "match": "(x)(y)", "name": "outer.test",
                "captures": {
                    "1": { "name": "capture.test", "patterns": [{ "match": "x", "name": "inner.test" }] },
                    "2": { "name": "comment.test" }
                } } }
        }"##,
        );
        let mut store = GrammarStore::new();
        store.insert(raw_grammar(
            r#"{
            "scopeName": "source.injection", "injectionSelector": "L:source.test",
            "patterns": [{ "match": "!", "name": "injected.test" }]
        }"#,
        ));
        store.set_injections("source.test", vec!["source.injection".into()]);
        let raw_theme: RawTheme = serde_json::from_str(r##"{
            "settings": [
                { "settings": { "foreground": "#010203" } },
                { "scope": "inner, injected", "settings": { "foreground": "#aabbcc", "fontStyle": "bold", "fontFamily": "Test Mono", "fontSize": 1.2, "lineHeight": 1.5 } },
                { "scope": "comment", "settings": { "foreground": "#112233", "fontStyle": "italic" } }
            ]
        }"##).unwrap();
        let grammar = Grammar::new(
            &root,
            &store,
            Theme::create_from_raw_theme(Some(&raw_theme), None).unwrap(),
            GrammarConfiguration::default()
                .with_initial_language_id(7)
                .with_embedded_languages([("source.embedded".into(), 9)].into())
                .with_token_types(vec![("inner.test".into(), StandardTokenType::String)])
                .with_balanced_bracket_selectors(Some(vec!["source.embedded".into()]))
                .with_unbalanced_bracket_selectors(vec!["comment".into()]),
        );
        let mut scope_state = None;
        let mut binary_state = None;
        let mut combined_state = None;
        let mut font_runs = 0;
        for line in [
            "> <xy!😀א",
            "> xy!>",
            "xy\"open",
            "",
            "close\" xy",
            "💻xy",
            "!",
        ] {
            SCANNER_CALL_COUNT.with(|count| count.set(0));
            let scopes = grammar.tokenize_line(line, scope_state, 0).unwrap();
            let scope_calls = SCANNER_CALL_COUNT.with(std::cell::Cell::get);
            SCANNER_CALL_COUNT.with(|count| count.set(0));
            let binary = grammar.tokenize_line2(line, binary_state, 0).unwrap();
            let binary_calls = SCANNER_CALL_COUNT.with(std::cell::Cell::get);
            SCANNER_CALL_COUNT.with(|count| count.set(0));
            let combined = grammar
                .tokenize_line_with_scopes(line, combined_state, 0)
                .unwrap();
            let combined_calls = SCANNER_CALL_COUNT.with(std::cell::Cell::get);
            assert!(scope_calls > 0);
            assert_eq!(
                combined_calls, binary_calls,
                "{line:?}: duplicate binary scanner work"
            );
            assert_eq!(
                combined_calls, scope_calls,
                "{line:?}: duplicate scope scanner work"
            );
            assert_eq!(combined.tokens, scopes.tokens, "{line:?}");
            assert_eq!(combined.binary_tokens, binary.tokens, "{line:?}");
            assert_eq!(combined.fonts, scopes.fonts);
            assert_eq!(combined.fonts, binary.fonts);
            font_runs += combined.fonts.len();
            assert!(combined.rule_stack.equals(&scopes.rule_stack));
            assert!(combined.rule_stack.equals(&binary.rule_stack));
            assert!(!combined.stopped_early);
            scope_state = Some(scopes.rule_stack);
            binary_state = Some(binary.rule_stack);
            combined_state = Some(combined.rule_stack);
        }
        assert!(
            font_runs > 0,
            "font attributes must participate in the shared scan"
        );
    }
}
