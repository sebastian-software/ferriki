use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use crate::grammar_fingerprint::SourceDigest;

/// The internal identity assigned to a compiled rule.
///
/// This mirrors vscode-textmate's branded numeric `RuleId` without exposing a
/// plain integer at API boundaries.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct RuleId(u32);

impl RuleId {
    pub(crate) const fn new(value: u32) -> Self {
        Self(value)
    }

    pub(crate) const fn get(self) -> u32 {
        self.0
    }
}

pub(crate) type RawRepository = BTreeMap<String, Arc<RawRule>>;
pub(crate) type RawCaptures = BTreeMap<String, Arc<RawRule>>;

/// Deserialized TextMate grammar definition produced by [`crate::parse_raw_grammar`].
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RawGrammar {
    #[serde(default, deserialize_with = "deserialize_raw_repository")]
    pub(crate) repository: RawRepository,
    /// Root TextMate scope name (for example `"source.rust"`).
    pub scope_name: String,
    #[serde(default)]
    pub(crate) patterns: Vec<Arc<RawRule>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) injections: BTreeMap<String, Arc<RawRule>>,
    /// Optional scope selector declaring where this grammar injects into host grammars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injection_selector: Option<String>,
    /// File extensions associated with this grammar.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_types: Vec<String>,
    /// Optional human-readable grammar name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Optional regular expression used to recognize the grammar from a file's first line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_line_match: Option<String>,
    #[serde(
        default,
        rename = "$vscodeTextmateLocation",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) location: Option<Location>,
    /// Ferriki: memoized source digest for state-snapshot fingerprints.
    #[serde(skip)]
    pub(crate) source_digest: SourceDigest,
}

impl RawGrammar {
    /// Enforces the 128-level scope-selector nesting depth limit on every
    /// selector carried by this grammar (`injectionSelector` and all
    /// `injections` keys).
    ///
    /// Matches upstream vscode-textmate's permissive selector parser rather
    /// than performing strict selector syntax validation.
    pub fn validate_scope_selector_depths(&self) -> Result<(), crate::ThemeError> {
        let invalid_selector = |error: crate::matcher::MatcherError| {
            crate::ThemeError::InvalidScopeSelector(error.to_string())
        };
        if let Some(selector) = self.injection_selector.as_deref() {
            crate::matcher::create_matchers(selector).map_err(invalid_selector)?;
        }
        for selector in self.injections.keys() {
            crate::matcher::create_matchers(selector).map_err(invalid_selector)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawRule {
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
    #[serde(
        default,
        deserialize_with = "deserialize_optional_raw_rule_map",
        skip_serializing_if = "Option::is_none"
    )]
    pub captures: Option<RawCaptures>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub begin: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_raw_rule_map",
        skip_serializing_if = "Option::is_none"
    )]
    pub begin_captures: Option<RawCaptures>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_raw_rule_map",
        skip_serializing_if = "Option::is_none"
    )]
    pub end_captures: Option<RawCaptures>,
    #[serde(default, rename = "while", skip_serializing_if = "Option::is_none")]
    pub while_pattern: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_raw_rule_map",
        skip_serializing_if = "Option::is_none"
    )]
    pub while_captures: Option<RawCaptures>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patterns: Option<Vec<Arc<RawRule>>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_raw_repository",
        skip_serializing_if = "Option::is_none"
    )]
    pub repository: Option<RawRepository>,
    #[serde(default, deserialize_with = "deserialize_bool_like")]
    pub apply_end_pattern_last: bool,
    #[serde(
        default,
        rename = "$vscodeTextmateLocation",
        skip_serializing_if = "Option::is_none"
    )]
    pub location: Option<Location>,
}

impl Drop for RawRule {
    fn drop(&mut self) {
        enum ChildIter {
            Vec(std::vec::IntoIter<Arc<RawRule>>),
            Map(std::collections::btree_map::IntoValues<String, Arc<RawRule>>),
        }

        fn push_children(rule: &mut RawRule, stack: &mut Vec<ChildIter>) {
            if let Some(patterns) = rule.patterns.take()
                && !patterns.is_empty()
            {
                stack.push(ChildIter::Vec(patterns.into_iter()));
            }
            for map in [
                rule.repository.take(),
                rule.captures.take(),
                rule.begin_captures.take(),
                rule.end_captures.take(),
                rule.while_captures.take(),
            ]
            .into_iter()
            .flatten()
            {
                if !map.is_empty() {
                    stack.push(ChildIter::Map(map.into_values()));
                }
            }
        }

        if self.patterns.is_none()
            && self.repository.is_none()
            && self.captures.is_none()
            && self.begin_captures.is_none()
            && self.end_captures.is_none()
            && self.while_captures.is_none()
        {
            return;
        }
        let mut stack = Vec::new();
        push_children(self, &mut stack);
        while let Some(top) = stack.last_mut() {
            let next = match top {
                ChildIter::Vec(iter) => iter.next(),
                ChildIter::Map(iter) => iter.next(),
            };
            let Some(child) = next else {
                stack.pop();
                continue;
            };
            if let Ok(mut inner) = Arc::try_unwrap(child) {
                push_children(&mut inner, &mut stack);
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct Location {
    pub filename: String,
    pub line: u32,
    #[serde(rename = "char")]
    pub character: u32,
}

fn deserialize_bool_like<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    struct BoolLikeVisitor;

    impl Visitor<'_> for BoolLikeVisitor {
        type Value = bool;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a boolean or numeric truth value")
        }

        fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
            Ok(value)
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
            Ok(value != 0)
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
            Ok(value != 0)
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(value != 0.0 && !value.is_nan())
        }
    }

    deserializer.deserialize_any(BoolLikeVisitor)
}

fn deserialize_optional_raw_rule_map<'de, D>(
    deserializer: D,
) -> Result<Option<RawCaptures>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    let Some(value) = value else { return Ok(None) };

    let values: Vec<(String, serde_json::Value)> = match value {
        serde_json::Value::Object(values) => values.into_iter().collect(),
        serde_json::Value::Array(values) => values
            .into_iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value))
            .collect(),
        value => {
            return Err(de::Error::custom(format!(
                "expected capture map or array, got {value}"
            )));
        }
    };

    values
        .into_iter()
        .filter_map(|(key, value)| value.is_object().then_some((key, value)))
        .map(|(key, value)| {
            serde_json::from_value(value)
                .map(|rule| (key, Arc::new(rule)))
                .map_err(de::Error::custom)
        })
        .collect::<Result<RawCaptures, _>>()
        .map(Some)
}

fn deserialize_raw_repository<'de, D>(deserializer: D) -> Result<RawRepository, D::Error>
where
    D: Deserializer<'de>,
{
    let values = BTreeMap::<String, serde_json::Value>::deserialize(deserializer)?;
    values
        .into_iter()
        .map(|(key, value)| deserialize_repository_entry(key, value).map_err(de::Error::custom))
        .collect()
}

fn deserialize_optional_raw_repository<'de, D>(
    deserializer: D,
) -> Result<Option<RawRepository>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<BTreeMap<String, serde_json::Value>>::deserialize(deserializer)?
        .map(|values| {
            values
                .into_iter()
                .map(|(key, value)| {
                    deserialize_repository_entry(key, value).map_err(de::Error::custom)
                })
                .collect()
        })
        .transpose()
}

fn deserialize_repository_entry(
    key: String,
    value: serde_json::Value,
) -> Result<(String, Arc<RawRule>), serde_json::Error> {
    let rule = match value {
        serde_json::Value::Object(_) => serde_json::from_value(value)?,
        serde_json::Value::Array(values) => {
            let mut rule = RawRule::default();
            rule.patterns = Some(
                values
                    .into_iter()
                    .map(serde_json::from_value)
                    .collect::<Result<Vec<Arc<RawRule>>, _>>()?,
            );
            rule
        }
        value => {
            return Err(serde_json::Error::io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("repository entry {key} must be an object or array, got {value}"),
            )));
        }
    };
    Ok((key, Arc::new(rule)))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

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

    #[test]
    fn preserves_absent_and_explicitly_empty_rule_fields() {
        let grammar: RawGrammar = serde_json::from_str(
            r##"{
                "scopeName": "source.test",
                "patterns": [
                    { "include": "#implicit" },
                    {
                        "patterns": [],
                        "captures": {},
                        "beginCaptures": {},
                        "endCaptures": {},
                        "whileCaptures": {},
                        "repository": {}
                    }
                ]
            }"##,
        )
        .expect("raw grammar should deserialize");

        let implicit = &grammar.patterns[0];
        assert!(implicit.patterns.is_none());
        assert!(implicit.captures.is_none());
        assert!(implicit.repository.is_none());

        let explicit = &grammar.patterns[1];
        assert_eq!(explicit.patterns.as_deref(), Some(&[][..]));
        assert!(explicit.captures.as_ref().is_some_and(BTreeMap::is_empty));
        assert!(
            explicit
                .begin_captures
                .as_ref()
                .is_some_and(BTreeMap::is_empty)
        );
        assert!(
            explicit
                .end_captures
                .as_ref()
                .is_some_and(BTreeMap::is_empty)
        );
        assert!(
            explicit
                .while_captures
                .as_ref()
                .is_some_and(BTreeMap::is_empty)
        );
        assert!(explicit.repository.as_ref().is_some_and(BTreeMap::is_empty));

        let cloned = grammar.clone();
        assert!(Arc::ptr_eq(&grammar.patterns[0], &cloned.patterns[0]));
    }

    #[test]
    fn accepts_numeric_apply_end_pattern_last_values() {
        let grammar: RawGrammar = serde_json::from_str(
            r#"{
                "scopeName": "source.test",
                "patterns": [
                    { "applyEndPatternLast": 1 },
                    { "applyEndPatternLast": 0 }
                ]
            }"#,
        )
        .unwrap();

        assert!(grammar.patterns[0].apply_end_pattern_last);
        assert!(!grammar.patterns[1].apply_end_pattern_last);
    }

    #[test]
    fn ignores_non_rule_metadata_in_capture_maps() {
        let grammar: RawGrammar = serde_json::from_str(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "<%--",
                    "captures": {
                        "0": { "name": "punctuation.definition.comment" },
                        "end": "--%>",
                        "name": "comment.block"
                    }
                }]
            }"#,
        )
        .unwrap();

        let captures = grammar.patterns[0].captures.as_ref().unwrap();
        assert_eq!(captures.len(), 1);
        assert_eq!(
            captures["0"].name.as_deref(),
            Some("punctuation.definition.comment")
        );
    }

    #[test]
    fn accepts_legacy_capture_arrays() {
        let grammar: RawGrammar = serde_json::from_str(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "match": "x",
                    "captures": [
                        { "name": "punctuation.definition.begin" },
                        null,
                        { "name": "punctuation.definition.end" }
                    ]
                }]
            }"#,
        )
        .unwrap();

        let captures = grammar.patterns[0].captures.as_ref().unwrap();
        assert_eq!(
            captures["0"].name.as_deref(),
            Some("punctuation.definition.begin")
        );
        assert!(!captures.contains_key("1"));
        assert_eq!(
            captures["2"].name.as_deref(),
            Some("punctuation.definition.end")
        );
    }

    #[test]
    fn accepts_repository_rule_arrays() {
        let grammar: RawGrammar = serde_json::from_str(
            r#"{
                "scopeName": "source.test",
                "repository": {
                    "alternatives": [
                        { "match": "a", "name": "keyword.a" },
                        { "match": "b", "name": "keyword.b" }
                    ]
                }
            }"#,
        )
        .unwrap();

        let alternatives = grammar.repository["alternatives"]
            .patterns
            .as_ref()
            .unwrap();
        assert_eq!(alternatives.len(), 2);
        assert_eq!(alternatives[0].name.as_deref(), Some("keyword.a"));
        assert_eq!(alternatives[1].name.as_deref(), Some("keyword.b"));
    }
}
