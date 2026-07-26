//! A mechanical Rust port of vscode-textmate's grammar interpreter.
//!
//! The module boundaries intentionally follow the pinned upstream source so
//! semantic changes remain reviewable against the oracle mirror.

pub mod matcher;
pub mod raw_grammar;

pub use matcher::{create_matchers, Matcher, MatcherPriority, MatcherWithPriority};
pub use raw_grammar::{Location, RawCaptures, RawGrammar, RawRepository, RawRule, RuleId};
