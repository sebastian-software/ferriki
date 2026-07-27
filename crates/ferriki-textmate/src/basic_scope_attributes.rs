/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use crate::encoded_token_attributes::OptionalStandardTokenType;

pub type EmbeddedLanguages = BTreeMap<String, u32>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BasicScopeAttributes {
    pub language_id: u32,
    pub token_type: OptionalStandardTokenType,
}

impl BasicScopeAttributes {
    const NULL_SCOPE: Self = Self {
        language_id: 0,
        token_type: OptionalStandardTokenType::Other,
    };
}

pub struct BasicScopeAttributesProvider {
    default_attributes: BasicScopeAttributes,
    embedded_languages_matcher: ScopeMatcher,
    cache: Mutex<HashMap<String, BasicScopeAttributes>>,
}

impl BasicScopeAttributesProvider {
    #[must_use]
    pub fn new(initial_language_id: u32, embedded_languages: Option<&EmbeddedLanguages>) -> Self {
        Self {
            default_attributes: BasicScopeAttributes {
                language_id: initial_language_id,
                token_type: OptionalStandardTokenType::NotSet,
            },
            embedded_languages_matcher: ScopeMatcher::new(
                embedded_languages.into_iter().flat_map(BTreeMap::iter),
            ),
            cache: Mutex::new(HashMap::new()),
        }
    }

    #[must_use]
    pub const fn default_attributes(&self) -> BasicScopeAttributes {
        self.default_attributes
    }

    #[must_use]
    pub fn basic_scope_attributes(&self, scope_name: Option<&str>) -> BasicScopeAttributes {
        let Some(scope_name) = scope_name else {
            return BasicScopeAttributes::NULL_SCOPE;
        };
        if let Some(cached) = self
            .cache
            .lock()
            .expect("basic scope attribute cache lock poisoned")
            .get(scope_name)
            .copied()
        {
            return cached;
        }

        let attributes = BasicScopeAttributes {
            language_id: self
                .embedded_languages_matcher
                .matches(scope_name)
                .unwrap_or(0),
            token_type: standard_token_type(scope_name),
        };
        self.cache
            .lock()
            .expect("basic scope attribute cache lock poisoned")
            .insert(scope_name.to_owned(), attributes);
        attributes
    }
}

struct ScopeMatcher {
    values: Vec<(String, u32)>,
}

impl ScopeMatcher {
    fn new<'a>(values: impl IntoIterator<Item = (&'a String, &'a u32)>) -> Self {
        let mut values: Vec<_> = values
            .into_iter()
            .map(|(scope_name, value)| (scope_name.clone(), *value))
            .collect();
        values.sort_by(|left, right| right.0.cmp(&left.0));
        Self { values }
    }

    fn matches(&self, scope: &str) -> Option<u32> {
        self.values.iter().find_map(|(scope_name, value)| {
            let remainder = scope.strip_prefix(scope_name)?;
            (remainder.is_empty() || remainder.starts_with('.')).then_some(*value)
        })
    }
}

fn standard_token_type(scope_name: &str) -> OptionalStandardTokenType {
    const TOKEN_TYPES: [(&str, OptionalStandardTokenType); 4] = [
        ("comment", OptionalStandardTokenType::Comment),
        ("string", OptionalStandardTokenType::String),
        ("regex", OptionalStandardTokenType::RegEx),
        ("meta.embedded", OptionalStandardTokenType::Other),
    ];

    TOKEN_TYPES
        .iter()
        .filter_map(|(pattern, token_type)| {
            scope_name
                .match_indices(pattern)
                .find(|(index, matched)| {
                    has_word_boundary_before(scope_name, *index)
                        && has_word_boundary_after(scope_name, *index + matched.len())
                })
                .map(|(index, _)| (index, *token_type))
        })
        .min_by_key(|(index, _)| *index)
        .map_or(OptionalStandardTokenType::NotSet, |(_, token_type)| {
            token_type
        })
}

fn has_word_boundary_before(value: &str, index: usize) -> bool {
    index == 0
        || value
            .as_bytes()
            .get(index - 1)
            .is_none_or(|byte| !is_word_byte(*byte))
}

fn has_word_boundary_after(value: &str, index: usize) -> bool {
    value
        .as_bytes()
        .get(index)
        .is_none_or(|byte| !is_word_byte(*byte))
}

const fn is_word_byte(value: u8) -> bool {
    value.is_ascii_alphanumeric() || value == b'_'
}

#[cfg(test)]
mod tests {
    use super::{BasicScopeAttributes, BasicScopeAttributesProvider, EmbeddedLanguages};
    use crate::OptionalStandardTokenType;

    #[test]
    fn returns_default_and_null_scope_attributes() {
        let provider = BasicScopeAttributesProvider::new(7, None);

        assert_eq!(
            provider.default_attributes(),
            BasicScopeAttributes {
                language_id: 7,
                token_type: OptionalStandardTokenType::NotSet,
            }
        );
        assert_eq!(
            provider.basic_scope_attributes(None),
            BasicScopeAttributes {
                language_id: 0,
                token_type: OptionalStandardTokenType::Other,
            }
        );
    }

    #[test]
    fn identifies_standard_token_types_at_word_boundaries() {
        let provider = BasicScopeAttributesProvider::new(1, None);

        for (scope, expected) in [
            (
                "comment.block.documentation",
                OptionalStandardTokenType::Comment,
            ),
            ("quoted.string", OptionalStandardTokenType::String),
            ("source.regex.group", OptionalStandardTokenType::RegEx),
            ("meta.embedded.block.html", OptionalStandardTokenType::Other),
        ] {
            assert_eq!(
                provider.basic_scope_attributes(Some(scope)).token_type,
                expected
            );
        }
        for scope in ["comments", "stringify", "regexes", "meta.embeddedness"] {
            assert_eq!(
                provider.basic_scope_attributes(Some(scope)).token_type,
                OptionalStandardTokenType::NotSet
            );
        }
    }

    #[test]
    fn chooses_the_most_specific_embedded_language_scope() {
        let embedded_languages =
            EmbeddedLanguages::from([("source.ts".into(), 1), ("source.ts.embedded".into(), 2)]);
        let provider = BasicScopeAttributesProvider::new(9, Some(&embedded_languages));

        assert_eq!(
            provider
                .basic_scope_attributes(Some("source.ts.embedded.html"))
                .language_id,
            2
        );
        assert_eq!(
            provider
                .basic_scope_attributes(Some("source.ts.type"))
                .language_id,
            1
        );
        assert_eq!(
            provider
                .basic_scope_attributes(Some("source.tsx"))
                .language_id,
            0
        );
    }
}
