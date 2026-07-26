use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The internal identity assigned to a compiled rule.
///
/// This mirrors vscode-textmate's branded numeric `RuleId` without exposing a
/// plain integer at API boundaries.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RuleId(u32);

impl RuleId {
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

pub type RawRepository = BTreeMap<String, RawRule>;
pub type RawCaptures = BTreeMap<String, RawRule>;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawGrammar {
    #[serde(default)]
    pub repository: RawRepository,
    pub scope_name: String,
    #[serde(default)]
    pub patterns: Vec<RawRule>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub injections: BTreeMap<String, RawRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injection_selector: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_types: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_line_match: Option<String>,
    #[serde(
        default,
        rename = "$vscodeTextmateLocation",
        skip_serializing_if = "Option::is_none"
    )]
    pub location: Option<Location>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawRule {
    #[serde(skip)]
    pub id: Option<RuleId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_name: Option<String>,
    #[serde(default, rename = "match", skip_serializing_if = "Option::is_none")]
    pub match_pattern: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub captures: RawCaptures,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub begin: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub begin_captures: RawCaptures,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub end_captures: RawCaptures,
    #[serde(default, rename = "while", skip_serializing_if = "Option::is_none")]
    pub while_pattern: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub while_captures: RawCaptures,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub patterns: Vec<RawRule>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub repository: RawRepository,
    #[serde(default)]
    pub apply_end_pattern_last: bool,
    #[serde(
        default,
        rename = "$vscodeTextmateLocation",
        skip_serializing_if = "Option::is_none"
    )]
    pub location: Option<Location>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Location {
    pub filename: String,
    pub line: u32,
    #[serde(rename = "char")]
    pub character: u32,
}

#[cfg(test)]
mod tests {
    use super::{Location, RawGrammar};

    #[test]
    fn deserializes_upstream_field_names() {
        let grammar: RawGrammar = serde_json::from_str(
            r##"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "<",
                    "beginCaptures": {
                        "0": { "name": "punctuation.definition.tag" }
                    },
                    "while": ">",
                    "applyEndPatternLast": true,
                    "$vscodeTextmateLocation": {
                        "filename": "test.tmLanguage.json",
                        "line": 2,
                        "char": 4
                    }
                }],
                "repository": {}
            }"##,
        )
        .expect("raw grammar should deserialize");

        assert_eq!(grammar.scope_name, "source.test");
        assert_eq!(grammar.patterns[0].while_pattern.as_deref(), Some(">"));
        assert!(grammar.patterns[0].apply_end_pattern_last);
        assert_eq!(
            grammar.patterns[0].location,
            Some(Location {
                filename: "test.tmLanguage.json".into(),
                line: 2,
                character: 4,
            })
        );
    }
}
