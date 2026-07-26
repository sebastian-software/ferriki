//! A mechanical Rust port of vscode-textmate's grammar interpreter.
//!
//! The module boundaries intentionally follow the pinned upstream source so
//! semantic changes remain reviewable against the oracle mirror.

pub mod include_reference;
pub mod matcher;
pub mod raw_grammar;
pub mod regexp;
pub mod rule;
pub mod theme;

pub use include_reference::{parse_include, IncludeReference};
pub use matcher::{create_matchers, Matcher, MatcherPriority, MatcherWithPriority};
pub use raw_grammar::{Location, RawCaptures, RawGrammar, RawRepository, RawRule, RuleId};
pub use regexp::{
    has_captures, replace_captures, CaptureIndex, CompiledRule, FindNextMatchResult, OnigString,
    RegExpSource, RegExpSourceList, ScannerFindOptions,
};
pub use rule::{
    BeginEndRule, BeginEndRuleOptions, BeginWhileRule, BeginWhileRuleOptions, CaptureRule,
    CompilePatternsResult, IncludeOnlyRule, MatchRule, Rule, RuleRegistry, RuleScannerId,
};
pub use theme::{
    font_style_to_string, parse_theme, FontStyle, ParsedThemeRule, RawTheme, RawThemeScope,
    RawThemeSetting, RawThemeStyle, ScopeStack, StyleAttributes, Theme, ThemeError,
};
