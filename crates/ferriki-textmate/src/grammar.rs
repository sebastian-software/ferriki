/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError, RwLock};

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
    BalancedBracketSelectors, FontInfo, LineFonts, LineTokens, MultiThemeAncestry, Token,
    TokenTypeMatcher,
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
    /// Source Auto/Eager/Off, or optional prepared groups (the default).
    pub regex_mode: crate::RegexMode,
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
            regex_mode: crate::RegexMode::default(),
        }
    }
}

impl GrammarConfiguration {
    /// Selects a regex policy. The last regex policy setter wins.
    #[must_use]
    pub fn with_regex_mode(mut self, mode: crate::RegexMode) -> Self {
        self.regex_mode = mode;
        self.regex_prefilter = mode.prefilter();
        self
    }

    /// Controls prefiltering for all scanners in this grammar, including injections.
    #[must_use]
    pub fn with_regex_prefilter(mut self, enabled: bool) -> Self {
        self.regex_prefilter = enabled;
        self.regex_mode = crate::RegexMode::from_prefilter(enabled);
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

/// Binary token outputs for multiple compiled themes produced by a single grammar scan.
///
/// Each entry in `binary_tokens` corresponds to the theme at the same index in
/// the caller's slice and matches [`Grammar::tokenize_line2`] for that theme,
/// including theme-specific token merging and RTL boundaries.
#[derive(Clone)]
#[non_exhaustive]
pub struct TokenizeLineResultWithThemes {
    /// Unmerged grammar tokens with scope paths when requested by the caller.
    pub tokens: Option<Vec<Token>>,
    /// One alternating UTF-16 start-offset and encoded-metadata vector per theme.
    pub binary_tokens: Vec<Vec<u32>>,
    pub rule_stack: Arc<StateStack>,
    pub stopped_early: bool,
}

impl std::fmt::Debug for TokenizeLineResultWithThemes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenizeLineResultWithThemes")
            .field("tokens_len", &self.tokens.as_ref().map(Vec::len))
            .field("theme_count", &self.binary_tokens.len())
            .field(
                "binary_token_entries",
                &self.binary_tokens.iter().map(Vec::len).sum::<usize>(),
            )
            .field("rule_stack_depth", &self.rule_stack.depth)
            .field("stopped_early", &self.stopped_early)
            .finish()
    }
}

impl PartialEq for TokenizeLineResultWithThemes {
    fn eq(&self, other: &Self) -> bool {
        self.tokens == other.tokens
            && self.binary_tokens == other.binary_tokens
            && self.rule_stack.equals(&other.rule_stack)
            && self.stopped_early == other.stopped_early
    }
}

enum TokenOutput<'a> {
    Scopes,
    Binary,
    Both,
    MultiTheme {
        themes: &'a [Arc<Theme>],
        include_scopes: bool,
        pinned_theme: &'a Arc<Theme>,
        cached_ancestry: Option<MultiThemeAncestry>,
    },
}

struct PinnedThemeGrammar<'a> {
    grammar: &'a Grammar,
    theme: &'a Theme,
}

impl ScopeAttributesProvider for PinnedThemeGrammar<'_> {
    fn metadata_for_scope(&self, scope_name: &str) -> BasicScopeAttributes {
        self.grammar.metadata_for_scope(scope_name)
    }

    fn theme_match(&self, scope_path: &ScopeStack) -> Option<StyleAttributes> {
        self.theme.match_scope(Some(scope_path))
    }
}

impl TokenizerGrammar for PinnedThemeGrammar<'_> {
    fn rule_registry(&self) -> &RuleRegistry {
        &self.grammar.registry
    }

    fn injections(&self) -> &[Injection] {
        &self.grammar.injections
    }

    fn theme_id(&self) -> u64 {
        self.theme.id()
    }
}

pub struct Grammar {
    root_id: RuleId,
    root_scope_name: String,
    grammar_fingerprint: GrammarFingerprint,
    registry: RuleRegistry,
    injections: Vec<Injection>,
    basic_scope_attributes: Arc<BasicScopeAttributesProvider>,
    token_type_matchers: Vec<TokenTypeMatcher>,
    balanced_bracket_selectors: Option<BalancedBracketSelectors>,
    theme_provider: ThemeProvider,
    multi_theme_cache: Mutex<Option<MultiThemeAncestry>>,
    #[cfg(test)]
    last_walk_stats: Mutex<Option<crate::line_output::MultiThemeWalkStats>>,
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
        self.set_compiled_theme(Arc::new(theme));
    }

    pub(crate) fn set_compiled_theme(&self, theme: Arc<Theme>) {
        let previous = std::mem::replace(
            &mut *self.0.write().unwrap_or_else(PoisonError::into_inner),
            theme,
        );
        drop(previous);
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
        self.prepare_static_scanners_for(None)
    }

    pub(crate) fn prepare_owned_static_scanners(&self) -> Result<(), crate::RegexError> {
        self.prepare_static_scanners_for(Some(&self.root_scope_name))
    }

    fn prepare_static_scanners_for(&self, owner: Option<&str>) -> Result<(), crate::RegexError> {
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
                && owner.is_none_or(|owner| rule.source_scope_name() == owner)
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

    /// Compiles a grammar directly, returning an error if any scope selector is
    /// invalid. Applications obtain grammars from
    /// [`crate::SyncRegistry::grammar_for_scope_name`].
    #[doc(hidden)]
    pub fn new(
        raw_grammar: &RawGrammar,
        grammar_provider: &dyn GrammarProvider,
        theme: Theme,
        configuration: GrammarConfiguration,
    ) -> Result<Self, crate::ThemeError> {
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
    ) -> Result<Self, crate::ThemeError> {
        let scanner_pattern_cache = scanner_pattern_cache.with_mode(configuration.regex_mode);
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
    ) -> Result<Self, crate::ThemeError> {
        let invalid_selector = |error: crate::matcher::MatcherError| {
            crate::ThemeError::InvalidScopeSelector(error.to_string())
        };
        let root_id = factory.compile_root();
        let root_grammar = Arc::clone(factory.root_grammar());
        if let Some(selector) = root_grammar.injection_selector.as_deref() {
            crate::matcher::create_matchers(selector).map_err(invalid_selector)?;
        }
        let mut injections = Vec::new();

        for (selector, rule) in &root_grammar.injections {
            let rule_id = factory.compile_raw_rule(Arc::clone(rule));
            injections
                .extend(Injection::from_selector(selector, rule_id).map_err(invalid_selector)?);
        }

        let external_injection_scopes = grammar_provider.injections(&root_grammar.scope_name);
        for injection_scope_name in &external_injection_scopes {
            let Some((injection_grammar, rule_id)) =
                factory.compile_external_grammar(injection_scope_name)
            else {
                continue;
            };
            if let Some(selector) = injection_grammar.injection_selector.as_deref() {
                injections
                    .extend(Injection::from_selector(selector, rule_id).map_err(invalid_selector)?);
            }
        }
        injections.sort_by_key(|injection| priority_order(injection.priority));

        let grammar_fingerprint = factory.grammar_fingerprint(external_injection_scopes);
        let (_, mut registry) = factory.into_parts();
        registry.regex_prefilter = configuration.regex_prefilter;
        let mut token_type_matchers = Vec::new();
        for (selector, token_type) in &configuration.token_types {
            token_type_matchers.extend(
                TokenTypeMatcher::from_selector(selector, *token_type).map_err(invalid_selector)?,
            );
        }
        let balanced_bracket_selectors = configuration
            .balanced_bracket_selectors
            .as_ref()
            .map(|balanced| {
                BalancedBracketSelectors::new(balanced, &configuration.unbalanced_bracket_selectors)
            })
            .transpose()
            .map_err(invalid_selector)?;

        let basic_scope_attributes = Arc::new(BasicScopeAttributesProvider::try_new(
            configuration.initial_language_id,
            Some(&configuration.embedded_languages),
        )?);

        Ok(Self {
            root_id,
            root_scope_name: root_grammar.scope_name.clone(),
            grammar_fingerprint,
            registry,
            injections,
            basic_scope_attributes,
            token_type_matchers,
            balanced_bracket_selectors,
            theme_provider,
            multi_theme_cache: Mutex::new(None),
            #[cfg(test)]
            last_walk_stats: Mutex::new(None),
        })
    }

    /// Ferriki extension: compiles the scanners of every rule this grammar
    /// can reach, in every `\A`/`\G` variant, without tokenizing. Use it
    /// before [`SyncRegistry::export_precompiled_patterns`] so an archive
    /// covers the whole grammar rather than the input seen so far.
    ///
    /// Lists that end or continue with a pattern resolved from begin captures
    /// are skipped: they bypass the shared cache and are rebuilt per match.
    /// Every other list is attempted even after a failure; the first regex
    /// error is returned. Backtracking warnings of the compiled scanners are
    /// recorded as tokenization would record them.
    ///
    /// [`SyncRegistry::export_precompiled_patterns`]: crate::SyncRegistry::export_precompiled_patterns
    pub fn compile_all_scanners(&self) -> Result<(), RegexError> {
        let mut first_error = None;
        for rule in self.registry.rules() {
            if matches!(rule, Rule::Capture(_))
                || matches!(rule, Rule::BeginEnd(begin_end) if begin_end.end_has_back_references)
            {
                continue;
            }
            for (allow_a, allow_g) in [(true, true), (true, false), (false, true), (false, false)] {
                if let Err(error) = rule.compile_ag(&self.registry, None, allow_a, allow_g) {
                    first_error.get_or_insert(error);
                }
                if let Rule::BeginWhile(begin_while) = rule
                    && !begin_while.while_has_back_references
                    && let Err(error) = begin_while.compile_while_ag_and_record(
                        &self.registry,
                        None,
                        allow_a,
                        allow_g,
                    )
                {
                    first_error.get_or_insert(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
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

        let theme = self.theme_provider.theme();
        let pinned = PinnedThemeGrammar {
            grammar: self,
            theme: &theme,
        };
        let mut state = self.initial_state_with_theme(&theme);
        if value.frames.first() != Some(&SerializedStateStackFrame::from_stack(&state)) {
            return Err(invalid_serialized_state("root stack frame is invalid"));
        }
        let mut validation_work = 0;
        for (index, frame) in value.frames.iter().enumerate().skip(1) {
            let rule_id = RuleId::new(frame.rule_id);
            validate_serialized_frame(frame, &value.frames[index - 1], self, &mut validation_work)?;
            let name_scopes_list =
                extend_scope_stack(state.name_scopes_list.clone(), &frame.name_scopes, &pinned);
            let content_name_scopes_list = extend_scope_stack(
                name_scopes_list.clone(),
                &frame.content_name_scopes,
                &pinned,
            );
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

    /// Tokenizes one source line and returns scope tokens and the next rule stack.
    ///
    /// Returns [`RegexError`] if a regex fails to compile or if a runtime safety
    /// bound is exceeded (scanner include-expansion budget, grammar state stack
    /// depth, or capture retokenization recursion depth).
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

    /// Tokenizes one source line into compact binary token metadata and the next rule stack.
    ///
    /// Returns [`RegexError`] if a regex fails to compile or if a runtime safety
    /// bound is exceeded (scanner include-expansion budget, grammar state stack
    /// depth, or capture retokenization recursion depth).
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
    ///
    /// Returns [`RegexError`] if a regex fails to compile or if a runtime safety
    /// bound is exceeded (scanner include-expansion budget, grammar state stack
    /// depth, or capture retokenization recursion depth).
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

    #[cfg(test)]
    pub(crate) fn last_multi_theme_walk_stats(
        &self,
    ) -> Option<crate::line_output::MultiThemeWalkStats> {
        *self
            .last_walk_stats
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(test)]
    pub(crate) fn last_multi_theme_cached_nodes(&self) -> usize {
        self.multi_theme_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map_or(0, MultiThemeAncestry::cached_node_count)
    }

    /// Tokenizes one source line once and encodes binary token metadata for each
    /// supplied compiled [`Theme`], optionally collecting unmerged scope tokens.
    ///
    /// The time limit and returned continuation state belong to this single scan.
    ///
    /// Returns [`RegexError`] if a regex fails to compile or if a runtime safety
    /// bound is exceeded (scanner include-expansion budget, grammar state stack
    /// depth, or capture retokenization recursion depth).
    pub fn tokenize_line_with_themes(
        &self,
        line_text: &str,
        previous_state: Option<Arc<StateStack>>,
        themes: &[Arc<Theme>],
        include_scopes: bool,
        time_limit_millis: u64,
    ) -> Result<TokenizeLineResultWithThemes, RegexError> {
        let active_theme_snapshot = self.theme_provider.theme();
        let previous_state = previous_state.map(|state| {
            if state.rule_id().get() != 0 && state.theme_id() != active_theme_snapshot.id() {
                self.rebind_state_stack(&state, &active_theme_snapshot)
            } else {
                state
            }
        });
        let is_continuation = previous_state
            .as_ref()
            .is_some_and(|state| state.rule_id().get() != 0);
        let cached_ancestry = if is_continuation && !themes.is_empty() {
            self.multi_theme_cache
                .try_lock()
                .ok()
                .and_then(|mut guard| guard.take())
        } else {
            None
        };
        let mut tokenized = self.tokenize(
            line_text,
            previous_state,
            TokenOutput::MultiTheme {
                themes,
                include_scopes,
                pinned_theme: &active_theme_snapshot,
                cached_ancestry,
            },
            time_limit_millis,
        )?;
        let tokens = include_scopes.then(|| {
            tokenized
                .line_tokens
                .result(&tokenized.result.stack, tokenized.line_length)
        });
        let multi_result = tokenized
            .line_tokens
            .multi_binary_result(&tokenized.result.stack, tokenized.line_length);
        if let Ok(mut guard) = self.multi_theme_cache.try_lock() {
            *guard = multi_result.ancestry;
        }
        #[cfg(test)]
        {
            *self
                .last_walk_stats
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(multi_result.walk_stats);
        }
        Ok(TokenizeLineResultWithThemes {
            tokens,
            binary_tokens: multi_result.binary_tokens,
            rule_stack: tokenized.result.stack,
            stopped_early: tokenized.result.stopped_early,
        })
    }

    fn tokenize(
        &self,
        line_text: &str,
        previous_state: Option<Arc<StateStack>>,
        output: TokenOutput<'_>,
        time_limit_millis: u64,
    ) -> Result<TokenizedLine, RegexError> {
        let owned_theme = match &output {
            TokenOutput::MultiTheme { .. } => None,
            _ => Some(self.theme_provider.theme()),
        };
        let pinned_theme: &Theme = match &output {
            TokenOutput::MultiTheme { pinned_theme, .. } => pinned_theme,
            _ => owned_theme
                .as_deref()
                .expect("non-multi-theme snapshots active theme"),
        };
        let (is_first_line, previous_state) = match previous_state {
            Some(state) if state.rule_id().get() != 0 => {
                state.reset();
                (false, state)
            }
            _ => (true, self.initial_state_with_theme(pinned_theme)),
        };

        let line_text = format!("{line_text}\n");
        let onig_line_text = OnigString::new(&line_text);
        let line_length = onig_line_text.utf16_len();
        let mut line_tokens = LineTokens::new(
            matches!(output, TokenOutput::Binary | TokenOutput::Both),
            &line_text,
            self.token_type_matchers.clone(),
            self.balanced_bracket_selectors.clone(),
        );
        match output {
            TokenOutput::Both => {
                line_tokens = line_tokens.with_scopes();
            }
            TokenOutput::MultiTheme {
                themes,
                include_scopes,
                pinned_theme,
                cached_ancestry,
            } => {
                line_tokens = line_tokens.with_themes(
                    themes,
                    include_scopes,
                    Arc::clone(&self.basic_scope_attributes),
                    Some(pinned_theme),
                    cached_ancestry,
                );
            }
            TokenOutput::Scopes | TokenOutput::Binary => {}
        }
        let mut line_fonts = LineFonts::new();
        let pinned = PinnedThemeGrammar {
            grammar: self,
            theme: pinned_theme,
        };
        let result = tokenize_string(
            &pinned,
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
        let theme = self.theme_provider.theme();
        self.initial_state_with_theme(&theme)
    }

    fn initial_state_with_theme(&self, theme: &Theme) -> Arc<StateStack> {
        let raw_default_metadata = self.basic_scope_attributes.default_attributes();
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
        let pinned = PinnedThemeGrammar {
            grammar: self,
            theme,
        };
        let scope_list = AttributedScopeStack::create_root_and_lookup_scope_name(
            root_scope_name,
            default_metadata,
            font_attribute,
            &pinned,
        );
        StateStack::new_with_theme_id(
            None,
            self.root_id,
            theme.id(),
            -1,
            -1,
            false,
            None,
            Some(Arc::clone(&scope_list)),
            Some(scope_list),
        )
    }

    fn rebind_state_stack(&self, state: &Arc<StateStack>, theme: &Theme) -> Arc<StateStack> {
        let mut frames = Vec::with_capacity(state.depth);
        let mut current = Some(Arc::clone(state));
        while let Some(frame) = current {
            let parent = frame.parent.clone();
            frames.push(frame);
            current = parent;
        }
        frames.reverse();

        let raw_default_metadata = self.basic_scope_attributes.default_attributes();
        let default_style = theme.get_defaults();
        let default_metadata = EncodedTokenAttributes::default().set(
            raw_default_metadata.language_id,
            raw_default_metadata.token_type,
            None,
            default_style.font_style,
            default_style.foreground_id,
            default_style.background_id,
        );
        let default_font = FontAttribute::from(
            Some(default_style.font_family.clone()),
            Some(default_style.font_size),
            Some(default_style.line_height),
        );
        let pinned = PinnedThemeGrammar {
            grammar: self,
            theme,
        };

        let mut rebuilt_parent: Option<Arc<StateStack>> = None;
        let mut prev_old_frame: Option<&Arc<StateStack>> = None;
        for old_frame in &frames {
            let mut name_bases = Vec::with_capacity(2);
            if let (Some(old_parent), Some(new_parent)) = (prev_old_frame, rebuilt_parent.as_ref())
            {
                if let (Some(old_content), Some(new_content)) = (
                    old_parent.content_name_scopes_list.as_ref(),
                    new_parent.content_name_scopes_list.as_ref(),
                ) {
                    name_bases.push((old_content, new_content));
                }
                if let (Some(old_name), Some(new_name)) = (
                    old_parent.name_scopes_list.as_ref(),
                    new_parent.name_scopes_list.as_ref(),
                ) {
                    name_bases.push((old_name, new_name));
                }
            }

            let new_name_scopes = old_frame.name_scopes_list.as_ref().map(|old_name| {
                old_name.rebind_extension(&name_bases, default_metadata, &default_font, &pinned)
            });

            let new_content_scopes = match (
                old_frame.content_name_scopes_list.as_ref(),
                old_frame.name_scopes_list.as_ref(),
                new_name_scopes.as_ref(),
            ) {
                (None, _, _) => None,
                (Some(old_content), Some(old_name), Some(new_name))
                    if Arc::ptr_eq(old_content, old_name) =>
                {
                    Some(Arc::clone(new_name))
                }
                (Some(old_content), old_name_opt, new_name_opt) => {
                    let mut content_bases = Vec::with_capacity(3);
                    if let (Some(old_name), Some(new_name)) = (old_name_opt, new_name_opt) {
                        content_bases.push((old_name, new_name));
                    }
                    content_bases.extend_from_slice(&name_bases);
                    Some(old_content.rebind_extension(
                        &content_bases,
                        default_metadata,
                        &default_font,
                        &pinned,
                    ))
                }
            };

            rebuilt_parent = Some(StateStack::new_with_theme_id(
                rebuilt_parent,
                old_frame.rule_id(),
                theme.id(),
                old_frame.enter_pos(),
                old_frame.anchor_pos(),
                old_frame.begin_rule_captured_eol,
                old_frame.end_rule.clone(),
                new_name_scopes,
                new_content_scopes,
            ));
            prev_old_frame = Some(old_frame);
        }
        rebuilt_parent.expect("non-empty StateStack must produce a rebound stack")
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

fn push_rule_patterns<'a>(
    rule_id: u32,
    registry: &'a RuleRegistry,
    frames: &mut Vec<std::slice::Iter<'a, RuleId>>,
    validation_work: &mut usize,
) -> Result<(), String> {
    *validation_work += 1;
    if *validation_work > MAX_GRAMMAR_STATE_RULE_VALIDATION_WORK {
        return Err(invalid_serialized_state(
            "state validation exceeded its work limit",
        ));
    }
    let Some(parent) = registry.try_get_rule(RuleId::new(rule_id)) else {
        return Ok(());
    };
    let patterns = match parent {
        Rule::IncludeOnly(rule) => &rule.patterns,
        Rule::BeginEnd(rule) => &rule.patterns,
        Rule::BeginWhile(rule) => &rule.patterns,
        Rule::Capture(_) | Rule::Match(_) => return Ok(()),
    };
    frames.push(patterns.iter());
    Ok(())
}

fn rule_patterns_reach(
    parent_rule_id: u32,
    child_rule_id: RuleId,
    registry: &RuleRegistry,
    visited: &mut HashSet<u32>,
    validation_work: &mut usize,
) -> Result<bool, String> {
    let mut frames: Vec<std::slice::Iter<'_, RuleId>> = Vec::new();
    push_rule_patterns(parent_rule_id, registry, &mut frames, validation_work)?;
    while let Some(iter) = frames.last_mut() {
        let Some(&pattern_id) = iter.next() else {
            frames.pop();
            continue;
        };
        *validation_work += 1;
        if *validation_work > MAX_GRAMMAR_STATE_RULE_VALIDATION_WORK {
            return Err(invalid_serialized_state(
                "state validation exceeded its work limit",
            ));
        }
        if pattern_id == child_rule_id {
            return Ok(true);
        }
        if !visited.insert(pattern_id.get()) {
            continue;
        }
        if registry
            .try_get_rule(pattern_id)
            .is_some_and(|rule| rule.as_include_only().is_some())
        {
            push_rule_patterns(pattern_id.get(), registry, &mut frames, validation_work)?;
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

    fn theme_id(&self) -> u64 {
        self.theme_provider.theme().id()
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
        )
        .unwrap();

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
        )
        .unwrap();

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
        )
        .unwrap();

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
        )
        .unwrap();
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
        )
        .unwrap();
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
        )
        .unwrap();
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
        )
        .unwrap();
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
        )
        .unwrap();
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
        )
        .unwrap();
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
        )
        .unwrap();
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
        )
        .unwrap();
        let second = Grammar::new(
            &relocated,
            &empty_store,
            default_theme(),
            GrammarConfiguration::default(),
        )
        .unwrap();
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
        )
        .unwrap();
        let grammar_ba = Grammar::new(
            &root,
            &store_ba,
            default_theme(),
            GrammarConfiguration::default(),
        )
        .unwrap();
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
        )
        .unwrap();

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
        )
        .unwrap();

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
        )
        .unwrap();

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
        )
        .unwrap();
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

    #[test]
    fn rejects_rule_id_zero_in_serialized_state_stack() {
        let root = raw_grammar(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "begin": "\\(", "end": "\\)", "name": "meta.paren" }]
            }"#,
        );
        let grammar = Grammar::new(
            &root,
            &GrammarStore::new(),
            default_theme(),
            GrammarConfiguration::default(),
        )
        .unwrap();
        let baseline = grammar.serialize_state_stack(None).unwrap();
        let mut parsed: serde_json::Value = serde_json::from_str(&baseline).unwrap();
        parsed["frames"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "ruleId": 0,
                "beginRuleCapturedEol": false,
                "endRule": null,
                "nameScopes": [],
                "contentNameScopes": []
            }));
        let tampered = serde_json::to_string(&parsed).unwrap();
        let Err(error) = grammar.deserialize_state_stack(&tampered) else {
            panic!("ruleId 0 must return an error instead of underflowing");
        };
        assert!(error.contains("unknown rule"), "unexpected error: {error}");
    }

    #[test]
    fn compiles_and_tokenizes_cyclic_include_only_grammars() {
        for source in [
            r##"{
                "scopeName": "source.cycle",
                "patterns": [{ "include": "#a" }],
                "repository": {
                    "a": { "patterns": [{ "include": "#b" }] },
                    "b": { "patterns": [{ "include": "#a" }, { "match": "ok", "name": "keyword.ok" }] }
                }
            }"##,
            r##"{
                "scopeName": "source.self",
                "patterns": [{ "include": "$self" }, { "match": "ok", "name": "keyword.ok" }]
            }"##,
        ] {
            let root = raw_grammar(source);
            let grammar = Grammar::new(
                &root,
                &GrammarStore::new(),
                default_theme(),
                GrammarConfiguration::default(),
            )
            .unwrap();
            grammar.compile_all_scanners().unwrap();
            let result = grammar.tokenize_line("ok", None, 0).unwrap();
            assert!(
                result
                    .tokens
                    .iter()
                    .any(|token| token.scopes.iter().any(|scope| scope == "keyword.ok")),
                "cyclic include-only grammar should still match reachable patterns"
            );
        }
    }

    #[test]
    fn compiles_long_acyclic_repository_include_chain_without_stack_overflow() {
        const CHAIN_LEN: usize = 15_000;
        let mut repo = serde_json::Map::with_capacity(CHAIN_LEN);
        for index in 0..CHAIN_LEN - 1 {
            repo.insert(
                format!("r{index}"),
                serde_json::json!({ "patterns": [{ "include": format!("#r{}", index + 1) }] }),
            );
        }
        repo.insert(
            format!("r{}", CHAIN_LEN - 1),
            serde_json::json!({
                "patterns": [{
                    "begin": "\\[",
                    "end": "\\]",
                    "name": "meta.bracket.ok"
                }]
            }),
        );
        let source = serde_json::json!({
            "scopeName": "source.chain",
            "patterns": [{ "include": "#r0" }],
            "repository": repo,
        })
        .to_string();
        let root = raw_grammar(&source);
        let grammar = Grammar::new(
            &root,
            &GrammarStore::new(),
            default_theme(),
            GrammarConfiguration::default(),
        )
        .unwrap();
        let open = grammar.tokenize_line("[open", None, 0).unwrap();
        assert!(
            open.tokens
                .iter()
                .any(|token| token.scopes.iter().any(|scope| scope == "meta.bracket.ok")),
            "long acyclic repository chain should compile and open begin/end rule"
        );
        let serialized = grammar
            .serialize_state_stack(Some(&open.rule_stack))
            .unwrap();
        let restored = grammar.deserialize_state_stack(&serialized).unwrap();
        let closed = grammar.tokenize_line("close]", Some(restored), 0).unwrap();
        assert_eq!(closed.rule_stack.depth, 1);
    }

    #[test]
    fn state_validation_descends_first_include_before_unrelated_siblings() {
        let mut unrelated = Vec::with_capacity(500);
        for index in 0..500 {
            unrelated.push(serde_json::json!({
                "match": format!("unrelated_{index}"),
                "name": "constant.other"
            }));
        }
        let source = serde_json::json!({
            "scopeName": "source.order",
            "patterns": [
                { "include": "#paren" },
                { "include": "#unrelated" }
            ],
            "repository": {
                "paren": {
                    "patterns": [{
                        "begin": "\\(",
                        "end": "\\)",
                        "patterns": [
                            { "include": "#paren" },
                            { "include": "#unrelated" }
                        ]
                    }]
                },
                "unrelated": {
                    "patterns": unrelated
                }
            }
        })
        .to_string();
        let root = raw_grammar(&source);
        let grammar = Grammar::new(
            &root,
            &GrammarStore::new(),
            default_theme(),
            GrammarConfiguration::default(),
        )
        .unwrap();
        let open = grammar.tokenize_line2(&"(".repeat(256), None, 0).unwrap();
        let serialized = grammar
            .serialize_state_stack(Some(&open.rule_stack))
            .expect("first-include DFS order must not exhaust validation work on later siblings");
        let restored = grammar
            .deserialize_state_stack(&serialized)
            .expect("serialized state must round-trip within work budget");
        assert_eq!(restored.depth, 257);
    }

    #[test]
    fn tokenize_line_with_themes_matches_individual_single_theme_runs_bit_for_bit() {
        use std::sync::Arc;

        use crate::{
            EmbeddedLanguages, RawThemeScope, RawThemeSetting, RawThemeStyle, SyncRegistry,
        };

        let host = raw_grammar(
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
                    { "match": "foo", "name": "keyword.control.host" },
                    { "match": "bar", "name": "string.quoted.host" },
                    { "match": "//.*$", "name": "comment.line.host" }
                ]
            }"#,
        );
        let inner = raw_grammar(
            r#"{
                "scopeName": "source.inner",
                "patterns": [
                    { "match": "baz", "name": "variable.other.inner" },
                    { "match": "123", "name": "constant.numeric.inner" }
                ]
            }"#,
        );

        let light = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![
                        RawThemeSetting {
                            scope: None,
                            settings: Some(RawThemeStyle {
                                foreground: Some("#111111".into()),
                                background: Some("#ffffff".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                        RawThemeSetting {
                            scope: Some(RawThemeScope::String("keyword.control".into())),
                            settings: Some(RawThemeStyle {
                                foreground: Some("#aa0000".into()),
                                font_style: Some("bold".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                        // Parent-scope selector + background difference to test
                        // per-theme merging boundaries.
                        RawThemeSetting {
                            scope: Some(RawThemeScope::String(
                                "source.inner variable.other".into(),
                            )),
                            settings: Some(RawThemeStyle {
                                foreground: Some("#00aa00".into()),
                                background: Some("#f0f0f0".into()),
                                font_style: Some("italic".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                    ],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );
        let dark = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![
                        RawThemeSetting {
                            scope: None,
                            settings: Some(RawThemeStyle {
                                foreground: Some("#eeeeee".into()),
                                background: Some("#101010".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                        RawThemeSetting {
                            scope: Some(RawThemeScope::String("string.quoted".into())),
                            settings: Some(RawThemeStyle {
                                foreground: Some("#00ccff".into()),
                                font_style: Some("underline".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                        RawThemeSetting {
                            scope: Some(RawThemeScope::String("constant.numeric".into())),
                            settings: Some(RawThemeStyle {
                                foreground: Some("#ff8800".into()),
                                font_style: Some("bold strikethrough".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                    ],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );

        let mut embedded = EmbeddedLanguages::default();
        embedded.insert("source.inner".into(), 2);
        let config = GrammarConfiguration::default()
            .with_initial_language_id(1)
            .with_embedded_languages(embedded)
            .with_token_types(vec![(
                "variable.other.inner".into(),
                StandardTokenType::RegEx,
            )])
            .with_balanced_bracket_selectors(Some(vec!["*".into()]))
            .with_unbalanced_bracket_selectors(vec!["comment".into()]);

        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(host, Vec::new());
        registry.add_grammar(inner, Vec::new());
        let grammar = registry
            .grammar_for_scope_name("source.host", config)
            .unwrap()
            .unwrap();

        let lines = [
            "foo bar <% baz",
            "",
            "123 baz %> // comment",
            "א foo bar",
            "",
        ];
        // Intentionally include a duplicate theme reference and leave the
        // registry active theme on the default theme (different from both).
        let themes = [Arc::clone(&light), Arc::clone(&dark), Arc::clone(&light)];

        // Reference: run tokenize_line2 and tokenize_line independently per theme.
        let mut expected_binary = vec![Vec::new(); themes.len()];
        let mut expected_scopes = Vec::new();
        for (theme_index, theme) in themes.iter().enumerate() {
            registry.set_compiled_theme(Arc::clone(theme));
            let mut state = None;
            for line in lines {
                let res = grammar.tokenize_line2(line, state, 0).unwrap();
                expected_binary[theme_index].push(res.tokens);
                state = Some(res.rule_stack);
            }
        }
        {
            let mut state = None;
            for line in lines {
                let res = grammar.tokenize_line(line, state, 0).unwrap();
                expected_scopes.push(res.tokens);
                state = Some(res.rule_stack);
            }
        }

        // Leave registry on an unrelated default theme to prove multi-theme
        // resolution does not rely on active-theme state matching.
        registry.set_theme(None, None).unwrap();

        for include_scopes in [false, true] {
            let mut state = None;
            for (line_index, line) in lines.iter().enumerate() {
                let multi = grammar
                    .tokenize_line_with_themes(line, state, &themes, include_scopes, 0)
                    .unwrap();
                assert_eq!(multi.binary_tokens.len(), themes.len());
                for (theme_index, (actual, expected)) in multi
                    .binary_tokens
                    .iter()
                    .zip(expected_binary.iter())
                    .enumerate()
                {
                    assert_eq!(
                        actual, &expected[line_index],
                        "line {line_index} theme {theme_index} include_scopes={include_scopes}"
                    );
                }
                if include_scopes {
                    assert_eq!(
                        multi.tokens.as_ref().unwrap(),
                        &expected_scopes[line_index],
                        "line {line_index} scopes"
                    );
                } else {
                    assert!(multi.tokens.is_none());
                }
                state = Some(multi.rule_stack);
            }
        }

        // Empty theme list still advances state cleanly.
        let empty = grammar
            .tokenize_line_with_themes("foo", None, &[], false, 0)
            .unwrap();
        assert!(empty.binary_tokens.is_empty());
        assert!(empty.tokens.is_none());
    }

    #[test]
    fn rejects_foreground_id_512_and_packs_max_valid_foreground_511_across_scopes() {
        use std::sync::Arc;

        use crate::{RawThemeScope, RawThemeSetting, RawThemeStyle, SyncRegistry, ThemeError};

        // Build a frozen color map with 513 entries so index 512 exceeds the 9-bit
        // foreground field while index 511 is the maximum encodable foreground ID.
        let mut frozen_colors = Vec::with_capacity(513);
        frozen_colors.push(String::new());
        frozen_colors.push("#000000".to_owned()); // index 1: default fg
        frozen_colors.push("#FFFFFF".to_owned()); // index 2: default bg
        frozen_colors.push("#000003".to_owned()); // index 3: child fg
        for index in 4..512 {
            frozen_colors.push(format!("#{index:06X}"));
        }
        frozen_colors.push("#000200".to_owned()); // index 512: out-of-range fg

        let overflow_theme = RawTheme {
            settings: vec![
                RawThemeSetting {
                    scope: None,
                    settings: Some(RawThemeStyle {
                        foreground: Some("#000000".into()),
                        background: Some("#FFFFFF".into()),
                        ..RawThemeStyle::default()
                    }),
                    ..RawThemeSetting::default()
                },
                RawThemeSetting {
                    scope: Some(RawThemeScope::String("meta.parent".into())),
                    settings: Some(RawThemeStyle {
                        foreground: Some("#000200".into()),
                        ..RawThemeStyle::default()
                    }),
                    ..RawThemeSetting::default()
                },
            ],
            ..RawTheme::default()
        };
        let err = Theme::create_from_raw_theme(Some(&overflow_theme), Some(frozen_colors.clone()))
            .unwrap_err();
        assert_eq!(
            err,
            ThemeError::ColorMapOverflow {
                color: "#000200".to_owned(),
                id: 512,
                max_id: 511,
            }
        );

        let raw_theme = RawTheme {
            settings: vec![
                RawThemeSetting {
                    scope: None,
                    settings: Some(RawThemeStyle {
                        foreground: Some("#000000".into()),
                        background: Some("#FFFFFF".into()),
                        ..RawThemeStyle::default()
                    }),
                    ..RawThemeSetting::default()
                },
                RawThemeSetting {
                    scope: Some(RawThemeScope::String("meta.parent".into())),
                    settings: Some(RawThemeStyle {
                        foreground: Some("#0001FF".into()), // index 511: max valid fg
                        ..RawThemeStyle::default()
                    }),
                    ..RawThemeSetting::default()
                },
                RawThemeSetting {
                    scope: Some(RawThemeScope::String("keyword.child".into())),
                    settings: Some(RawThemeStyle {
                        foreground: Some("#000003".into()),
                        ..RawThemeStyle::default()
                    }),
                    ..RawThemeSetting::default()
                },
            ],
            ..RawTheme::default()
        };

        let theme =
            Arc::new(Theme::create_from_raw_theme(Some(&raw_theme), Some(frozen_colors)).unwrap());
        let source = raw_grammar(
            r#"{
                "scopeName": "source.overflow",
                "patterns": [
                    {
                        "begin": "\\(",
                        "end": "\\)",
                        "name": "meta.parent",
                        "patterns": [
                            { "match": "x", "name": "keyword.child" }
                        ]
                    },
                    { "match": "y", "name": "keyword.child" }
                ]
            }"#,
        );

        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(source, Vec::new());
        let grammar = registry
            .grammar_for_scope_name("source.overflow", GrammarConfiguration::default())
            .unwrap()
            .unwrap();

        registry.set_compiled_theme(Arc::clone(&theme));
        let single = grammar.tokenize_line2("(x)y", None, 0).unwrap();

        let parent_attrs = EncodedTokenAttributes::new(single.tokens[1]);
        assert_eq!(parent_attrs.foreground(), 511);
        assert_eq!(parent_attrs.background(), 2);

        // Child token inside `meta.parent` keeps default background 2 (no bleed).
        assert_eq!(single.tokens[3], single.tokens[7]);
        let child_attrs = EncodedTokenAttributes::new(single.tokens[3]);
        assert_eq!(child_attrs.foreground(), 3);
        assert_eq!(child_attrs.background(), 2);

        // Run multi-theme tokenization with an unrelated default active theme.
        registry.set_theme(None, None).unwrap();
        let multi = grammar
            .tokenize_line_with_themes("(x)y", None, &[Arc::clone(&theme)], false, 0)
            .unwrap();
        assert_eq!(multi.binary_tokens[0], single.tokens);
    }

    #[test]
    fn rejects_oversized_language_ids_and_preserves_max_8_bit_language_id_packing() {
        use std::sync::Arc;

        use crate::{EmbeddedLanguages, FontStyle, SyncRegistry, ThemeError};

        let source = raw_grammar(
            r#"{
                "scopeName": "source.langoverflow",
                "patterns": [{ "match": "x", "name": "keyword.x" }]
            }"#,
        );
        let theme = Arc::new(Theme::create_from_raw_theme(None, None).unwrap());

        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(source, Vec::new());

        let initial_err = registry
            .grammar_for_scope_name(
                "source.langoverflow",
                GrammarConfiguration::default().with_initial_language_id(2048),
            )
            .err()
            .expect("initial_language_id > 255 must be rejected");
        assert_eq!(
            initial_err,
            ThemeError::InvalidLanguageId {
                language_id: 2048,
                max_language_id: 255,
            }
        );

        let embedded_err = registry
            .grammar_for_scope_name(
                "source.langoverflow",
                GrammarConfiguration::default()
                    .with_embedded_languages(EmbeddedLanguages::from([("keyword.x".into(), 256)])),
            )
            .err()
            .expect("embedded language_id > 255 must be rejected");
        assert_eq!(
            embedded_err,
            ThemeError::InvalidLanguageId {
                language_id: 256,
                max_language_id: 255,
            }
        );

        let grammar = registry
            .grammar_for_scope_name(
                "source.langoverflow",
                GrammarConfiguration::default().with_initial_language_id(255),
            )
            .unwrap()
            .unwrap();

        registry.set_compiled_theme(Arc::clone(&theme));
        let single = grammar.tokenize_line2("x", None, 0).unwrap();
        let attrs = EncodedTokenAttributes::new(single.tokens[1]);
        assert_eq!(attrs.language_id(), 255);
        assert_eq!(attrs.token_type(), StandardTokenType::Other);
        assert_eq!(attrs.font_style(), FontStyle::NONE);
        assert_eq!(attrs.foreground(), 1);
        assert_eq!(attrs.background(), 2);

        let multi = grammar
            .tokenize_line_with_themes("x", None, &[Arc::clone(&theme)], false, 0)
            .unwrap();
        assert_eq!(multi.binary_tokens[0], single.tokens);

        // Concise Debug summary (ADR 0014): reports lengths/counts without dumping payloads.
        let debug = format!("{multi:?}");
        assert!(debug.contains("theme_count: 1"));
        assert!(debug.contains("binary_token_entries: 2"));
        assert!(debug.contains("rule_stack_depth: 1"));
    }

    #[test]
    fn tokenize_line_with_themes_reuses_ancestry_across_continuation_lines_and_stops_at_shared_ancestor()
     {
        use std::sync::Arc;

        use crate::{RawThemeScope, RawThemeSetting, RawThemeStyle, SyncRegistry};

        let source = raw_grammar(
            r#"{
                "scopeName": "source.deep",
                "patterns": [
                    {
                        "begin": "\\(",
                        "end": "\\)",
                        "name": "meta.group",
                        "patterns": [{ "include": "$self" }]
                    },
                    { "match": "a", "name": "meta.outer.a keyword.inner.a" },
                    { "match": "b", "name": "meta.outer.b string.inner.b" }
                ]
            }"#,
        );
        let light = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![
                        RawThemeSetting {
                            scope: Some(RawThemeScope::String("keyword.inner.a".into())),
                            settings: Some(RawThemeStyle {
                                foreground: Some("#aa0000".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                        RawThemeSetting {
                            scope: Some(RawThemeScope::String("string.inner.b".into())),
                            settings: Some(RawThemeStyle {
                                foreground: Some("#00aa00".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                    ],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );
        let dark = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![
                        RawThemeSetting {
                            scope: Some(RawThemeScope::String("keyword.inner.a".into())),
                            settings: Some(RawThemeStyle {
                                foreground: Some("#112233".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                        RawThemeSetting {
                            scope: Some(RawThemeScope::String("string.inner.b".into())),
                            settings: Some(RawThemeStyle {
                                foreground: Some("#445566".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                    ],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );

        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(source, Vec::new());
        let grammar = registry
            .grammar_for_scope_name("source.deep", GrammarConfiguration::default())
            .unwrap()
            .unwrap();

        let open_line = "(".repeat(400);
        let body_line = "ababababab";
        let themes = [Arc::clone(&light), Arc::clone(&dark)];

        // Reference single-theme runs for line 0 + 20 continuation lines.
        let mut expected = vec![Vec::new(); themes.len()];
        for (idx, theme) in themes.iter().enumerate() {
            registry.set_compiled_theme(Arc::clone(theme));
            let first = grammar.tokenize_line2(&open_line, None, 0).unwrap();
            expected[idx].push(first.tokens);
            let mut state = Some(first.rule_stack);
            for _ in 0..20 {
                let next = grammar.tokenize_line2(body_line, state, 0).unwrap();
                expected[idx].push(next.tokens);
                state = Some(next.rule_stack);
            }
        }

        // Single-pass multi-theme run across all lines with `light` active so
        // slot 0 reuses `scopes.token_attributes` directly without re-resolving.
        registry.set_compiled_theme(Arc::clone(&light));
        let first = grammar
            .tokenize_line_with_themes(&open_line, None, &themes, false, 0)
            .unwrap();
        assert_eq!(first.binary_tokens[0], expected[0][0]);
        assert_eq!(first.binary_tokens[1], expected[1][0]);
        let open_stats = grammar.last_multi_theme_walk_stats().unwrap();
        assert!(open_stats.active_slot_reused);
        assert!(open_stats.nodes_resolved >= 400);

        let mut state = Some(first.rule_stack);
        for (offset, (expected_light, expected_dark)) in expected[0][1..]
            .iter()
            .zip(expected[1][1..].iter())
            .enumerate()
        {
            let line_num = offset + 1;
            let next = grammar
                .tokenize_line_with_themes(body_line, state, &themes, false, 0)
                .unwrap();
            assert_eq!(&next.binary_tokens[0], expected_light);
            assert_eq!(&next.binary_tokens[1], expected_dark);
            let stats = grammar.last_multi_theme_walk_stats().unwrap();
            assert!(stats.active_slot_reused);
            // 10 tokens with 2-scope match rules: must reuse all 400 open scopes
            // from the continuation cache and stop each fallback walk at the
            // grandparent (at most ~3 steps per token, never walking 400 nodes!).
            assert!(
                stats.nodes_resolved <= 25,
                "continuation line {line_num} should reuse 400 open scopes, resolved {} nodes",
                stats.nodes_resolved
            );
            assert!(
                stats.fallback_walk_steps <= 40,
                "2-scope sibling matches at depth 400 must stop at nearest shared ancestor, walked {} steps",
                stats.fallback_walk_steps
            );
            state = Some(next.rule_stack);
        }

        // Passing only the active theme reuses `scopes.token_attributes` with
        // zero extra scope-chain resolution even on a depth-400 line.
        let single_active = grammar
            .tokenize_line_with_themes(&open_line, None, &[Arc::clone(&light)], false, 0)
            .unwrap();
        assert_eq!(single_active.binary_tokens[0], expected[0][0]);
        let single_active_stats = grammar.last_multi_theme_walk_stats().unwrap();
        assert!(single_active_stats.active_slot_reused);
        assert_eq!(single_active_stats.nodes_resolved, 0);

        // Passing a state produced under `light` after switching the active
        // registry theme to `dark` rebinds the stale continuation stack to
        // `dark`, preserves active-slot reuse, and produces bit-for-bit exact
        // metadata for both themes.
        let stale_state = grammar
            .tokenize_line2(&open_line, None, 0)
            .unwrap()
            .rule_stack;
        assert_eq!(stale_state.theme_id(), light.id());
        registry.set_compiled_theme(Arc::clone(&dark));
        let switched = grammar
            .tokenize_line_with_themes(body_line, Some(stale_state), &themes, false, 0)
            .unwrap();
        assert_eq!(switched.binary_tokens[0], expected[0][1]);
        assert_eq!(switched.binary_tokens[1], expected[1][1]);
        assert_eq!(switched.rule_stack.theme_id(), dark.id());
        assert!(
            grammar
                .last_multi_theme_walk_stats()
                .unwrap()
                .active_slot_reused
        );

        // Dropping external Arc<Theme> references must release them immediately
        // even while the grammar still holds its multi-theme ancestry cache.
        let light_weak = Arc::downgrade(&light);
        let dark_weak = Arc::downgrade(&dark);
        drop(themes);
        drop(light);
        drop(dark);
        registry.set_theme(None, None).unwrap();
        assert!(
            light_weak.upgrade().is_none(),
            "MultiThemeAncestry must not retain strong Arc<Theme> references"
        );
        assert!(
            dark_weak.upgrade().is_none(),
            "MultiThemeAncestry must not retain strong Arc<Theme> references"
        );
        assert!(grammar.last_multi_theme_walk_stats().is_some());
    }

    #[test]
    fn tokenize_line_with_themes_keeps_bounded_tail_checkpoint_at_depth_1050() {
        use std::sync::Arc;

        use crate::{RawThemeScope, RawThemeSetting, RawThemeStyle, SyncRegistry};

        let source = raw_grammar(
            r#"{
                "scopeName": "source.verydeep",
                "patterns": [
                    {
                        "begin": "\\(",
                        "end": "\\)",
                        "name": "meta.group",
                        "patterns": [{ "include": "$self" }]
                    },
                    { "match": "a", "name": "meta.outer.a keyword.inner.a" },
                    { "match": "b", "name": "meta.outer.b string.inner.b" }
                ]
            }"#,
        );
        let light = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![RawThemeSetting {
                        scope: Some(RawThemeScope::String("keyword.inner.a".into())),
                        settings: Some(RawThemeStyle {
                            foreground: Some("#aa0000".into()),
                            ..RawThemeStyle::default()
                        }),
                        ..RawThemeSetting::default()
                    }],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );
        let dark = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![RawThemeSetting {
                        scope: Some(RawThemeScope::String("string.inner.b".into())),
                        settings: Some(RawThemeStyle {
                            foreground: Some("#00aa00".into()),
                            ..RawThemeStyle::default()
                        }),
                        ..RawThemeSetting::default()
                    }],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );

        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(source, Vec::new());
        let grammar = registry
            .grammar_for_scope_name("source.verydeep", GrammarConfiguration::default())
            .unwrap()
            .unwrap();

        let open_line = "(".repeat(1_050);
        let body_line = "abababab";
        let themes = [Arc::clone(&light), Arc::clone(&dark)];

        registry.set_compiled_theme(Arc::clone(&light));
        let ref_light_0 = grammar.tokenize_line2(&open_line, None, 0).unwrap();
        let ref_light_1 = grammar
            .tokenize_line2(body_line, Some(Arc::clone(&ref_light_0.rule_stack)), 0)
            .unwrap();
        registry.set_compiled_theme(Arc::clone(&dark));
        let ref_dark_0 = grammar.tokenize_line2(&open_line, None, 0).unwrap();
        let ref_dark_1 = grammar
            .tokenize_line2(body_line, Some(Arc::clone(&ref_dark_0.rule_stack)), 0)
            .unwrap();

        registry.set_compiled_theme(Arc::clone(&light));
        let first = grammar
            .tokenize_line_with_themes(&open_line, None, &themes, false, 0)
            .unwrap();
        assert_eq!(first.binary_tokens[0], ref_light_0.tokens);
        assert_eq!(first.binary_tokens[1], ref_dark_0.tokens);
        assert!(
            grammar.last_multi_theme_cached_nodes() <= 1_024,
            "retained tail checkpoint must stay bounded to <= 1,024 nodes"
        );

        let mut state = Some(first.rule_stack);
        for line_num in 1..=20 {
            let next = grammar
                .tokenize_line_with_themes(body_line, state, &themes, false, 0)
                .unwrap();
            assert_eq!(next.binary_tokens[0], ref_light_1.tokens);
            assert_eq!(next.binary_tokens[1], ref_dark_1.tokens);
            let stats = grammar.last_multi_theme_walk_stats().unwrap();
            assert!(
                stats.nodes_resolved <= 25,
                "depth-1050 continuation line {line_num} must reuse tail checkpoint, resolved {} nodes",
                stats.nodes_resolved
            );
            assert!(
                grammar.last_multi_theme_cached_nodes() <= 1_024,
                "retained tail checkpoint must stay bounded to <= 1,024 nodes"
            );
            state = Some(next.rule_stack);
        }

        // Dropping the returned continuation stack must release the entire
        // ScopeStack chain (including its root/prefix) even while the grammar
        // retains its bounded tail checkpoint.
        let mut root_scope = Arc::clone(
            &state
                .as_ref()
                .unwrap()
                .content_name_scopes_list
                .as_ref()
                .unwrap()
                .scope_path,
        );
        while let Some(parent) = root_scope.parent.as_ref() {
            root_scope = Arc::clone(parent);
        }
        let root_weak = Arc::downgrade(&root_scope);
        drop(root_scope);
        drop(state);
        drop(ref_light_0);
        drop(ref_light_1);
        drop(ref_dark_0);
        drop(ref_dark_1);
        assert!(
            root_weak.upgrade().is_none(),
            "dropping continuation rule_stack must release prefix ScopeStack nodes immediately"
        );
    }

    #[test]
    fn tokenize_line_with_themes_amortizes_tail_trimming_in_batches() {
        use std::sync::Arc;

        use crate::{RawThemeScope, RawThemeSetting, RawThemeStyle, SyncRegistry};

        let source = raw_grammar(
            r#"{
                "scopeName": "source.growing",
                "patterns": [
                    {
                        "begin": "\\(",
                        "end": "\\)",
                        "name": "meta.group",
                        "patterns": [{ "include": "$self" }]
                    },
                    { "match": "a", "name": "keyword.a" }
                ]
            }"#,
        );
        let light = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![RawThemeSetting {
                        scope: Some(RawThemeScope::String("keyword.a".into())),
                        settings: Some(RawThemeStyle {
                            foreground: Some("#aa0000".into()),
                            ..RawThemeStyle::default()
                        }),
                        ..RawThemeSetting::default()
                    }],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );
        let dark = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![RawThemeSetting {
                        scope: Some(RawThemeScope::String("keyword.a".into())),
                        settings: Some(RawThemeStyle {
                            foreground: Some("#00aa00".into()),
                            font_style: Some("bold".into()),
                            ..RawThemeStyle::default()
                        }),
                        ..RawThemeSetting::default()
                    }],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );

        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(source, Vec::new());
        let grammar = registry
            .grammar_for_scope_name("source.growing", GrammarConfiguration::default())
            .unwrap()
            .unwrap();

        let open_line = "(".repeat(1_000);
        let grow_line = "(a";
        let themes = [Arc::clone(&light), Arc::clone(&dark)];

        // Reference single-theme runs for depth 1,000 -> 1,200 across 200 lines.
        let mut expected = vec![Vec::new(); themes.len()];
        for (idx, theme) in themes.iter().enumerate() {
            registry.set_compiled_theme(Arc::clone(theme));
            let first = grammar.tokenize_line2(&open_line, None, 0).unwrap();
            expected[idx].push(first.tokens);
            let mut state = Some(first.rule_stack);
            for _ in 0..200 {
                let next = grammar.tokenize_line2(grow_line, state, 0).unwrap();
                expected[idx].push(next.tokens);
                state = Some(next.rule_stack);
            }
        }

        registry.set_compiled_theme(Arc::clone(&light));
        let first = grammar
            .tokenize_line_with_themes(&open_line, None, &themes, false, 0)
            .unwrap();
        assert_eq!(first.binary_tokens[0], expected[0][0]);
        assert_eq!(first.binary_tokens[1], expected[1][0]);
        assert!(grammar.last_multi_theme_cached_nodes() <= 1_024);
        let mut total_trim_rebuilds = grammar.last_multi_theme_walk_stats().unwrap().trim_rebuilds;

        let mut state = Some(first.rule_stack);
        for (expected_light, expected_dark) in expected[0][1..].iter().zip(expected[1][1..].iter())
        {
            let next = grammar
                .tokenize_line_with_themes(grow_line, state, &themes, false, 0)
                .unwrap();
            assert_eq!(&next.binary_tokens[0], expected_light);
            assert_eq!(&next.binary_tokens[1], expected_dark);
            assert!(
                grammar.last_multi_theme_cached_nodes() <= 1_024,
                "retained ancestry must stay strictly <= 1,024 nodes"
            );
            total_trim_rebuilds += grammar.last_multi_theme_walk_stats().unwrap().trim_rebuilds;
            state = Some(next.rule_stack);
        }

        assert_eq!(
            total_trim_rebuilds, 1,
            "growing nesting from depth 1,000 to 1,200 across 200 lines must batch-trim only once"
        );
    }

    #[test]
    fn tokenize_line_with_themes_rebinds_stale_state_stack_for_subsequent_tokenize_line2() {
        use std::sync::Arc;

        use crate::{FontStyle, RawThemeScope, RawThemeSetting, RawThemeStyle, SyncRegistry};

        let source = raw_grammar(
            r#"{
                "scopeName": "source.rebind",
                "patterns": [
                    {
                        "begin": "/\\*",
                        "end": "\\*/",
                        "name": "comment.block"
                    }
                ]
            }"#,
        );
        let theme_a = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![RawThemeSetting {
                        scope: Some(RawThemeScope::String("comment.block".into())),
                        settings: Some(RawThemeStyle {
                            foreground: Some("#aa0000".into()),
                            font_style: Some("italic".into()),
                            ..RawThemeStyle::default()
                        }),
                        ..RawThemeSetting::default()
                    }],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );
        let theme_b = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![RawThemeSetting {
                        scope: Some(RawThemeScope::String("comment.block".into())),
                        settings: Some(RawThemeStyle {
                            foreground: Some("#00bb00".into()),
                            font_style: Some("bold".into()),
                            ..RawThemeStyle::default()
                        }),
                        ..RawThemeSetting::default()
                    }],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );

        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(source, Vec::new());
        let grammar = registry
            .grammar_for_scope_name("source.rebind", GrammarConfiguration::default())
            .unwrap()
            .unwrap();

        // Reference Theme B continuation output produced cleanly under Theme B.
        registry.set_compiled_theme(Arc::clone(&theme_b));
        let ref_b_0 = grammar.tokenize_line2("/* open", None, 0).unwrap();
        let ref_b_1 = grammar
            .tokenize_line2("still inside", Some(ref_b_0.rule_stack), 0)
            .unwrap();
        let ref_b_2 = grammar
            .tokenize_line2("continued under B", Some(ref_b_1.rule_stack), 0)
            .unwrap();

        // Open the italic comment scope under Theme A.
        registry.set_compiled_theme(Arc::clone(&theme_a));
        let opened_under_a = grammar.tokenize_line2("/* open", None, 0).unwrap();
        assert_eq!(opened_under_a.rule_stack.theme_id(), theme_a.id());
        let opened_style = EncodedTokenAttributes::new(opened_under_a.tokens[1]).font_style();
        assert_eq!(opened_style, FontStyle::ITALIC);

        // Reference Theme A continuation output.
        let ref_a_1 = grammar
            .tokenize_line2(
                "still inside",
                Some(Arc::clone(&opened_under_a.rule_stack)),
                0,
            )
            .unwrap();

        // Switch active theme to Theme B (bold) and continue Theme A's stack
        // through `tokenize_line_with_themes`.
        registry.set_compiled_theme(Arc::clone(&theme_b));
        let themes = [Arc::clone(&theme_a), Arc::clone(&theme_b)];
        let multi = grammar
            .tokenize_line_with_themes(
                "still inside",
                Some(opened_under_a.rule_stack),
                &themes,
                false,
                0,
            )
            .unwrap();
        assert_eq!(multi.binary_tokens[0], ref_a_1.tokens);
        assert_eq!(multi.binary_tokens[1], ref_b_1.tokens);
        assert_eq!(multi.rule_stack.theme_id(), theme_b.id());
        assert!(
            grammar
                .last_multi_theme_walk_stats()
                .unwrap()
                .active_slot_reused
        );

        // Passing the newly returned `rule_stack` into `tokenize_line2` must
        // carry Theme B's bold style rather than Theme A's stale italic style.
        let continued_b = grammar
            .tokenize_line2("continued under B", Some(multi.rule_stack), 0)
            .unwrap();
        assert_eq!(continued_b.tokens, ref_b_2.tokens);
        let continued_style = EncodedTokenAttributes::new(continued_b.tokens[1]).font_style();
        assert_eq!(continued_style, FontStyle::BOLD);
    }

    #[test]
    fn tokenize_line_with_themes_rebinds_mixed_theme_state_stack_after_a_b_a_switch() {
        use std::sync::Arc;

        use crate::{FontStyle, RawThemeScope, RawThemeSetting, RawThemeStyle, SyncRegistry};

        let source = raw_grammar(
            r#"{
                "scopeName": "source.mixedtheme",
                "patterns": [
                    {
                        "begin": "/\\*",
                        "end": "\\*/",
                        "name": "comment.block",
                        "contentName": "comment.block.body"
                    }
                ]
            }"#,
        );
        let theme_a = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![RawThemeSetting {
                        scope: Some(RawThemeScope::String("comment.block".into())),
                        settings: Some(RawThemeStyle {
                            foreground: Some("#aa0000".into()),
                            font_style: Some("italic".into()),
                            ..RawThemeStyle::default()
                        }),
                        ..RawThemeSetting::default()
                    }],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );
        let theme_b = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![RawThemeSetting {
                        scope: Some(RawThemeScope::String("comment.block".into())),
                        settings: Some(RawThemeStyle {
                            foreground: Some("#00bb00".into()),
                            font_style: Some("bold".into()),
                            ..RawThemeStyle::default()
                        }),
                        ..RawThemeSetting::default()
                    }],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );

        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(source, Vec::new());
        let grammar = registry
            .grammar_for_scope_name("source.mixedtheme", GrammarConfiguration::default())
            .unwrap()
            .unwrap();

        // Clean reference outputs under Theme A (italic) and Theme B (bold).
        registry.set_compiled_theme(Arc::clone(&theme_a));
        let ref_a_0 = grammar.tokenize_line2("plain", None, 0).unwrap();
        let ref_a_1 = grammar
            .tokenize_line2("/* open", Some(ref_a_0.rule_stack), 0)
            .unwrap();
        let ref_a_2 = grammar
            .tokenize_line2("inside comment", Some(ref_a_1.rule_stack), 0)
            .unwrap();

        registry.set_compiled_theme(Arc::clone(&theme_b));
        let ref_b_0 = grammar.tokenize_line2("plain", None, 0).unwrap();
        let ref_b_1 = grammar
            .tokenize_line2("/* open", Some(ref_b_0.rule_stack), 0)
            .unwrap();
        let ref_b_2 = grammar
            .tokenize_line2("inside comment", Some(ref_b_1.rule_stack), 0)
            .unwrap();

        // Step 1: start under Theme A (root frame gets theme_id = A).
        registry.set_compiled_theme(Arc::clone(&theme_a));
        let line0 = grammar.tokenize_line2("plain", None, 0).unwrap();
        assert_eq!(line0.rule_stack.theme_id(), theme_a.id());

        // Step 2: switch to Theme B and open a comment via `tokenize_line2`.
        // The pushed frame mixes parent theme A with scan theme B, so it must
        // be tagged with `theme_id == 0` (mixed-theme).
        registry.set_compiled_theme(Arc::clone(&theme_b));
        let line1 = grammar
            .tokenize_line2("/* open", Some(line0.rule_stack), 0)
            .unwrap();
        assert_eq!(line1.rule_stack.theme_id(), 0);

        // Step 3: switch back to Theme A and call `tokenize_line_with_themes`.
        // Because `line1.rule_stack.theme_id() == 0 != theme_a.id()`, it must
        // rebind the mixed stack to Theme A so Theme A renders italic and
        // Theme B renders bold.
        registry.set_compiled_theme(Arc::clone(&theme_a));
        let themes = [Arc::clone(&theme_a), Arc::clone(&theme_b)];
        let line2 = grammar
            .tokenize_line_with_themes("inside comment", Some(line1.rule_stack), &themes, false, 0)
            .unwrap();
        assert_eq!(line2.binary_tokens[0], ref_a_2.tokens);
        assert_eq!(line2.binary_tokens[1], ref_b_2.tokens);
        assert_eq!(
            EncodedTokenAttributes::new(line2.binary_tokens[0][1]).font_style(),
            FontStyle::ITALIC
        );
        assert_eq!(
            EncodedTokenAttributes::new(line2.binary_tokens[1][1]).font_style(),
            FontStyle::BOLD
        );
        assert_eq!(line2.rule_stack.theme_id(), theme_a.id());
    }

    #[test]
    fn tokenize_line_with_themes_pins_active_theme_across_concurrent_switches() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        use super::ThemeProvider;
        use crate::{RawThemeScope, RawThemeSetting, RawThemeStyle};

        struct StopOnDrop<'a>(&'a AtomicBool);
        impl Drop for StopOnDrop<'_> {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }

        let source = raw_grammar(
            r#"{
                "scopeName": "source.concurrent",
                "patterns": [
                    { "match": "a", "name": "keyword.a" },
                    { "match": "b", "name": "string.b" }
                ]
            }"#,
        );
        let light = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![
                        RawThemeSetting {
                            scope: Some(RawThemeScope::String("keyword.a".into())),
                            settings: Some(RawThemeStyle {
                                foreground: Some("#111111".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                        RawThemeSetting {
                            scope: Some(RawThemeScope::String("string.b".into())),
                            settings: Some(RawThemeStyle {
                                foreground: Some("#222222".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                    ],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );
        let dark = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![
                        RawThemeSetting {
                            scope: Some(RawThemeScope::String("keyword.a".into())),
                            settings: Some(RawThemeStyle {
                                foreground: Some("#eeeeee".into()),
                                font_style: Some("bold".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                        RawThemeSetting {
                            scope: Some(RawThemeScope::String("string.b".into())),
                            settings: Some(RawThemeStyle {
                                foreground: Some("#dddddd".into()),
                                font_style: Some("italic".into()),
                                ..RawThemeStyle::default()
                            }),
                            ..RawThemeSetting::default()
                        },
                    ],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );

        let provider = ThemeProvider::new(Theme::create_from_raw_theme(None, None).unwrap());
        provider.set_compiled_theme(Arc::clone(&light));
        let grammar = Grammar::with_theme_provider(
            &Arc::new(source),
            &GrammarStore::new(),
            provider.clone(),
            GrammarConfiguration::default(),
            crate::regexp::ScannerPatternCache::new(),
        )
        .unwrap();

        let line = "ab".repeat(200);
        let expected_light = grammar.tokenize_line2(&line, None, 0).unwrap().tokens;
        provider.set_compiled_theme(Arc::clone(&dark));
        let expected_dark = grammar.tokenize_line2(&line, None, 0).unwrap().tokens;
        assert_ne!(
            expected_light, expected_dark,
            "encoded binary metadata must differ so any mid-line theme mix fails"
        );

        let stop = AtomicBool::new(false);
        let themes = [Arc::clone(&light), Arc::clone(&dark)];
        std::thread::scope(|scope| {
            let switcher_provider = provider.clone();
            let switcher_light = Arc::clone(&light);
            let switcher_dark = Arc::clone(&dark);
            let stop_ref = &stop;
            let _handle = scope.spawn(move || {
                let mut toggle = false;
                while !stop_ref.load(Ordering::Acquire) {
                    switcher_provider.set_compiled_theme(if toggle {
                        Arc::clone(&switcher_light)
                    } else {
                        Arc::clone(&switcher_dark)
                    });
                    toggle = !toggle;
                }
            });
            let _stop_guard = StopOnDrop(&stop);

            for _ in 0..100 {
                let result = grammar
                    .tokenize_line_with_themes(&line, None, &themes, false, 0)
                    .unwrap();
                assert_eq!(result.binary_tokens[0], expected_light);
                assert_eq!(result.binary_tokens[1], expected_dark);
            }
        });
    }

    #[test]
    #[ignore = "explicit release-mode deep continuation benchmark for #389"]
    fn bench_deep_continuation_1char_lines() {
        use std::sync::Arc;
        use std::time::Instant;

        use crate::{RawThemeScope, RawThemeSetting, RawThemeStyle, SyncRegistry};

        let source = raw_grammar(
            r#"{
                "scopeName": "source.deep1c",
                "patterns": [
                    {
                        "begin": "\\(",
                        "end": "\\)",
                        "name": "meta.group",
                        "patterns": [{ "include": "$self" }]
                    },
                    { "match": "a", "name": "keyword.a" }
                ]
            }"#,
        );
        let light = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![RawThemeSetting {
                        scope: Some(RawThemeScope::String("keyword.a".into())),
                        settings: Some(RawThemeStyle {
                            foreground: Some("#aa0000".into()),
                            ..RawThemeStyle::default()
                        }),
                        ..RawThemeSetting::default()
                    }],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );
        let dark = Arc::new(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: vec![RawThemeSetting {
                        scope: Some(RawThemeScope::String("keyword.a".into())),
                        settings: Some(RawThemeStyle {
                            foreground: Some("#00aa00".into()),
                            font_style: Some("bold".into()),
                            ..RawThemeStyle::default()
                        }),
                        ..RawThemeSetting::default()
                    }],
                    ..RawTheme::default()
                }),
                None,
            )
            .unwrap(),
        );
        let mut registry = SyncRegistry::new(None, None).unwrap();
        registry.add_grammar(source, Vec::new());
        let grammar = registry
            .grammar_for_scope_name("source.deep1c", GrammarConfiguration::default())
            .unwrap()
            .unwrap();

        let open_line = "(".repeat(400);
        let lines = 10_000usize;
        let themes = [Arc::clone(&light), Arc::clone(&dark)];

        // Two sequential tokenize_line2 passes.
        let seq_start = Instant::now();
        for theme in &themes {
            registry.set_compiled_theme(Arc::clone(theme));
            let mut state = Some(
                grammar
                    .tokenize_line2(&open_line, None, 0)
                    .unwrap()
                    .rule_stack,
            );
            for _ in 0..lines {
                let res = grammar.tokenize_line2("a", state, 0).unwrap();
                std::hint::black_box(&res.tokens);
                state = Some(res.rule_stack);
            }
        }
        let seq_ms = seq_start.elapsed().as_secs_f64() * 1_000.0;

        // Single-pass tokenize_line_with_themes with O(1) Weak<ScopeStack> ancestry move.
        registry.set_compiled_theme(Arc::clone(&light));
        let multi_start = Instant::now();
        let mut state = Some(
            grammar
                .tokenize_line_with_themes(&open_line, None, &themes, false, 0)
                .unwrap()
                .rule_stack,
        );
        for _ in 0..lines {
            let res = grammar
                .tokenize_line_with_themes("a", state, &themes, false, 0)
                .unwrap();
            std::hint::black_box(&res.binary_tokens);
            state = Some(res.rule_stack);
        }
        let multi_ms = multi_start.elapsed().as_secs_f64() * 1_000.0;

        eprintln!("=== depth-400 x {lines} 1-char continuation lines ===");
        eprintln!("  2x sequential tokenize_line2:  {seq_ms:.2} ms");
        eprintln!(
            "  1x tokenize_line_with_themes:  {multi_ms:.2} ms ({:.2}x faster)",
            seq_ms / multi_ms
        );
    }

    #[test]
    fn new_rejects_overly_deep_scope_selector() {
        let deep_selector = format!("{}source.test{}", "(".repeat(200), ")".repeat(200));
        let source = serde_json::json!({
            "scopeName": "source.test",
            "patterns": [],
            "injections": {
                deep_selector: { "match": "x", "name": "keyword.x" }
            }
        })
        .to_string();
        let root = raw_grammar(&source);
        let err = Grammar::new(
            &root,
            &GrammarStore::new(),
            default_theme(),
            GrammarConfiguration::default(),
        )
        .err()
        .expect("Grammar::new must return Err on over-depth injection selector");
        assert!(matches!(err, crate::ThemeError::InvalidScopeSelector(_)));
        assert!(err.to_string().contains("depth limit"));
    }
}
