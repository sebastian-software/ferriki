/// The pattern shape Ferroni identified as a possible source of excessive
/// backtracking.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[non_exhaustive]
pub enum BacktrackingRisk {
    /// An unbounded repeat nested inside another unbounded repeat.
    NestedQuantifier,
    /// Alternatives inside an unbounded repeat can match the same input.
    OverlappingAlternation,
}

/// An advisory finding from a regex scanner that Ferriki has compiled.
///
/// Findings are reported for scanners built during tokenization. Since grammar
/// scanners are compiled lazily, this list may not include patterns in rules
/// that have not been reached by tokenized input. This is not a complete
/// grammar lint.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub struct BacktrackingWarning {
    /// Scope name of the grammar that defined the rule.
    pub grammar_scope_name: String,
    /// TextMate rule name, or a per-grammar `rule #N` label when unnamed.
    pub rule: String,
    /// Source file and line and character, when the grammar loader supplied it.
    pub rule_location: Option<String>,
    /// Regex as written in the grammar. Backreferences may be resolved at
    /// runtime, so the checked regex can differ from this source pattern.
    pub pattern: String,
    /// The risk shape Ferroni identified.
    pub risk: BacktrackingRisk,
    /// Ferroni's explanation of the finding.
    pub message: String,
}

impl BacktrackingWarning {
    pub(crate) fn new(
        grammar_scope_name: String,
        rule: String,
        rule_location: Option<String>,
        pattern: String,
        risk: BacktrackingRisk,
        message: String,
    ) -> Self {
        Self {
            grammar_scope_name,
            rule,
            rule_location,
            pattern,
            risk,
            message,
        }
    }
}
