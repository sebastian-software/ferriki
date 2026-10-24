/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::collections::HashSet;
use std::sync::{Arc, PoisonError, RwLock};

use serde::{Deserialize, Serialize};

use crate::BacktrackingWarning;
use crate::RegexError;

use crate::attributed_scope_stack::{AttributedScopeStack, ScopeAttributesProvider};
use crate::basic_scope_attributes::{
    BasicScopeAttributes, BasicScopeAttributesProvider, EmbeddedLanguages,
};
use crate::encoded_token_attributes::{EncodedTokenAttributes, FontAttribute, StandardTokenType};
use crate::grammar_fingerprint::GrammarFingerprint;
use crate::line_output::{
    BalancedBracketSelectors, FontInfo, LineFonts, LineTokens, Token, TokenTypeMatcher,
};
use crate::matcher::MatcherPriority;
use crate::raw_grammar::{RawGrammar, RuleId};
use crate::regexp::{OnigString, ScannerPatternCache, has_captures};
use crate::rule::{Rule, RuleRegistry};
use crate::rule_factory::{GrammarProvider, RuleFactory};
use crate::state_stack::StateStack;
use crate::theme::{ScopeStack, StyleAttributes, Theme};
use crate::tokenize_string::{Injection, TokenizeStringResult, TokenizerGrammar, tokenize_string};

#[derive(Clone)]
#[non_exhaustive]
pub struct GrammarConfiguration {
    pub initial_language_id: u32,
    pub embedded_languages: EmbeddedLanguages,
    pub token_types: Vec<(String, StandardTokenType)>,
    pub balanced_bracket_selectors: Option<Vec<String>>,
    pub unbalanced_bracket_selectors: Vec<String>,
    /// Enables the scanner prefilter. Defaults to `true`; prepared archives use
    /// Eager for static scanners, while source-only scanners retain Auto.
    /// Disable it to avoid prefilter construction for one-shot highlighting.
    pub regex_prefilter: bool,
}

impl Default for GrammarConfiguration {
    fn default() -> Self {
        Self {
            initial_language_id: 0,
            embedded_languages: EmbeddedLanguages::default(),
            token_types: Vec::new(),
            balanced_bracket_selectors: None,
            unbalanced_bracket_selectors: Vec::new(),
            regex_prefilter: true,
        }
    }
}

impl GrammarConfiguration {
    /// Controls prefiltering for all scanners in this grammar, including injections.
    #[must_use]
    pub fn with_regex_prefilter(mut self, enabled: bool) -> Self {
        self.regex_prefilter = enabled;
        self
    }

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
    grammar_fingerprint: GrammarFingerprint,
    registry: RuleRegistry,
    injections: Vec<Injection>,
    basic_scope_attributes: BasicScopeAttributesProvider,
    token_type_matchers: Vec<TokenTypeMatcher>,
    balanced_bracket_selectors: Option<BalancedBracketSelectors>,
    theme_provider: ThemeProvider,
}

const MAX_SERIALIZED_GRAMMAR_STATE_BYTES: usize = 1_048_576;
const MAX_SERIALIZED_GRAMMAR_STATE_DEPTH: usize = 2_048;
const MAX_SERIALIZED_GRAMMAR_STATE_SCOPES: usize = 4_096;
const MAX_SERIALIZED_DYNAMIC_PATTERN_BYTES: usize = 65_536;
const MAX_GRAMMAR_STATE_RULE_VALIDATION_WORK: usize = 100_000;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SerializedGrammarState {
    version: u8,
    grammar_fingerprint: String,
    root_scope: String,
    frames: Vec<SerializedStateStackFrame>,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SerializedStateStackFrame {
    rule_id: u32,
    begin_rule_captured_eol: bool,
    end_rule: Option<String>,
    name_scopes: Vec<Vec<String>>,
    content_name_scopes: Vec<Vec<String>>,
}

impl SerializedStateStackFrame {
    fn from_stack(stack: &Arc<StateStack>) -> Self {
        Self {
            rule_id: stack.rule_id().get(),
            begin_rule_captured_eol: stack.begin_rule_captured_eol,
            end_rule: stack.end_rule.clone(),
            name_scopes: scope_extension(
                stack.name_scopes_list.as_ref(),
                stack
                    .parent
                    .as_ref()
                    .and_then(|parent| parent.name_scopes_list.as_ref()),
            ),
            content_name_scopes: scope_extension(
                stack.content_name_scopes_list.as_ref(),
                stack.name_scopes_list.as_ref(),
            ),
        }
    }
}

fn scope_extension(
    stack: Option<&Arc<AttributedScopeStack>>,
    base: Option<&Arc<AttributedScopeStack>>,
) -> Vec<Vec<String>> {
    stack
        .and_then(|stack| stack.extension_if_defined(base))
        .unwrap_or_default()
        .into_iter()
        .map(|frame| frame.scope_names)
        .collect()
}

fn serialized_scope_count(frames: &[SerializedStateStackFrame]) -> usize {
    frames
        .iter()
        .map(|frame| frame.name_scopes.len() + frame.content_name_scopes.len())
        .sum()
}

fn validate_scope_extensions(extensions: &[Vec<String>]) -> Result<(), String> {
    for extension in extensions {
        if extension.len() != 1
            || extension.iter().any(|scope| {
                scope.is_empty() || scope.chars().any(char::is_whitespace) || scope.len() > 4_096
            })
        {
            return Err(invalid_serialized_state(
                "state contains an invalid scope extension",
            ));
        }
    }
    Ok(())
}

fn extend_scope_stack(
    base: Option<Arc<AttributedScopeStack>>,
    extensions: &[Vec<String>],
    provider: &impl ScopeAttributesProvider,
) -> Option<Arc<AttributedScopeStack>> {
    let mut current = base;
    for extension in extensions {
        let path = extension.join(" ");
        current = current.map(|scope| scope.push_attributed(Some(&path), provider));
    }
    current
}

fn invalid_serialized_state(reason: &str) -> String {
    format!("Invalid grammar state: {reason}")
}

/// Port of upstream `IThemeProvider`: grammars read the theme at tokenize
/// time instead of owning it. [`crate::SyncRegistry`] shares one provider
/// with every grammar it compiles, so replacing the theme keeps the compiled
/// rules and their regexes (upstream `SyncRegistry.setTheme`).
#[derive(Clone)]
pub(crate) struct ThemeProvider(Arc<RwLock<Arc<Theme>>>);

impl ThemeProvider {
    pub(crate) fn new(theme: Theme) -> Self {
        Self(Arc::new(RwLock::new(Arc::new(theme))))
    }

    pub(crate) fn set_theme(&self, theme: Theme) {
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(theme);
    }

    pub(crate) fn theme(&self) -> Arc<Theme> {
        Arc::clone(&self.0.read().unwrap_or_else(PoisonError::into_inner))
    }

    fn theme_match(&self, scope_path: &ScopeStack) -> Option<StyleAttributes> {
        self.0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .match_scope(Some(scope_path))
    }
}

impl Grammar {
    pub(crate) fn prepare_static_scanners(&self) -> Result<(), crate::RegexError> {
        // Only stack states, injection roots and capture-retokenization roots
        // become scanners. Ordinary match/include rules are flattened into their
        // parent's ordered list; preparing them separately serializes automata
        // the tokenizer can never request.
        let mut entries = HashSet::from([self.root_id]);
        entries.extend(self.injections.iter().map(|injection| injection.rule_id));
        for id in 1..=self.registry.len() {
            if let Some(Rule::Capture(rule)) = self.registry.try_get_rule(RuleId::new(id as u32)) {
                entries.extend(rule.retokenize_captured_with_rule_id);
            }
        }
        for id in 1..=self.registry.len() {
            if let Some(rule) = self.registry.try_get_rule(RuleId::new(id as u32))
                && (entries.contains(&rule.id())
                    || matches!(rule, Rule::BeginEnd(_) | Rule::BeginWhile(_)))
            {
                rule.prepare_static_scanners(&self.registry)?;
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn prefilter_stats(&self) -> Vec<ferroni::scanner::PrefilterStats> {
        (1..=self.registry.len())
            .filter_map(|id| self.registry.try_get_rule(RuleId::new(id as u32)))
            .flat_map(Rule::prefilter_stats)
            .collect()
    }

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
        Self::with_factory(
            grammar_provider,
            ThemeProvider::new(theme),
            configuration,
            RuleFactory::new(raw_grammar, grammar_provider),
        )
    }

    pub(crate) fn with_theme_provider(
        raw_grammar: &Arc<RawGrammar>,
        grammar_provider: &dyn GrammarProvider,
        theme_provider: ThemeProvider,
        configuration: GrammarConfiguration,
        scanner_pattern_cache: ScannerPatternCache,
    ) -> Self {
        Self::with_factory(
            grammar_provider,
            theme_provider,
            configuration,
            RuleFactory::with_pattern_cache(
                Arc::clone(raw_grammar),
                grammar_provider,
                scanner_pattern_cache,
            ),
        )
    }

    fn with_factory(
        grammar_provider: &dyn GrammarProvider,
        theme_provider: ThemeProvider,
        configuration: GrammarConfiguration,
        mut factory: RuleFactory<'_>,
    ) -> Self {
        let root_id = factory.compile_root();
        let root_grammar = Arc::clone(factory.root_grammar());
        let mut injections = Vec::new();

        for (selector, rule) in &root_grammar.injections {
            let rule_id = factory.compile_raw_rule(Arc::clone(rule));
            injections.extend(Injection::from_selector(selector, rule_id));
        }

        let external_injection_scopes = grammar_provider.injections(&root_grammar.scope_name);
        for injection_scope_name in &external_injection_scopes {
            let Some((injection_grammar, rule_id)) =
                factory.compile_external_grammar(injection_scope_name)
            else {
                continue;
            };
            if let Some(selector) = injection_grammar.injection_selector.as_deref() {
                injections.extend(Injection::from_selector(selector, rule_id));
            }
        }
        injections.sort_by_key(|injection| priority_order(injection.priority));

        let grammar_fingerprint = factory.grammar_fingerprint(external_injection_scopes);
        let (_, mut registry) = factory.into_parts();
        registry.regex_prefilter = configuration.regex_prefilter;
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
            grammar_fingerprint,
            registry,
            injections,
            basic_scope_attributes: BasicScopeAttributesProvider::new(
                configuration.initial_language_id,
                Some(&configuration.embedded_languages),
            ),
            token_type_matchers,
            balanced_bracket_selectors,
            theme_provider,
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
        self.theme_provider.theme().get_color_map()
    }

    /// Serializes a tokenizer stack for continuation across process boundaries.
    ///
    /// The versioned JSON contains grammar identity and scope/rule frames, but
    /// no theme attributes or full input text. Dynamic backreferences and
    /// captured scope names can retain the matched fragments needed to resume.
    /// A receiving grammar resolves attributes with its current theme. Pass
    /// `None` to serialize the initial
    /// root stack. Snapshots are limited to 1 MiB and 2,048 stack frames.
    pub fn serialize_state_stack(&self, state: Option<&Arc<StateStack>>) -> Result<String, String> {
        let state = state.cloned().unwrap_or_else(|| self.initial_state());
        if state.depth > MAX_SERIALIZED_GRAMMAR_STATE_DEPTH {
            return Err(invalid_serialized_state("state stack is too deep"));
        }
        let mut stacks = Vec::with_capacity(state.depth);
        let mut current = Some(state);
        while let Some(stack) = current {
            stacks.push(stack);
            current = stacks.last().and_then(|stack| stack.parent.clone());
        }
        stacks.reverse();
        let frames: Vec<_> = stacks
            .iter()
            .map(SerializedStateStackFrame::from_stack)
            .collect();
        if serialized_scope_count(&frames) > MAX_SERIALIZED_GRAMMAR_STATE_SCOPES {
            return Err(invalid_serialized_state("state contains too many scopes"));
        }
        let mut validation_work = 0;
        for (index, frame) in frames.iter().enumerate().skip(1) {
            validate_serialized_frame(frame, &frames[index - 1], self, &mut validation_work)?;
        }
        let initial_state = self.initial_state();
        if frames.first() != Some(&SerializedStateStackFrame::from_stack(&initial_state)) {
            return Err(invalid_serialized_state(
                "state stack belongs to a different grammar",
            ));
        }
        let value = SerializedGrammarState {
            version: 1,
            grammar_fingerprint: self.grammar_fingerprint.get().to_owned(),
            root_scope: self.root_scope_name.clone(),
            frames,
        };
        let serialized = serde_json::to_string(&value)
            .map_err(|error| invalid_serialized_state(&error.to_string()))?;
        if serialized.len() > MAX_SERIALIZED_GRAMMAR_STATE_BYTES {
            return Err(invalid_serialized_state("serialized state is too large"));
        }
        Ok(serialized)
    }

    /// Reconstructs a tokenizer stack produced by [`Self::serialize_state_stack`].
    ///
    /// Returns an error for invalid JSON, unsupported versions, a different
    /// compiled grammar, invalid rule/scope frames, or snapshots beyond the
    /// serialization limits.
    pub fn deserialize_state_stack(&self, serialized: &str) -> Result<Arc<StateStack>, String> {
        if serialized.len() > MAX_SERIALIZED_GRAMMAR_STATE_BYTES {
            return Err(invalid_serialized_state("serialized state is too large"));
        }
        let value: SerializedGrammarState = serde_json::from_str(serialized)
            .map_err(|error| invalid_serialized_state(&error.to_string()))?;
        if value.version != 1
            || value.grammar_fingerprint != self.grammar_fingerprint.get()
            || value.root_scope != self.root_scope_name
            || value.frames.is_empty()
            || value.frames.len() > MAX_SERIALIZED_GRAMMAR_STATE_DEPTH
        {
            return Err(invalid_serialized_state(
                "state version, grammar, or root scope does not match",
            ));
        }

        if serialized_scope_count(&value.frames) > MAX_SERIALIZED_GRAMMAR_STATE_SCOPES {
            return Err(invalid_serialized_state("state contains too many scopes"));
        }

        let mut state = self.initial_state();
        if value.frames.first() != Some(&SerializedStateStackFrame::from_stack(&state)) {
            return Err(invalid_serialized_state("root stack frame is invalid"));
        }
        let mut validation_work = 0;
        for (index, frame) in value.frames.iter().enumerate().skip(1) {
            let rule_id = RuleId::new(frame.rule_id);
            validate_serialized_frame(frame, &value.frames[index - 1], self, &mut validation_work)?;
            let name_scopes_list =
                extend_scope_stack(state.name_scopes_list.clone(), &frame.name_scopes, self);
            let content_name_scopes_list =
                extend_scope_stack(name_scopes_list.clone(), &frame.content_name_scopes, self);
            state = StateStack::new(
                Some(state),
                rule_id,
                -1,
                -1,
                frame.begin_rule_captured_eol,
                frame.end_rule.clone(),
                name_scopes_list,
                content_name_scopes_list,
            );
        }
        Ok(state)
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
        let theme = self.theme_provider.theme();
        let default_style = theme.get_defaults();
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

fn validate_serialized_frame(
    frame: &SerializedStateStackFrame,
    parent_frame: &SerializedStateStackFrame,
    grammar: &Grammar,
    validation_work: &mut usize,
) -> Result<(), String> {
    validate_scope_extensions(&frame.name_scopes)?;
    validate_scope_extensions(&frame.content_name_scopes)?;
    if frame
        .end_rule
        .as_ref()
        .is_some_and(|end_rule| end_rule.len() > MAX_SERIALIZED_DYNAMIC_PATTERN_BYTES)
    {
        return Err(invalid_serialized_state(
            "dynamic rule pattern exceeds the size limit",
        ));
    }

    let rule_id = RuleId::new(frame.rule_id);
    let rule = grammar
        .registry
        .try_get_rule(rule_id)
        .ok_or_else(|| invalid_serialized_state("state references an unknown rule"))?;
    if !is_valid_stack_child(parent_frame.rule_id, rule_id, grammar, validation_work)? {
        return Err(invalid_serialized_state(
            "state contains an invalid parent/child rule relationship",
        ));
    }
    match rule {
        Rule::BeginEnd(begin_end) => {
            if frame.end_rule.is_some() != begin_end.end_has_back_references {
                return Err(invalid_serialized_state(
                    "state dynamic pattern does not match its grammar rule",
                ));
            }
            if let Some(end_rule) = frame.end_rule.as_deref()
                && !begin_end.has_valid_resolved_end_pattern(end_rule, validation_work)
            {
                return Err(invalid_serialized_state(
                    "state dynamic pattern is not an escaped grammar backreference expansion",
                ));
            }
        }
        Rule::BeginWhile(begin_while) => {
            if frame.end_rule.is_some() != begin_while.while_has_back_references {
                return Err(invalid_serialized_state(
                    "state dynamic pattern does not match its grammar rule",
                ));
            }
            if let Some(end_rule) = frame.end_rule.as_deref()
                && !begin_while.has_valid_resolved_while_pattern(end_rule, validation_work)
            {
                return Err(invalid_serialized_state(
                    "state dynamic pattern is not an escaped grammar backreference expansion",
                ));
            }
        }
        Rule::Capture(_) | Rule::Match(_) | Rule::IncludeOnly(_) => {
            return Err(invalid_serialized_state(
                "state references a rule that cannot remain on the tokenizer stack",
            ));
        }
    }

    validate_static_scope_extensions(rule, frame, parent_frame)?;
    Ok(())
}

fn validate_static_scope_extensions(
    rule: &Rule,
    frame: &SerializedStateStackFrame,
    parent_frame: &SerializedStateStackFrame,
) -> Result<(), String> {
    let name = rule.get_name(None, None);
    let mut inherited_name_scopes = scope_names(&parent_frame.content_name_scopes);
    if let Some(expected) = static_scope_names(name) {
        inherited_name_scopes.extend(expected);
        if scope_names(&frame.name_scopes) != inherited_name_scopes {
            return Err(invalid_serialized_state(
                "state name scopes do not match the grammar rule",
            ));
        }
    } else if !scope_names(&frame.name_scopes).starts_with(&inherited_name_scopes) {
        return Err(invalid_serialized_state(
            "state name scopes do not extend the parent content scopes",
        ));
    }

    let content_name = rule.get_content_name("", &[]);
    if let Some(expected) = static_scope_names(content_name)
        && scope_names(&frame.content_name_scopes) != expected
    {
        return Err(invalid_serialized_state(
            "state content scopes do not match the grammar rule",
        ));
    }
    Ok(())
}

fn static_scope_names(name: Option<String>) -> Option<Vec<String>> {
    let Some(name) = name else {
        return Some(Vec::new());
    };
    if has_captures(Some(&name)) {
        None
    } else {
        Some(name.split(' ').map(str::to_owned).collect())
    }
}

fn scope_names(extensions: &[Vec<String>]) -> Vec<String> {
    extensions
        .iter()
        .filter_map(|extension| extension.first().cloned())
        .collect()
}

fn is_valid_stack_child(
    parent_rule_id: u32,
    child_rule_id: RuleId,
    grammar: &Grammar,
    validation_work: &mut usize,
) -> Result<bool, String> {
    let mut visited = HashSet::new();
    if rule_patterns_reach(
        parent_rule_id,
        child_rule_id,
        &grammar.registry,
        &mut visited,
        validation_work,
    )? {
        return Ok(true);
    }
    for injection in &grammar.injections {
        let mut visited = HashSet::new();
        if rule_patterns_reach(
            injection.rule_id.get(),
            child_rule_id,
            &grammar.registry,
            &mut visited,
            validation_work,
        )? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn rule_patterns_reach(
    parent_rule_id: u32,
    child_rule_id: RuleId,
    registry: &RuleRegistry,
    visited: &mut HashSet<u32>,
    validation_work: &mut usize,
) -> Result<bool, String> {
    *validation_work += 1;
    if *validation_work > MAX_GRAMMAR_STATE_RULE_VALIDATION_WORK {
        return Err(invalid_serialized_state(
            "state validation exceeded its work limit",
        ));
    }
    let Some(parent) = registry.try_get_rule(RuleId::new(parent_rule_id)) else {
        return Ok(false);
    };
    let patterns = match parent {
        Rule::IncludeOnly(rule) => &rule.patterns,
        Rule::BeginEnd(rule) => &rule.patterns,
        Rule::BeginWhile(rule) => &rule.patterns,
        Rule::Capture(_) | Rule::Match(_) => return Ok(false),
    };
    for pattern_id in patterns {
        *validation_work += 1;
        if *validation_work > MAX_GRAMMAR_STATE_RULE_VALIDATION_WORK {
            return Err(invalid_serialized_state(
                "state validation exceeded its work limit",
            ));
        }
        if *pattern_id == child_rule_id {
            return Ok(true);
        }
        if !visited.insert(pattern_id.get()) {
            continue;
        }
        if registry
            .try_get_rule(*pattern_id)
            .is_some_and(|rule| rule.as_include_only().is_some())
            && rule_patterns_reach(
                pattern_id.get(),
                child_rule_id,
                registry,
                visited,
                validation_work,
            )?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

impl ScopeAttributesProvider for Grammar {
    fn metadata_for_scope(&self, scope_name: &str) -> BasicScopeAttributes {
        self.basic_scope_attributes
            .basic_scope_attributes(Some(scope_name))
    }

    fn theme_match(&self, scope_path: &ScopeStack) -> Option<StyleAttributes> {
        self.theme_provider.theme_match(scope_path)
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
    use super::{
        Grammar, GrammarConfiguration, MAX_SERIALIZED_DYNAMIC_PATTERN_BYTES,
        MAX_SERIALIZED_GRAMMAR_STATE_SCOPES,
    };
    use crate::raw_grammar::RuleId;
    use crate::rule::Rule;
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

    fn find_rule_id(grammar: &Grammar, predicate: impl Fn(&Rule) -> bool) -> u32 {
        (1..=grammar.registry.len() as u32)
            .find(|id| {
                grammar
                    .registry
                    .try_get_rule(RuleId::new(*id))
                    .is_some_and(&predicate)
            })
            .expect("the test grammar should contain the requested rule kind")
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
    fn serializes_and_restores_state_across_grammar_instances() {
        let raw = raw_grammar(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "\"",
                    "end": "\"",
                    "name": "string.quoted.test"
                }]
            }"#,
        );
        let store = GrammarStore::new();
        let grammar = Grammar::new(
            &raw,
            &store,
            default_theme(),
            GrammarConfiguration::default(),
        );
        let first = grammar.tokenize_line2("\"open", None, 0).unwrap();
        let serialized = grammar
            .serialize_state_stack(Some(&first.rule_stack))
            .unwrap();
        let serialized =
            serde_json::to_string(&serde_json::from_str::<serde_json::Value>(&serialized).unwrap())
                .unwrap();

        let fresh_grammar = Grammar::new(
            &raw,
            &store,
            default_theme(),
            GrammarConfiguration::default(),
        );
        let restored = fresh_grammar.deserialize_state_stack(&serialized).unwrap();
        let continued = fresh_grammar
            .tokenize_line2("close\"", Some(restored), 0)
            .unwrap();
        let uninterrupted = grammar
            .tokenize_line2("close\"", Some(first.rule_stack), 0)
            .unwrap();

        assert_eq!(continued.tokens, uninterrupted.tokens);
        assert!(continued.rule_stack.equals(&uninterrupted.rule_stack));

        let mut wrong_grammar = serde_json::from_str::<serde_json::Value>(&serialized).unwrap();
        wrong_grammar["grammarFingerprint"] = serde_json::Value::String("wrong".into());
        assert!(
            fresh_grammar
                .deserialize_state_stack(&wrong_grammar.to_string())
                .is_err()
        );

        let unnamed = raw_grammar(
            r#"{
                "scopeName": "source.unnamed",
                "patterns": [{ "begin": "O", "end": "E" }]
            }"#,
        );
        let unnamed_grammar = Grammar::new(
            &unnamed,
            &store,
            default_theme(),
            GrammarConfiguration::default(),
        );
        let unnamed_state = unnamed_grammar.tokenize_line("O", None, 0).unwrap();
        let unnamed_json = unnamed_grammar
            .serialize_state_stack(Some(&unnamed_state.rule_stack))
            .unwrap();
        assert!(
            unnamed_grammar
                .deserialize_state_stack(&unnamed_json)
                .is_ok()
        );
    }

    #[test]
    fn rejects_forged_rule_kinds_dynamic_patterns_and_scope_extensions() {
        let raw = raw_grammar(
            r##"{
                "scopeName": "source.test",
                "patterns": [
                    {
                        "begin": "\\\"",
                        "end": "\\\"",
                        "name": "string.quoted",
                        "contentName": "string.content",
                        "beginCaptures": { "0": { "name": "punctuation.begin" } }
                    },
                    { "match": "x", "name": "word" },
                    { "include": "#container" }
                ],
                "repository": { "container": { "patterns": [{ "match": "y" }] } }
            }"##,
        );
        let grammar = Grammar::new(
            &raw,
            &GrammarStore::new(),
            default_theme(),
            GrammarConfiguration::default(),
        );
        let open = grammar.tokenize_line("\"open", None, 0).unwrap();
        let serialized = grammar
            .serialize_state_stack(Some(&open.rule_stack))
            .unwrap();
        let valid: serde_json::Value = serde_json::from_str(&serialized).unwrap();

        let non_stack_rule_ids = [
            find_rule_id(&grammar, |rule| rule.as_match().is_some()),
            find_rule_id(&grammar, |rule| rule.as_capture().is_some()),
            find_rule_id(&grammar, |rule| rule.as_include_only().is_some()),
        ];
        for rule_id in non_stack_rule_ids {
            let mut forged = valid.clone();
            forged["frames"][1]["ruleId"] = serde_json::Value::from(rule_id);
            assert!(
                grammar
                    .deserialize_state_stack(&forged.to_string())
                    .err()
                    .expect("forged rule ID should be rejected")
                    .starts_with("Invalid grammar state:"),
                "rule ID {rule_id} must not be accepted as a stack frame"
            );
        }

        let mut forged = valid.clone();
        forged["frames"][1]["endRule"] = serde_json::Value::String("attacker.*".into());
        assert!(
            grammar
                .deserialize_state_stack(&forged.to_string())
                .is_err()
        );

        let mut forged = valid.clone();
        forged["frames"][1]["nameScopes"] = serde_json::json!([["forged.scope"]]);
        assert!(
            grammar
                .deserialize_state_stack(&forged.to_string())
                .is_err()
        );

        let mut forged = valid.clone();
        forged["frames"][1]["contentNameScopes"] = serde_json::json!([["forged.scope"]]);
        assert!(
            grammar
                .deserialize_state_stack(&forged.to_string())
                .is_err()
        );

        let mut forged = valid.clone();
        forged["frames"][1]["nameScopes"] = serde_json::json!([["string", "quoted"]]);
        assert!(
            grammar
                .deserialize_state_stack(&forged.to_string())
                .is_err()
        );

        let mut forged = valid;
        forged["frames"][1]["nameScopes"] = serde_json::Value::Array(
            (0..=MAX_SERIALIZED_GRAMMAR_STATE_SCOPES)
                .map(|_| serde_json::json!(["scope"]))
                .collect(),
        );
        assert!(
            grammar
                .deserialize_state_stack(&forged.to_string())
                .is_err()
        );
    }

    #[test]
    fn rejects_a_valid_rule_id_in_an_invalid_parent_child_position() {
        let raw = raw_grammar(
            r##"{
                "scopeName": "source.test",
                "patterns": [
                    {
                        "begin": "O", "end": "E", "name": "outer",
                        "contentName": "outer.content",
                        "patterns": [{ "begin": "I", "end": "J", "name": "inner" }]
                    },
                    { "begin": "S", "end": "T", "name": "sibling" }
                ]
            }"##,
        );
        let grammar = Grammar::new(
            &raw,
            &GrammarStore::new(),
            default_theme(),
            GrammarConfiguration::default(),
        );
        let nested = grammar.tokenize_line("OI", None, 0).unwrap();
        assert_eq!(nested.rule_stack.depth, 3);
        let sibling = grammar.tokenize_line("S", None, 0).unwrap();
        let nested_state: serde_json::Value = serde_json::from_str(
            &grammar
                .serialize_state_stack(Some(&nested.rule_stack))
                .unwrap(),
        )
        .unwrap();
        assert!(
            grammar
                .deserialize_state_stack(&nested_state.to_string())
                .is_ok()
        );
        let sibling_state: serde_json::Value = serde_json::from_str(
            &grammar
                .serialize_state_stack(Some(&sibling.rule_stack))
                .unwrap(),
        )
        .unwrap();
        let sibling_rule_id = sibling_state["frames"][1]["ruleId"].as_u64().unwrap();
        let mut forged = nested_state;
        forged["frames"][2]["ruleId"] = serde_json::Value::from(sibling_rule_id);

        let error = grammar
            .deserialize_state_stack(&forged.to_string())
            .err()
            .expect("invalid parent/child rule relationship should be rejected");
        assert!(error.contains("parent/child rule relationship"));
    }

    #[test]
    fn rejects_forged_and_oversized_dynamic_backreference_patterns() {
        let raw = raw_grammar(
            r##"{
                "scopeName": "source.test",
                "patterns": [{ "begin": "([a]+)", "end": "\\1", "name": "string.test" }]
            }"##,
        );
        let grammar = Grammar::new(
            &raw,
            &GrammarStore::new(),
            default_theme(),
            GrammarConfiguration::default(),
        );
        let open = grammar.tokenize_line("aaa", None, 0).unwrap();
        let serialized = grammar
            .serialize_state_stack(Some(&open.rule_stack))
            .unwrap();
        let valid: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert!(grammar.deserialize_state_stack(&serialized).is_ok());

        let mut forged = valid.clone();
        forged["frames"][1]["endRule"] = serde_json::Value::String("a.*".into());
        assert!(
            grammar
                .deserialize_state_stack(&forged.to_string())
                .is_err()
        );

        let mut forged = valid;
        forged["frames"][1]["endRule"] =
            serde_json::Value::String("a".repeat(MAX_SERIALIZED_DYNAMIC_PATTERN_BYTES + 1));
        assert!(
            grammar
                .deserialize_state_stack(&forged.to_string())
                .is_err()
        );
    }

    #[test]
    fn applies_one_cumulative_backreference_validation_budget_to_all_frames() {
        let raw = raw_grammar(
            r##"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "(.+)", "end": "\\1", "name": "string.test",
                    "patterns": [{ "include": "$self" }]
                }]
            }"##,
        );
        let grammar = Grammar::new(
            &raw,
            &GrammarStore::new(),
            default_theme(),
            GrammarConfiguration::default(),
        );
        let open = grammar.tokenize_line(&"a".repeat(15_000), None, 0).unwrap();
        let serialized = grammar
            .serialize_state_stack(Some(&open.rule_stack))
            .unwrap();
        let mut forged: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        let frame = forged["frames"][1].clone();
        for _ in 0..8 {
            forged["frames"].as_array_mut().unwrap().push(frame.clone());
        }

        let error = grammar
            .deserialize_state_stack(&forged.to_string())
            .err()
            .expect("unbounded repeated backreference validation should be rejected");
        assert!(error.starts_with("Invalid grammar state:"));
    }

    #[test]
    fn fingerprints_ignore_locations_but_include_ordered_external_injections() {
        let located = raw_grammar(
            r##"{
                "scopeName": "source.test",
                "$vscodeTextmateLocation": { "filename": "/one/source.tmLanguage.json", "line": 1, "char": 0 },
                "patterns": [{
                    "begin": "\\\"", "end": "\\\"", "name": "string.test",
                    "$vscodeTextmateLocation": { "filename": "/one/rule.tmLanguage.json", "line": 2, "char": 3 }
                }]
            }"##,
        );
        let relocated = raw_grammar(
            r##"{
                "scopeName": "source.test",
                "$vscodeTextmateLocation": { "filename": "/two/source.tmLanguage.json", "line": 99, "char": 8 },
                "patterns": [{
                    "begin": "\\\"", "end": "\\\"", "name": "string.test",
                    "$vscodeTextmateLocation": { "filename": "/two/rule.tmLanguage.json", "line": 99, "char": 8 }
                }]
            }"##,
        );
        let empty_store = GrammarStore::new();
        let first = Grammar::new(
            &located,
            &empty_store,
            default_theme(),
            GrammarConfiguration::default(),
        );
        let second = Grammar::new(
            &relocated,
            &empty_store,
            default_theme(),
            GrammarConfiguration::default(),
        );
        let open = first.tokenize_line("\"open", None, 0).unwrap();
        let portable = first.serialize_state_stack(Some(&open.rule_stack)).unwrap();
        assert!(second.deserialize_state_stack(&portable).is_ok());

        let root = raw_grammar(r##"{ "scopeName": "source.injected-test", "patterns": [] }"##);
        let injection_a = raw_grammar(
            r##"{
                "scopeName": "source.inject-a", "injectionSelector": "L:source.injected-test",
                "patterns": [{ "begin": "A", "end": "a", "name": "injected.a" }]
            }"##,
        );
        let injection_b = raw_grammar(
            r##"{
                "scopeName": "source.inject-b", "injectionSelector": "L:source.injected-test",
                "patterns": [{ "begin": "B", "end": "b", "name": "injected.b" }]
            }"##,
        );
        let mut store_ab = GrammarStore::new();
        store_ab.insert(injection_a.clone());
        store_ab.insert(injection_b.clone());
        store_ab.set_injections(
            "source.injected-test",
            vec!["source.inject-a".into(), "source.inject-b".into()],
        );
        let mut store_ba = GrammarStore::new();
        store_ba.insert(injection_a);
        store_ba.insert(injection_b);
        store_ba.set_injections(
            "source.injected-test",
            vec!["source.inject-b".into(), "source.inject-a".into()],
        );
        let grammar_ab = Grammar::new(
            &root,
            &store_ab,
            default_theme(),
            GrammarConfiguration::default(),
        );
        let grammar_ba = Grammar::new(
            &root,
            &store_ba,
            default_theme(),
            GrammarConfiguration::default(),
        );
        let state = grammar_ab.serialize_state_stack(None).unwrap();
        assert!(grammar_ba.deserialize_state_stack(&state).is_err());
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
