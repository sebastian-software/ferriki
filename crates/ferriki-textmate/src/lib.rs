//! A mechanical Rust port of vscode-textmate's grammar interpreter.
//!
//! The module boundaries intentionally follow the pinned upstream source so
//! semantic changes remain reviewable against the oracle mirror.

pub mod attributed_scope_stack;
pub mod basic_scope_attributes;
pub mod diff_state_stacks;
pub mod encoded_token_attributes;
pub mod grammar;
pub mod grammar_dependencies;
pub mod include_reference;
pub mod line_output;
pub mod matcher;
pub mod parse_raw_grammar;
pub mod plist;
pub mod raw_grammar;
pub mod regexp;
pub mod registry;
pub mod rule;
pub mod rule_factory;
pub mod state_stack;
pub mod theme;
pub mod tokenize_string;

pub use attributed_scope_stack::{
    AttributedScopeStack, AttributedScopeStackFrame, ScopeAttributesProvider,
    ScopeAttributesResolver,
};
pub use basic_scope_attributes::{
    BasicScopeAttributes, BasicScopeAttributesProvider, EmbeddedLanguages,
};
pub use diff_state_stacks::{StackDiff, apply_state_stack_diff, diff_state_stacks_ref_eq};
pub use encoded_token_attributes::{
    EncodedTokenAttributes, FontAttribute, OptionalStandardTokenType, StandardTokenType,
    to_optional_token_type,
};
pub use grammar::{Grammar, GrammarConfiguration, TokenizeLineResult, TokenizeLineResult2};
pub use grammar_dependencies::{
    AbsoluteRuleReference, GrammarDependencyError, ScopeDependencyProcessor,
};
pub use include_reference::{IncludeReference, parse_include};
pub use line_output::{
    BalancedBracketSelectors, FontInfo, LineFonts, LineTokens, Token, TokenTypeMatcher,
};
pub use matcher::{Matcher, MatcherPriority, MatcherWithPriority, create_matchers};
pub use parse_raw_grammar::{ParseRawGrammarError, parse_raw_grammar};
pub use plist::{PlistError, parse_plist};
pub use raw_grammar::{Location, RawCaptures, RawGrammar, RawRepository, RawRule, RuleId};
pub use regexp::{
    CaptureIndex, CompiledRule, FindNextMatchResult, OnigString, RegExpSource, RegExpSourceList,
    ScannerFindOptions, has_captures, replace_captures,
};
pub use registry::SyncRegistry;
pub use rule::{
    BeginEndRule, BeginEndRuleOptions, BeginWhileRule, BeginWhileRuleOptions, CaptureRule,
    CompilePatternsResult, IncludeOnlyRule, MatchRule, Rule, RuleRegistry, RuleScannerId,
};
pub use rule_factory::{GrammarProvider, GrammarStore, RuleFactory, initialize_grammar};
pub use state_stack::{StateStack, StateStackFrame};
pub use theme::{
    FontStyle, ParsedThemeRule, RawTheme, RawThemeScope, RawThemeSetting, RawThemeStyle,
    ScopeStack, StyleAttributes, Theme, ThemeError, font_style_to_string, parse_theme,
};
pub use tokenize_string::{Injection, TokenizeStringResult, TokenizerGrammar, tokenize_string};
