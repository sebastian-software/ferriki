//! A mechanical Rust port of vscode-textmate's grammar interpreter.
//!
//! The module boundaries intentionally follow the pinned upstream source so
//! semantic changes remain reviewable against the oracle mirror.

mod attributed_scope_stack;
mod backtracking;
mod basic_scope_attributes;
mod diff_state_stacks;
mod encoded_token_attributes;
mod grammar;
#[allow(
    dead_code,
    reason = "ported from vscode-textmate's asynchronous registry, which SyncRegistry does not use yet"
)]
mod grammar_dependencies;
mod grammar_fingerprint;
mod include_reference;
mod indexed_precompiled;
mod line_output;
mod matcher;
mod parse_raw_grammar;
mod plist;
mod precompiled;
#[cfg(test)]
mod precompiled_bench;
mod raw_grammar;
mod regex_mode;
mod regexp;
mod registry;
mod rule;
mod rule_factory;
mod state_stack;
mod theme;
mod tokenize_string;

// The public surface follows vscode-textmate's `main.ts` exports: a registry,
// grammars and their tokenize results, the rule stack, raw grammar and theme
// input, and token metadata, plus the combined-line output extension. Everything
// else is the mechanical port's internal
// structure and may change with any upstream sync.
pub use backtracking::{BacktrackingRisk, BacktrackingWarning};
pub use basic_scope_attributes::EmbeddedLanguages;
pub use encoded_token_attributes::{EncodedTokenAttributes, StandardTokenType};
pub use grammar::{
    Grammar, GrammarConfiguration, TokenizeLineResult, TokenizeLineResult2,
    TokenizeLineResultWithScopes, TokenizeLineResultWithThemes,
};
pub use indexed_precompiled::index_precompiled_patterns;
pub use line_output::{FontInfo, Token};
pub use parse_raw_grammar::{ParseRawGrammarError, parse_raw_grammar};
pub use plist::PlistError;
pub use precompiled::{
    PRECOMPILED_PATTERNS_VERSION, PrecompiledPatternsError, decompress_precompiled_patterns,
    precompile_grammar_patterns, supports_precompiled_patterns_version,
};
pub use raw_grammar::RawGrammar;
pub use regex_mode::{RegexDiagnostics, RegexMode};
pub use registry::SyncRegistry;
pub use state_stack::StateStack;
pub use theme::{
    FontStyle, RawTheme, RawThemeScope, RawThemeSetting, RawThemeStyle, Theme, ThemeError,
};

pub(crate) use raw_grammar::{Location, RuleId};
// Unit tests reach these through the crate root, as the upstream specs do.
#[cfg(test)]
pub(crate) use {
    attributed_scope_stack::{
        AttributedScopeStack, AttributedScopeStackFrame, ScopeAttributesProvider,
    },
    basic_scope_attributes::{BasicScopeAttributes, BasicScopeAttributesProvider},
    encoded_token_attributes::{FontAttribute, OptionalStandardTokenType},
    line_output::{LineFonts, LineTokens},
    regexp::OnigString,
    rule::{MatchRule, Rule, RuleRegistry, RuleScannerId},
    rule_factory::{GrammarStore, RuleFactory},
    theme::{ScopeStack, StyleAttributes},
};

/// Test support for the vscode-textmate oracle suite, exempt from semver
/// guarantees.
#[doc(hidden)]
pub mod __oracle {
    pub use crate::diff_state_stacks::{
        StackDiff, apply_state_stack_diff, diff_state_stacks_ref_eq,
    };
    pub use crate::rule_factory::{GrammarProvider, GrammarStore};
    pub use crate::theme::Theme;
}

/// A tokenizer regex or runtime guard failure, independent of the regex engine's API.
#[derive(Debug)]
pub struct RegexError {
    kind: RegexErrorKind,
}

#[derive(Debug)]
enum RegexErrorKind {
    Regex(ferroni::error::RegexError),
    DepthLimit(&'static str),
}

impl RegexError {
    pub(crate) fn new(source: ferroni::error::RegexError) -> Self {
        Self {
            kind: RegexErrorKind::Regex(source),
        }
    }

    pub(crate) fn depth_limit(message: &'static str) -> Self {
        Self {
            kind: RegexErrorKind::DepthLimit(message),
        }
    }
}
impl std::fmt::Display for RegexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.kind {
            RegexErrorKind::Regex(source) => source.fmt(f),
            RegexErrorKind::DepthLimit(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for RegexError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match &self.kind {
            RegexErrorKind::Regex(source) => Some(source),
            RegexErrorKind::DepthLimit(_) => None,
        }
    }
}

/// Version of the precompiled scanner archive format that
/// [`SyncRegistry::export_precompiled_patterns`] writes and
/// [`SyncRegistry::add_precompiled_patterns`] reads. It changes independently
/// of the crate version; an archive with another version is rejected.
pub const PRECOMPILED_PATTERNS_FORMAT_VERSION: u32 = ferroni::scanner::PRECOMPILED_FORMAT_VERSION;
