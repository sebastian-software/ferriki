/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::sync::Arc;

use crate::attributed_scope_stack::AttributedScopeStack;
use crate::encoded_token_attributes::{
    to_optional_token_type, EncodedTokenAttributes, OptionalStandardTokenType, StandardTokenType,
};
use crate::matcher::{create_matchers, Matcher};
use crate::state_stack::StateStack;
use crate::theme::FontStyle;

#[derive(Clone)]
pub struct BalancedBracketSelectors {
    balanced_bracket_scopes: Vec<Matcher>,
    unbalanced_bracket_scopes: Vec<Matcher>,
    allow_any: bool,
}

impl BalancedBracketSelectors {
    #[must_use]
    pub fn new(balanced_bracket_scopes: &[String], unbalanced_bracket_scopes: &[String]) -> Self {
        let mut allow_any = false;
        let balanced_bracket_scopes = balanced_bracket_scopes
            .iter()
            .flat_map(|selector| {
                if selector == "*" {
                    allow_any = true;
                    Vec::new()
                } else {
                    create_matchers(selector)
                        .into_iter()
                        .map(|matcher| matcher.matcher)
                        .collect()
                }
            })
            .collect();
        let unbalanced_bracket_scopes = unbalanced_bracket_scopes
            .iter()
            .flat_map(|selector| {
                create_matchers(selector)
                    .into_iter()
                    .map(|matcher| matcher.matcher)
            })
            .collect();
        Self {
            balanced_bracket_scopes,
            unbalanced_bracket_scopes,
            allow_any,
        }
    }

    #[must_use]
    pub fn matches_always(&self) -> bool {
        self.allow_any && self.unbalanced_bracket_scopes.is_empty()
    }

    #[must_use]
    pub fn matches_never(&self) -> bool {
        self.balanced_bracket_scopes.is_empty() && !self.allow_any
    }

    #[must_use]
    pub fn matches(&self, scopes: &[String]) -> bool {
        if self
            .unbalanced_bracket_scopes
            .iter()
            .any(|matcher| matcher.matches(&scopes, &matches_scope_identifiers))
        {
            return false;
        }
        self.balanced_bracket_scopes
            .iter()
            .any(|matcher| matcher.matches(&scopes, &matches_scope_identifiers))
            || self.allow_any
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenTypeMatcher {
    pub matcher: Matcher,
    pub token_type: StandardTokenType,
}

impl TokenTypeMatcher {
    #[must_use]
    pub fn from_selector(selector: &str, token_type: StandardTokenType) -> Vec<Self> {
        create_matchers(selector)
            .into_iter()
            .map(|matcher| Self {
                matcher: matcher.matcher,
                token_type,
            })
            .collect()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Token {
    pub start_index: usize,
    pub end_index: usize,
    pub scopes: Vec<String>,
}

pub struct LineTokens {
    emit_binary_tokens: bool,
    tokens: Vec<Token>,
    binary_tokens: Vec<u32>,
    last_token_end_index: isize,
    token_type_overrides: Vec<TokenTypeMatcher>,
    balanced_bracket_selectors: Option<BalancedBracketSelectors>,
    merge_consecutive_tokens_with_equal_metadata: bool,
}

impl LineTokens {
    #[must_use]
    pub fn new(
        emit_binary_tokens: bool,
        line_text: &str,
        token_type_overrides: Vec<TokenTypeMatcher>,
        balanced_bracket_selectors: Option<BalancedBracketSelectors>,
    ) -> Self {
        Self {
            emit_binary_tokens,
            tokens: Vec::new(),
            binary_tokens: Vec::new(),
            last_token_end_index: 0,
            token_type_overrides,
            balanced_bracket_selectors,
            merge_consecutive_tokens_with_equal_metadata: !contains_rtl(line_text),
        }
    }

    pub fn produce(&mut self, stack: &StateStack, end_index: usize) {
        self.produce_from_scopes(stack.content_name_scopes_list.as_ref(), end_index);
    }

    pub fn produce_from_scopes(
        &mut self,
        scopes_list: Option<&Arc<AttributedScopeStack>>,
        end_index: usize,
    ) {
        if self.last_token_end_index >= end_index as isize {
            return;
        }

        if self.emit_binary_tokens {
            self.produce_binary(scopes_list, end_index);
        } else {
            let scopes = scopes_list.map_or_else(Vec::new, |scopes| scopes.scope_names());
            self.tokens.push(Token {
                start_index: self.last_token_end_index.max(0) as usize,
                end_index,
                scopes,
            });
            self.last_token_end_index = end_index as isize;
        }
    }

    fn produce_binary(
        &mut self,
        scopes_list: Option<&Arc<AttributedScopeStack>>,
        end_index: usize,
    ) {
        let mut metadata = scopes_list.map_or_else(EncodedTokenAttributes::default, |scopes| {
            scopes.token_attributes
        });
        let mut contains_balanced_brackets = self
            .balanced_bracket_selectors
            .as_ref()
            .is_some_and(BalancedBracketSelectors::matches_always);
        let needs_scopes = !self.token_type_overrides.is_empty()
            || self
                .balanced_bracket_selectors
                .as_ref()
                .is_some_and(|selectors| !selectors.matches_always() && !selectors.matches_never());

        if needs_scopes {
            let scopes = scopes_list.map_or_else(Vec::new, |scopes| scopes.scope_names());
            let scope_slice = scopes.as_slice();
            for token_type in &self.token_type_overrides {
                if token_type
                    .matcher
                    .matches(&scope_slice, &matches_scope_identifiers)
                {
                    metadata = metadata.set(
                        0,
                        to_optional_token_type(token_type.token_type),
                        None,
                        FontStyle::NOT_SET,
                        0,
                        0,
                    );
                }
            }
            if let Some(selectors) = self.balanced_bracket_selectors.as_ref() {
                contains_balanced_brackets = selectors.matches(&scopes);
            }
        }

        if contains_balanced_brackets {
            metadata = metadata.set(
                0,
                OptionalStandardTokenType::NotSet,
                Some(true),
                FontStyle::NOT_SET,
                0,
                0,
            );
        }
        if self.merge_consecutive_tokens_with_equal_metadata
            && self.binary_tokens.last() == Some(&metadata.bits())
        {
            self.last_token_end_index = end_index as isize;
            return;
        }

        self.binary_tokens
            .push(self.last_token_end_index.max(0) as u32);
        self.binary_tokens.push(metadata.bits());
        self.last_token_end_index = end_index as isize;
    }

    #[must_use]
    pub fn result(&mut self, stack: &StateStack, line_length: usize) -> Vec<Token> {
        if self
            .tokens
            .last()
            .is_some_and(|token| token.start_index == line_length.saturating_sub(1))
        {
            self.tokens.pop();
        }
        if self.tokens.is_empty() {
            self.last_token_end_index = -1;
            self.produce(stack, line_length);
            self.tokens
                .last_mut()
                .expect("fallback token must be produced")
                .start_index = 0;
        }
        std::mem::take(&mut self.tokens)
    }

    #[must_use]
    pub fn binary_result(&mut self, stack: &StateStack, line_length: usize) -> Vec<u32> {
        if self.binary_tokens.len() >= 2
            && self.binary_tokens[self.binary_tokens.len() - 2]
                == line_length.saturating_sub(1) as u32
        {
            self.binary_tokens.truncate(self.binary_tokens.len() - 2);
        }
        if self.binary_tokens.is_empty() {
            self.last_token_end_index = -1;
            self.produce(stack, line_length);
            let start_index = self.binary_tokens.len() - 2;
            self.binary_tokens[start_index] = 0;
        }
        std::mem::take(&mut self.binary_tokens)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FontInfo {
    pub start_index: usize,
    pub end_index: usize,
    pub font_family: Option<String>,
    pub font_size_multiplier: Option<f64>,
    pub line_height_multiplier: Option<f64>,
}

impl FontInfo {
    #[must_use]
    pub fn options_equal(&self, other: &Self) -> bool {
        self.font_family == other.font_family
            && self.font_size_multiplier == other.font_size_multiplier
            && self.line_height_multiplier == other.line_height_multiplier
    }
}

#[derive(Default)]
pub struct LineFonts {
    fonts: Vec<FontInfo>,
    last_index: usize,
}

impl LineFonts {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn produce(&mut self, stack: &StateStack, end_index: usize) {
        self.produce_from_scopes(stack.content_name_scopes_list.as_ref(), end_index);
    }

    pub fn produce_from_scopes(
        &mut self,
        scopes_list: Option<&Arc<AttributedScopeStack>>,
        end_index: usize,
    ) {
        let Some(font_attributes) = scopes_list.and_then(|scopes| scopes.font_attributes.as_ref())
        else {
            self.last_index = end_index;
            return;
        };
        let has_font_family = font_attributes
            .font_family
            .as_ref()
            .is_some_and(|family| !family.is_empty());
        let has_font_size = font_attributes.font_size.is_some_and(is_truthy_number);
        let has_line_height = font_attributes.line_height.is_some_and(is_truthy_number);
        if !has_font_family && !has_font_size && !has_line_height {
            self.last_index = end_index;
            return;
        }

        let font = FontInfo {
            start_index: self.last_index,
            end_index,
            font_family: font_attributes.font_family.clone(),
            font_size_multiplier: font_attributes.font_size,
            line_height_multiplier: font_attributes.line_height,
        };
        if let Some(last_font) = self.fonts.last_mut() {
            if last_font.end_index == self.last_index && last_font.options_equal(&font) {
                last_font.end_index = font.end_index;
                self.last_index = end_index;
                return;
            }
        }
        self.fonts.push(font);
        self.last_index = end_index;
    }

    #[must_use]
    pub fn result(&self) -> Vec<FontInfo> {
        self.fonts.clone()
    }
}

fn matches_scope_identifiers(identifiers: &[String], scopes: &&[String]) -> bool {
    if scopes.len() < identifiers.len() {
        return false;
    }
    let mut last_index = 0;
    identifiers.iter().all(|identifier| {
        for (index, scope) in scopes.iter().enumerate().skip(last_index) {
            if scope_matches(scope, identifier) {
                last_index = index + 1;
                return true;
            }
        }
        false
    })
}

fn scope_matches(scope_name: &str, scope_pattern: &str) -> bool {
    scope_name == scope_pattern
        || scope_name
            .strip_prefix(scope_pattern)
            .is_some_and(|remainder| remainder.starts_with('.'))
}

const fn is_truthy_number(value: f64) -> bool {
    value != 0.0 && !value.is_nan()
}

fn contains_rtl(value: &str) -> bool {
    value.chars().any(|character| {
        matches!(
            character,
            '\u{05be}'
                | '\u{05c0}'
                | '\u{05c3}'
                | '\u{05c6}'
                | '\u{05d0}'..='\u{05f4}'
                | '\u{0608}'
                | '\u{060b}'
                | '\u{060d}'
                | '\u{061b}'..='\u{064a}'
                | '\u{066d}'..='\u{066f}'
                | '\u{0671}'..='\u{06d5}'
                | '\u{06e5}'
                | '\u{06e6}'
                | '\u{06ee}'
                | '\u{06ef}'
                | '\u{06fa}'..='\u{0710}'
                | '\u{0712}'..='\u{072f}'
                | '\u{074d}'..='\u{07a5}'
                | '\u{07b1}'..='\u{07ea}'
                | '\u{07f4}'
                | '\u{07f5}'
                | '\u{07fa}'
                | '\u{07fe}'..='\u{0815}'
                | '\u{081a}'
                | '\u{0824}'
                | '\u{0828}'
                | '\u{0830}'..='\u{0858}'
                | '\u{085e}'..='\u{088e}'
                | '\u{08a0}'..='\u{08c9}'
                | '\u{200f}'
                | '\u{fb1d}'
                | '\u{fb1f}'..='\u{fb28}'
                | '\u{fb2a}'..='\u{fd3d}'
                | '\u{fd50}'..='\u{fdc7}'
                | '\u{fdf0}'..='\u{fdfc}'
                | '\u{fe70}'..='\u{fefc}'
                | '\u{10800}'..='\u{1091b}'
                | '\u{10920}'..='\u{10a00}'
                | '\u{10a10}'..='\u{10a35}'
                | '\u{10a40}'..='\u{10ae4}'
                | '\u{10aeb}'..='\u{10b35}'
                | '\u{10b40}'..='\u{10bff}'
                | '\u{10c00}'..='\u{10d23}'
                | '\u{10e80}'..='\u{10ea9}'
                | '\u{10ead}'..='\u{10f45}'
                | '\u{10f51}'..='\u{10f81}'
                | '\u{10f86}'..='\u{10ff6}'
                | '\u{1e800}'..='\u{1e8cf}'
                | '\u{1e900}'..='\u{1e943}'
                | '\u{1e94b}'..='\u{1ebff}'
                | '\u{1ec00}'..='\u{1eebb}'
        )
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{BalancedBracketSelectors, LineFonts, LineTokens, TokenTypeMatcher};
    use crate::{
        AttributedScopeStack, EncodedTokenAttributes, FontAttribute, FontStyle,
        OptionalStandardTokenType, RuleId, StandardTokenType, StateStack,
    };

    fn scopes(
        names: &str,
        metadata: EncodedTokenAttributes,
        font: FontAttribute,
    ) -> Arc<AttributedScopeStack> {
        let mut scopes =
            AttributedScopeStack::create_root(names.split(' ').next().unwrap(), metadata, font);
        for name in names.split(' ').skip(1) {
            scopes = Arc::new(AttributedScopeStack {
                parent: Some(Arc::clone(&scopes)),
                scope_path: crate::ScopeStack::push(Some(Arc::clone(&scopes.scope_path)), [name])
                    .unwrap(),
                token_attributes: metadata,
                font_attributes: scopes.font_attributes.clone(),
                style_attributes: None,
            });
        }
        scopes
    }

    fn state(scopes: Arc<AttributedScopeStack>) -> Arc<StateStack> {
        StateStack::new(
            None,
            RuleId::new(1),
            0,
            0,
            false,
            None,
            Some(Arc::clone(&scopes)),
            Some(scopes),
        )
    }

    #[test]
    fn matches_balanced_and_unbalanced_scope_selectors() {
        let selectors = BalancedBracketSelectors::new(&["*".into()], &["comment".into()]);

        assert!(!selectors.matches_always());
        assert!(!selectors.matches_never());
        assert!(selectors.matches(&["source.js".into()]));
        assert!(!selectors.matches(&["source.js".into(), "comment.block".into()]));

        let never = BalancedBracketSelectors::new(&[], &[]);
        assert!(never.matches_never());
    }

    #[test]
    fn emits_text_tokens_and_removes_the_newline_token() {
        let scopes = scopes(
            "source.test word",
            EncodedTokenAttributes::new(1),
            FontAttribute::default(),
        );
        let stack = state(Arc::clone(&scopes));
        let mut tokens = LineTokens::new(false, "ab\n", Vec::new(), None);
        tokens.produce_from_scopes(Some(&scopes), 2);
        tokens.produce_from_scopes(Some(&scopes), 3);

        let result = tokens.result(&stack, 3);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].start_index, 0);
        assert_eq!(result[0].end_index, 2);
        assert_eq!(result[0].scopes, ["source.test", "word"]);
    }

    #[test]
    fn merges_binary_tokens_but_preserves_boundaries_for_rtl_lines() {
        let metadata = EncodedTokenAttributes::new(1);
        let scopes = scopes("source.test", metadata, FontAttribute::default());
        let stack = state(Arc::clone(&scopes));

        let mut ltr = LineTokens::new(true, "ab\n", Vec::new(), None);
        ltr.produce_from_scopes(Some(&scopes), 1);
        ltr.produce_from_scopes(Some(&scopes), 2);
        assert_eq!(ltr.binary_result(&stack, 3), [0, 1]);

        let mut rtl = LineTokens::new(true, "אb\n", Vec::new(), None);
        rtl.produce_from_scopes(Some(&scopes), 1);
        rtl.produce_from_scopes(Some(&scopes), 2);
        assert_eq!(rtl.binary_result(&stack, 3), [0, 1, 1, 1]);
    }

    #[test]
    fn applies_token_type_and_balanced_bracket_overrides() {
        let metadata = EncodedTokenAttributes::default().set(
            1,
            OptionalStandardTokenType::Comment,
            None,
            FontStyle::NONE,
            1,
            2,
        );
        let scopes = scopes(
            "source.test meta.embedded",
            metadata,
            FontAttribute::default(),
        );
        let stack = state(Arc::clone(&scopes));
        let overrides = TokenTypeMatcher::from_selector("meta.embedded", StandardTokenType::String);
        let selectors = BalancedBracketSelectors::new(&["*".into()], &[]);
        let mut tokens = LineTokens::new(true, "x\n", overrides, Some(selectors));
        tokens.produce_from_scopes(Some(&scopes), 1);

        let result = tokens.binary_result(&stack, 2);
        let result = EncodedTokenAttributes::new(result[1]);
        assert_eq!(result.token_type(), StandardTokenType::String);
        assert!(result.contains_balanced_brackets());
    }

    #[test]
    fn merges_adjacent_font_runs_and_tracks_unstyled_gaps() {
        let plain = scopes(
            "source.test",
            EncodedTokenAttributes::default(),
            FontAttribute::from(Some(String::new()), Some(0.0), Some(0.0)),
        );
        let styled = scopes(
            "source.test styled",
            EncodedTokenAttributes::default(),
            FontAttribute::from(Some("Mono".into()), Some(1.2), Some(3.0)),
        );
        let mut fonts = LineFonts::new();
        fonts.produce_from_scopes(Some(&plain), 2);
        fonts.produce_from_scopes(Some(&styled), 4);
        fonts.produce_from_scopes(Some(&styled), 6);

        assert_eq!(
            fonts.result(),
            [super::FontInfo {
                start_index: 2,
                end_index: 6,
                font_family: Some("Mono".into()),
                font_size_multiplier: Some(1.2),
                line_height_multiplier: Some(3.0),
            }]
        );
    }
}
