/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use crate::attributed_scope_stack::AttributedScopeStack;
use crate::basic_scope_attributes::{BasicScopeAttributes, BasicScopeAttributesProvider};
use crate::encoded_token_attributes::{
    EncodedTokenAttributes, OptionalStandardTokenType, StandardTokenType, to_optional_token_type,
};
use crate::matcher::{Matcher, MatcherError, create_matchers};
use crate::state_stack::StateStack;
use crate::theme::{FontStyle, ScopeStack, Theme};

#[derive(Clone)]
pub(crate) struct BalancedBracketSelectors {
    balanced_bracket_scopes: Vec<Matcher>,
    unbalanced_bracket_scopes: Vec<Matcher>,
    allow_any: bool,
}

impl BalancedBracketSelectors {
    pub(crate) fn new(
        balanced_bracket_scopes: &[String],
        unbalanced_bracket_scopes: &[String],
    ) -> Result<Self, MatcherError> {
        let mut allow_any = false;
        let mut balanced = Vec::new();
        for selector in balanced_bracket_scopes {
            if selector == "*" {
                allow_any = true;
            } else {
                balanced.extend(
                    create_matchers(selector)?
                        .into_iter()
                        .map(|matcher| matcher.matcher),
                );
            }
        }
        let mut unbalanced = Vec::new();
        for selector in unbalanced_bracket_scopes {
            unbalanced.extend(
                create_matchers(selector)?
                    .into_iter()
                    .map(|matcher| matcher.matcher),
            );
        }
        Ok(Self {
            balanced_bracket_scopes: balanced,
            unbalanced_bracket_scopes: unbalanced,
            allow_any,
        })
    }

    #[must_use]
    pub(crate) fn matches_always(&self) -> bool {
        self.allow_any && self.unbalanced_bracket_scopes.is_empty()
    }

    #[must_use]
    pub(crate) fn matches_never(&self) -> bool {
        self.balanced_bracket_scopes.is_empty() && !self.allow_any
    }

    #[must_use]
    pub(crate) fn matches(&self, scopes: &[String]) -> bool {
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
pub(crate) struct TokenTypeMatcher {
    pub matcher: Matcher,
    pub token_type: StandardTokenType,
}

impl TokenTypeMatcher {
    pub(crate) fn from_selector(
        selector: &str,
        token_type: StandardTokenType,
    ) -> Result<Vec<Self>, MatcherError> {
        Ok(create_matchers(selector)?
            .into_iter()
            .map(|matcher| Self {
                matcher: matcher.matcher,
                token_type,
            })
            .collect())
    }
}

/// A single unmerged TextMate scope token produced for a source line.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub struct Token {
    /// Inclusive UTF-16 code-unit start offset within the tokenized line.
    pub start_index: usize,
    /// Exclusive UTF-16 code-unit end offset within the tokenized line.
    pub end_index: usize,
    /// Ordered TextMate scope stack from root scope to innermost scope.
    pub scopes: Vec<String>,
}

/// Maximum surviving scope depth retained in `MultiThemeAncestry`. When active
/// depth exceeds this bound, we batch-trim down to `TRIMMED_CACHED_ANCESTRY_DEPTH`
/// so progressively growing continuations amortize index rebuilds across 512 lines.
const MAX_CACHED_ANCESTRY_DEPTH: usize = 1_024;
const TRIMMED_CACHED_ANCESTRY_DEPTH: usize = MAX_CACHED_ANCESTRY_DEPTH / 2;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct MultiThemeWalkStats {
    pub nodes_resolved: usize,
    pub fallback_walk_steps: usize,
    pub active_slot_reused: bool,
    pub trim_rebuilds: usize,
}

/// Returns true when `weak` refers to the exact live `Arc<ScopeStack>` `node`.
/// Because a live `Weak` keeps the `ArcInner` allocation address pinned until
/// all `Weak`s drop, pointer equality with `strong_count() > 0` is ABA-free.
#[inline]
fn weak_matches(weak: &Weak<ScopeStack>, node: &Arc<ScopeStack>) -> bool {
    std::ptr::eq(weak.as_ptr(), Arc::as_ptr(node)) && weak.strong_count() > 0
}

/// Reusable root-to-leaf scope ancestry and packed per-theme attributes carried
/// between consecutive continuation lines of a multi-theme scan.
///
/// Stores [`Weak`] references for themes and scope nodes so idle grammars never
/// keep superseded themes or scope chains alive, and moves directly into/out of
/// `MultiThemeTokens` in O(1) per line.
pub(crate) struct MultiThemeAncestry {
    resolved_themes: Vec<Weak<Theme>>,
    active_attrs: Vec<Vec<EncodedTokenAttributes>>,
    active_nodes: Vec<Weak<ScopeStack>>,
    active_node_index: HashMap<usize, usize>,
}

impl MultiThemeAncestry {
    #[cfg(test)]
    pub(crate) fn cached_node_count(&self) -> usize {
        self.active_nodes.len()
    }
}

pub(crate) struct MultiBinaryResult {
    pub binary_tokens: Vec<Vec<u32>>,
    pub ancestry: Option<MultiThemeAncestry>,
    #[cfg(test)]
    pub walk_stats: MultiThemeWalkStats,
}

struct MultiThemeSlot {
    theme: Arc<Theme>,
    default_attrs: EncodedTokenAttributes,
    binary_tokens: Vec<u32>,
    /// When true, `scopes.token_attributes` is guaranteed to be encoded with
    /// this slot's exact theme, so we reuse it directly without re-resolving
    /// the scope chain.
    reuse_active_attributes: bool,
    /// Full packed `EncodedTokenAttributes` aligned 1:1 with
    /// `MultiThemeTokens::active_nodes` (empty when `reuse_active_attributes`).
    /// Packing both grammar (`language_id`, `token_type`) and theme (`font_style`,
    /// `foreground`, `background`) fields via `EncodedTokenAttributes::set` at
    /// every scope matches `AttributedScopeStack` bit-for-bit.
    active_attrs: Vec<EncodedTokenAttributes>,
}

impl MultiThemeSlot {
    fn new(
        theme: Arc<Theme>,
        raw_default: BasicScopeAttributes,
        reuse_active_attributes: bool,
        active_attrs: Vec<EncodedTokenAttributes>,
    ) -> Self {
        let defaults = theme.get_defaults();
        let default_attrs = EncodedTokenAttributes::default().set(
            raw_default.language_id,
            raw_default.token_type,
            None,
            defaults.font_style,
            defaults.foreground_id,
            defaults.background_id,
        );
        Self {
            theme,
            default_attrs,
            binary_tokens: Vec::new(),
            reuse_active_attributes,
            active_attrs,
        }
    }

    fn push_scope(&mut self, scope: &ScopeStack, basic: BasicScopeAttributes) {
        let parent = self
            .active_attrs
            .last()
            .copied()
            .unwrap_or(self.default_attrs);
        let (font_style, foreground, background) = self
            .theme
            .match_scope_token_style(scope)
            .unwrap_or((FontStyle::NOT_SET, 0, 0));
        let next = parent.set(
            basic.language_id,
            basic.token_type,
            None,
            font_style,
            foreground,
            background,
        );
        self.active_attrs.push(next);
    }

    fn current_attrs(&self) -> EncodedTokenAttributes {
        self.active_attrs
            .last()
            .copied()
            .unwrap_or(self.default_attrs)
    }
}

struct MultiThemeTokens {
    slots: Vec<MultiThemeSlot>,
    mapping: Vec<usize>,
    has_non_active_slots: bool,
    basic_scope_attributes: Arc<BasicScopeAttributesProvider>,
    /// Active root-to-leaf `Weak<ScopeStack>` path for the most recently resolved
    /// token, moved O(1) into/out of `MultiThemeAncestry` across continuation lines
    /// without per-line upgrade/downgrade loops or strong retention of scope nodes.
    active_nodes: Vec<Weak<ScopeStack>>,
    /// Maps `active_nodes[i].as_ptr() as usize -> i` so the general walk stops
    /// immediately at the nearest shared ancestor in O(changed_depth).
    active_node_index: HashMap<usize, usize>,
    scratch: Vec<Arc<ScopeStack>>,
    #[cfg(test)]
    walk_stats: MultiThemeWalkStats,
}

impl MultiThemeTokens {
    fn new(
        themes: &[Arc<Theme>],
        basic_scope_attributes: Arc<BasicScopeAttributesProvider>,
        active_theme: Option<&Arc<Theme>>,
        cached: Option<MultiThemeAncestry>,
    ) -> Self {
        let mut unique_themes: Vec<Arc<Theme>> = Vec::with_capacity(themes.len());
        let mut mapping = Vec::with_capacity(themes.len());
        if themes.len() <= 4 {
            for theme in themes {
                if let Some(index) = unique_themes
                    .iter()
                    .position(|existing| Arc::ptr_eq(existing, theme))
                {
                    mapping.push(index);
                } else {
                    let index = unique_themes.len();
                    unique_themes.push(Arc::clone(theme));
                    mapping.push(index);
                }
            }
        } else {
            let mut seen = HashMap::with_capacity(themes.len());
            for theme in themes {
                let key = Arc::as_ptr(theme) as usize;
                let index = *seen.entry(key).or_insert_with(|| {
                    let index = unique_themes.len();
                    unique_themes.push(Arc::clone(theme));
                    index
                });
                mapping.push(index);
            }
        }

        let raw_default = basic_scope_attributes.default_attributes();
        let mut non_active_themes = Vec::with_capacity(unique_themes.len());
        let mut active_slot_reused = false;
        for theme in &unique_themes {
            if active_theme.is_some_and(|active| Arc::ptr_eq(active, theme)) {
                active_slot_reused = true;
            } else {
                non_active_themes.push(theme);
            }
        }
        let has_non_active_slots = !non_active_themes.is_empty();

        let cached = cached.filter(|ancestry| {
            has_non_active_slots
                && !ancestry.active_nodes.is_empty()
                && ancestry.resolved_themes.len() == non_active_themes.len()
                && ancestry
                    .resolved_themes
                    .iter()
                    .zip(non_active_themes.iter())
                    .all(|(cached_theme, incoming)| {
                        cached_theme
                            .upgrade()
                            .is_some_and(|theme| Arc::ptr_eq(&theme, incoming))
                    })
        });

        let (slots, active_nodes, active_node_index) = if let Some(ancestry) = cached {
            let mut cached_attrs = ancestry.active_attrs.into_iter();
            let slots = unique_themes
                .into_iter()
                .map(|theme| {
                    let reuse = active_theme.is_some_and(|active| Arc::ptr_eq(active, &theme));
                    let attrs = if reuse {
                        Vec::new()
                    } else {
                        cached_attrs.next().unwrap_or_default()
                    };
                    MultiThemeSlot::new(theme, raw_default, reuse, attrs)
                })
                .collect();
            (slots, ancestry.active_nodes, ancestry.active_node_index)
        } else {
            let slots = unique_themes
                .into_iter()
                .map(|theme| {
                    let reuse = active_theme.is_some_and(|active| Arc::ptr_eq(active, &theme));
                    MultiThemeSlot::new(theme, raw_default, reuse, Vec::new())
                })
                .collect();
            (slots, Vec::new(), HashMap::new())
        };

        #[cfg(not(test))]
        let _ = active_slot_reused;

        Self {
            slots,
            mapping,
            has_non_active_slots,
            basic_scope_attributes,
            active_nodes,
            active_node_index,
            scratch: Vec::new(),
            #[cfg(test)]
            walk_stats: MultiThemeWalkStats {
                active_slot_reused,
                ..MultiThemeWalkStats::default()
            },
        }
    }

    fn sync_active_scope(&mut self, scope_path: &Arc<ScopeStack>) {
        if !self.has_non_active_slots {
            return;
        }

        // Fast path 1: identical scope to previous token.
        if self
            .active_nodes
            .last()
            .is_some_and(|node| weak_matches(node, scope_path))
        {
            return;
        }

        // Fast path 2: direct child of current active scope.
        if scope_path.parent.as_ref().is_some_and(|parent| {
            self.active_nodes
                .last()
                .is_some_and(|node| weak_matches(node, parent))
        }) {
            let depth = self.active_nodes.len();
            self.active_node_index
                .insert(Arc::as_ptr(scope_path) as usize, depth);
            self.active_nodes.push(Arc::downgrade(scope_path));
            let basic = self
                .basic_scope_attributes
                .basic_scope_attributes(Some(&scope_path.scope_name));
            #[cfg(test)]
            {
                self.walk_stats.nodes_resolved += 1;
            }
            for slot in &mut self.slots {
                if !slot.reuse_active_attributes {
                    slot.push_scope(scope_path, basic);
                }
            }
            return;
        }

        // Fast path 3: pop directly back to parent scope.
        if self.active_nodes.len() >= 2
            && weak_matches(&self.active_nodes[self.active_nodes.len() - 2], scope_path)
        {
            if let Some(removed) = self.active_nodes.pop() {
                self.active_node_index.remove(&(removed.as_ptr() as usize));
            }
            for slot in &mut self.slots {
                if !slot.reuse_active_attributes {
                    slot.active_attrs.pop();
                }
            }
            return;
        }

        // Fast path 4: sibling replacement sharing the same immediate parent.
        if self.active_nodes.len() >= 2
            && scope_path.parent.as_ref().is_some_and(|parent| {
                weak_matches(&self.active_nodes[self.active_nodes.len() - 2], parent)
            })
        {
            if let Some(removed) = self.active_nodes.pop() {
                self.active_node_index.remove(&(removed.as_ptr() as usize));
            }
            let depth = self.active_nodes.len();
            self.active_node_index
                .insert(Arc::as_ptr(scope_path) as usize, depth);
            self.active_nodes.push(Arc::downgrade(scope_path));
            let basic = self
                .basic_scope_attributes
                .basic_scope_attributes(Some(&scope_path.scope_name));
            #[cfg(test)]
            {
                self.walk_stats.nodes_resolved += 1;
            }
            for slot in &mut self.slots {
                if !slot.reuse_active_attributes {
                    slot.active_attrs.pop();
                    slot.push_scope(scope_path, basic);
                }
            }
            return;
        }

        // General path: walk upward only until the nearest shared ancestor in
        // `active_node_index` (O(changed_depth)), drop completed nodes, and
        // resolve only the new suffix.
        self.scratch.clear();
        let mut prefix_len = 0;
        let mut current = Some(Arc::clone(scope_path));
        while let Some(node) = current {
            #[cfg(test)]
            {
                self.walk_stats.fallback_walk_steps += 1;
            }
            if let Some(&depth) = self.active_node_index.get(&(Arc::as_ptr(&node) as usize))
                && self
                    .active_nodes
                    .get(depth)
                    .is_some_and(|weak| weak_matches(weak, &node))
            {
                prefix_len = depth + 1;
                break;
            }
            let parent = node.parent.clone();
            self.scratch.push(node);
            current = parent;
        }
        self.scratch.reverse();

        for removed in self.active_nodes.drain(prefix_len..) {
            self.active_node_index.remove(&(removed.as_ptr() as usize));
        }
        for slot in &mut self.slots {
            if !slot.reuse_active_attributes {
                slot.active_attrs.truncate(prefix_len);
            }
        }
        for node in self.scratch.drain(..) {
            let depth = self.active_nodes.len();
            self.active_node_index
                .insert(Arc::as_ptr(&node) as usize, depth);
            self.active_nodes.push(Arc::downgrade(&node));
            let basic = self
                .basic_scope_attributes
                .basic_scope_attributes(Some(&node.scope_name));
            #[cfg(test)]
            {
                self.walk_stats.nodes_resolved += 1;
            }
            for slot in &mut self.slots {
                if !slot.reuse_active_attributes {
                    slot.push_scope(&node, basic);
                }
            }
        }
    }
}

pub(crate) struct LineTokens<'a> {
    emit_binary_tokens: bool,
    emit_scope_tokens: bool,
    tokens: Vec<Token>,
    binary_tokens: Vec<u32>,
    multi_theme: Option<MultiThemeTokens>,
    last_token_end_index: isize,
    token_type_overrides: &'a [TokenTypeMatcher],
    balanced_bracket_selectors: Option<&'a BalancedBracketSelectors>,
    always_balanced_brackets: bool,
    needs_scope_overrides: bool,
    merge_consecutive_tokens_with_equal_metadata: bool,
}

impl<'a> LineTokens<'a> {
    #[cfg(test)]
    #[must_use]
    pub(crate) fn new(
        emit_binary_tokens: bool,
        line_text: &str,
        token_type_overrides: &'a [TokenTypeMatcher],
        balanced_bracket_selectors: Option<&'a BalancedBracketSelectors>,
    ) -> Self {
        Self::new_with_ascii(
            emit_binary_tokens,
            line_text,
            line_text.is_ascii(),
            token_type_overrides,
            balanced_bracket_selectors,
        )
    }

    #[must_use]
    pub(crate) fn new_with_ascii(
        emit_binary_tokens: bool,
        line_text: &str,
        line_is_ascii: bool,
        token_type_overrides: &'a [TokenTypeMatcher],
        balanced_bracket_selectors: Option<&'a BalancedBracketSelectors>,
    ) -> Self {
        let always_balanced_brackets =
            balanced_bracket_selectors.is_some_and(BalancedBracketSelectors::matches_always);
        let needs_scope_overrides = !token_type_overrides.is_empty()
            || balanced_bracket_selectors
                .is_some_and(|selectors| !selectors.matches_always() && !selectors.matches_never());
        Self {
            emit_binary_tokens,
            emit_scope_tokens: !emit_binary_tokens,
            tokens: Vec::new(),
            binary_tokens: Vec::new(),
            multi_theme: None,
            last_token_end_index: 0,
            token_type_overrides,
            balanced_bracket_selectors,
            always_balanced_brackets,
            needs_scope_overrides,
            merge_consecutive_tokens_with_equal_metadata: line_is_ascii || !contains_rtl(line_text),
        }
    }

    /// Collect the upstream scope boundaries alongside binary metadata.
    pub(crate) fn with_scopes(mut self) -> Self {
        self.emit_scope_tokens = true;
        self
    }

    /// Collect binary metadata for multiple compiled themes in one scan.
    pub(crate) fn with_themes(
        mut self,
        themes: &[Arc<Theme>],
        include_scopes: bool,
        basic_scope_attributes: Arc<BasicScopeAttributesProvider>,
        active_theme: Option<&Arc<Theme>>,
        cached: Option<MultiThemeAncestry>,
    ) -> Self {
        self.emit_binary_tokens = false;
        self.emit_scope_tokens = include_scopes;
        self.multi_theme = Some(MultiThemeTokens::new(
            themes,
            basic_scope_attributes,
            active_theme,
            cached,
        ));
        self
    }

    pub(crate) fn produce(&mut self, stack: &StateStack, end_index: usize) {
        self.produce_from_scopes(stack.content_name_scopes_list.as_ref(), end_index);
    }

    pub(crate) fn produce_from_scopes(
        &mut self,
        scopes_list: Option<&Arc<AttributedScopeStack>>,
        end_index: usize,
    ) {
        if self.last_token_end_index >= end_index as isize {
            return;
        }

        if self.emit_scope_tokens {
            let scopes = scopes_list.map_or_else(Vec::new, |scopes| scopes.scope_names());
            self.tokens.push(Token {
                start_index: self.last_token_end_index.max(0) as usize,
                end_index,
                scopes,
            });
        }
        if self.emit_binary_tokens {
            self.produce_binary(scopes_list);
        }
        if self.multi_theme.is_some() {
            self.produce_multi_binary(scopes_list);
        }
        self.last_token_end_index = end_index as isize;
    }

    fn resolve_scope_metadata_overrides(
        &self,
        scopes_list: Option<&Arc<AttributedScopeStack>>,
    ) -> (OptionalStandardTokenType, bool) {
        if !self.needs_scope_overrides {
            return (
                OptionalStandardTokenType::NotSet,
                self.always_balanced_brackets,
            );
        }
        let mut override_token_type = OptionalStandardTokenType::NotSet;
        let mut contains_balanced_brackets = self.always_balanced_brackets;
        let scopes = scopes_list.map_or_else(Vec::new, |scopes| scopes.scope_names());
        let scope_slice = scopes.as_slice();
        for token_type in self.token_type_overrides {
            if token_type
                .matcher
                .matches(&scope_slice, &matches_scope_identifiers)
            {
                override_token_type = to_optional_token_type(token_type.token_type);
            }
        }
        if let Some(selectors) = self.balanced_bracket_selectors {
            contains_balanced_brackets = selectors.matches(&scopes);
        }
        (override_token_type, contains_balanced_brackets)
    }

    fn apply_scope_metadata_overrides(
        metadata: EncodedTokenAttributes,
        override_token_type: OptionalStandardTokenType,
        contains_balanced_brackets: bool,
    ) -> EncodedTokenAttributes {
        if override_token_type == OptionalStandardTokenType::NotSet && !contains_balanced_brackets {
            return metadata;
        }
        metadata.set(
            0,
            override_token_type,
            contains_balanced_brackets.then_some(true),
            FontStyle::NOT_SET,
            0,
            0,
        )
    }

    fn produce_binary(&mut self, scopes_list: Option<&Arc<AttributedScopeStack>>) {
        let (override_token_type, contains_balanced_brackets) =
            self.resolve_scope_metadata_overrides(scopes_list);
        let metadata = Self::apply_scope_metadata_overrides(
            scopes_list.map_or_else(EncodedTokenAttributes::default, |scopes| {
                scopes.token_attributes
            }),
            override_token_type,
            contains_balanced_brackets,
        );
        if self.merge_consecutive_tokens_with_equal_metadata
            && self.binary_tokens.last() == Some(&metadata.bits())
        {
            return;
        }

        self.binary_tokens
            .push(self.last_token_end_index.max(0) as u32);
        self.binary_tokens.push(metadata.bits());
    }

    fn produce_multi_binary(&mut self, scopes_list: Option<&Arc<AttributedScopeStack>>) {
        let (override_token_type, contains_balanced_brackets) =
            self.resolve_scope_metadata_overrides(scopes_list);
        let start_index = self.last_token_end_index.max(0) as u32;
        let merge = self.merge_consecutive_tokens_with_equal_metadata;
        let Some(multi) = self.multi_theme.as_mut() else {
            return;
        };
        if let Some(scopes) = scopes_list {
            multi.sync_active_scope(&scopes.scope_path);
        }
        for slot in &mut multi.slots {
            let base = match scopes_list {
                Some(scopes) if slot.reuse_active_attributes => scopes.token_attributes,
                Some(_) => slot.current_attrs(),
                None => EncodedTokenAttributes::default(),
            };
            let metadata_bits = Self::apply_scope_metadata_overrides(
                base,
                override_token_type,
                contains_balanced_brackets,
            )
            .bits();
            if merge && slot.binary_tokens.last() == Some(&metadata_bits) {
                continue;
            }
            slot.binary_tokens.push(start_index);
            slot.binary_tokens.push(metadata_bits);
        }
    }

    #[must_use]
    pub(crate) fn result(&mut self, stack: &StateStack, line_length: usize) -> Vec<Token> {
        if self
            .tokens
            .last()
            .is_some_and(|token| token.start_index == line_length.saturating_sub(1))
        {
            self.tokens.pop();
        }
        if self.tokens.is_empty() {
            // Finalize each output independently: an empty scope result must
            // not append to binary tokens that may already be finalized.
            self.tokens.push(Token {
                start_index: 0,
                end_index: line_length,
                scopes: stack
                    .content_name_scopes_list
                    .as_ref()
                    .map_or_else(Vec::new, |scopes| scopes.scope_names()),
            });
        }
        std::mem::take(&mut self.tokens)
    }

    #[must_use]
    pub(crate) fn binary_result(&mut self, stack: &StateStack, line_length: usize) -> Vec<u32> {
        if self.binary_tokens.len() >= 2
            && self.binary_tokens[self.binary_tokens.len() - 2]
                == line_length.saturating_sub(1) as u32
        {
            self.binary_tokens.truncate(self.binary_tokens.len() - 2);
        }
        if self.binary_tokens.is_empty() {
            self.last_token_end_index = -1;
            self.produce_binary(stack.content_name_scopes_list.as_ref());
            let start_index = self.binary_tokens.len() - 2;
            self.binary_tokens[start_index] = 0;
        }
        std::mem::take(&mut self.binary_tokens)
    }

    #[must_use]
    pub(crate) fn multi_binary_result(
        &mut self,
        stack: &StateStack,
        line_length: usize,
    ) -> MultiBinaryResult {
        let Some(mut multi) = self.multi_theme.take() else {
            return MultiBinaryResult {
                binary_tokens: Vec::new(),
                ancestry: None,
                #[cfg(test)]
                walk_stats: MultiThemeWalkStats::default(),
            };
        };
        let newline_start = line_length.saturating_sub(1) as u32;
        let scopes_list = stack.content_name_scopes_list.as_ref();
        let mut any_empty = false;

        for slot in &mut multi.slots {
            if slot.binary_tokens.len() >= 2
                && slot.binary_tokens[slot.binary_tokens.len() - 2] == newline_start
            {
                slot.binary_tokens.truncate(slot.binary_tokens.len() - 2);
            }
            if slot.binary_tokens.is_empty() {
                any_empty = true;
            }
        }

        if any_empty {
            let (override_token_type, contains_balanced_brackets) =
                self.resolve_scope_metadata_overrides(scopes_list);
            if let Some(scopes) = scopes_list {
                multi.sync_active_scope(&scopes.scope_path);
            }
            for slot in &mut multi.slots {
                if slot.binary_tokens.is_empty() {
                    let base = match scopes_list {
                        Some(scopes) if slot.reuse_active_attributes => scopes.token_attributes,
                        Some(_) => slot.current_attrs(),
                        None => EncodedTokenAttributes::default(),
                    };
                    let metadata_bits = Self::apply_scope_metadata_overrides(
                        base,
                        override_token_type,
                        contains_balanced_brackets,
                    )
                    .bits();
                    slot.binary_tokens.push(0);
                    slot.binary_tokens.push(metadata_bits);
                }
            }
        }

        let mut remaining_uses = vec![0usize; multi.slots.len()];
        for &slot_index in &multi.mapping {
            remaining_uses[slot_index] += 1;
        }
        let mut results = Vec::with_capacity(multi.mapping.len());
        for slot_index in multi.mapping {
            remaining_uses[slot_index] -= 1;
            if remaining_uses[slot_index] == 0 {
                results.push(std::mem::take(&mut multi.slots[slot_index].binary_tokens));
            } else {
                results.push(multi.slots[slot_index].binary_tokens.clone());
            }
        }

        // Retain nested ancestry whenever at least 2 scopes remain open. Moves
        // `active_nodes`, `active_node_index`, and `active_attrs` in O(1) unless
        // depth exceeds MAX_CACHED_ANCESTRY_DEPTH (batch-trimmed down to
        // TRIMMED_CACHED_ANCESTRY_DEPTH for amortized O(1) growth) or unwound
        // peak capacity exceeds 4x the retained length (shrink).
        let keep_ancestry = multi.has_non_active_slots && multi.active_nodes.len() > 1;
        let ancestry = if keep_ancestry {
            let trim_count = if multi.active_nodes.len() > MAX_CACHED_ANCESTRY_DEPTH {
                multi.active_nodes.len() - TRIMMED_CACHED_ANCESTRY_DEPTH
            } else {
                0
            };
            if trim_count > 0 {
                multi.active_nodes.drain(..trim_count);
                multi.active_node_index.clear();
                for (index, weak) in multi.active_nodes.iter().enumerate() {
                    multi
                        .active_node_index
                        .insert(weak.as_ptr() as usize, index);
                }
                #[cfg(test)]
                {
                    multi.walk_stats.trim_rebuilds += 1;
                }
            }
            let target_cap = multi.active_nodes.len().max(16);
            if multi.active_nodes.capacity() > target_cap * 4 {
                multi.active_nodes.shrink_to(target_cap);
            }
            if multi.active_node_index.capacity() > target_cap * 4 {
                multi.active_node_index.shrink_to(target_cap);
            }
            let mut resolved_themes = Vec::with_capacity(multi.slots.len());
            let mut active_attrs = Vec::with_capacity(multi.slots.len());
            for mut slot in multi.slots {
                if !slot.reuse_active_attributes {
                    if trim_count > 0 {
                        slot.active_attrs.drain(..trim_count);
                    }
                    if slot.active_attrs.capacity() > target_cap * 4 {
                        slot.active_attrs.shrink_to(target_cap);
                    }
                    resolved_themes.push(Arc::downgrade(&slot.theme));
                    active_attrs.push(slot.active_attrs);
                }
            }
            Some(MultiThemeAncestry {
                resolved_themes,
                active_attrs,
                active_nodes: multi.active_nodes,
                active_node_index: multi.active_node_index,
            })
        } else {
            None
        };
        MultiBinaryResult {
            binary_tokens: results,
            ancestry,
            #[cfg(test)]
            walk_stats: multi.walk_stats,
        }
    }
}

/// Font-family, font-size, and line-height overrides resolved from theme rules for a line span.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct FontInfo {
    /// Inclusive UTF-16 code-unit start offset within the tokenized line.
    pub start_index: usize,
    /// Exclusive UTF-16 code-unit end offset within the tokenized line.
    pub end_index: usize,
    /// Optional font family name override.
    pub font_family: Option<String>,
    /// Optional font size multiplier override.
    pub font_size_multiplier: Option<f64>,
    /// Optional line height multiplier override.
    pub line_height_multiplier: Option<f64>,
}

impl FontInfo {
    /// Returns `true` if `self` and `other` have identical font styling properties,
    /// ignoring `start_index` and `end_index`.
    #[must_use]
    pub fn options_equal(&self, other: &Self) -> bool {
        self.font_family == other.font_family
            && self.font_size_multiplier == other.font_size_multiplier
            && self.line_height_multiplier == other.line_height_multiplier
    }
}

#[derive(Default)]
pub(crate) struct LineFonts {
    fonts: Vec<FontInfo>,
    last_index: usize,
}

impl LineFonts {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn produce(&mut self, stack: &StateStack, end_index: usize) {
        self.produce_from_scopes(stack.content_name_scopes_list.as_ref(), end_index);
    }

    pub(crate) fn produce_from_scopes(
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
        // Kept nested to mirror the vscode-textmate original (ADR 0010); an
        // edition 2024 let-chain would read differently from the source.
        #[allow(clippy::collapsible_if)]
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
    pub(crate) fn result(&mut self) -> Vec<FontInfo> {
        std::mem::take(&mut self.fonts)
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
    if value.is_ascii() {
        return false;
    }
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
        let selectors = BalancedBracketSelectors::new(&["*".into()], &["comment".into()]).unwrap();

        assert!(!selectors.matches_always());
        assert!(!selectors.matches_never());
        assert!(selectors.matches(&["source.js".into()]));
        assert!(!selectors.matches(&["source.js".into(), "comment.block".into()]));

        let never = BalancedBracketSelectors::new(&[], &[]).unwrap();
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
        let mut tokens = LineTokens::new(false, "ab\n", &[], None);
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

        let mut ltr = LineTokens::new(true, "ab\n", &[], None);
        ltr.produce_from_scopes(Some(&scopes), 1);
        ltr.produce_from_scopes(Some(&scopes), 2);
        assert_eq!(ltr.binary_result(&stack, 3), [0, 1]);

        let mut rtl = LineTokens::new(true, "אb\n", &[], None);
        rtl.produce_from_scopes(Some(&scopes), 1);
        rtl.produce_from_scopes(Some(&scopes), 2);
        assert_eq!(rtl.binary_result(&stack, 3), [0, 1, 1, 1]);
    }

    #[test]
    fn combined_outputs_keep_scope_boundaries_and_finalize_independently() {
        let first = scopes(
            "source.test first",
            EncodedTokenAttributes::new(1),
            FontAttribute::default(),
        );
        let second = scopes(
            "source.test second",
            EncodedTokenAttributes::new(1),
            FontAttribute::default(),
        );
        let stack = state(Arc::clone(&second));
        for line in ["ab\n", "אb\n", "\n"] {
            for binary_first in [false, true] {
                let mut tokens = LineTokens::new(true, line, &[], None).with_scopes();
                let length = line.encode_utf16().count();
                if length > 1 {
                    tokens.produce_from_scopes(Some(&first), 1);
                    tokens.produce_from_scopes(Some(&second), 2);
                }
                tokens.produce_from_scopes(Some(&second), length);
                let (scoped, binary) = if binary_first {
                    let binary = tokens.binary_result(&stack, length);
                    (tokens.result(&stack, length), binary)
                } else {
                    let scoped = tokens.result(&stack, length);
                    (scoped, tokens.binary_result(&stack, length))
                };
                if length == 1 {
                    assert_eq!(scoped.len(), 1);
                    assert_eq!((scoped[0].start_index, scoped[0].end_index), (0, 1));
                    assert_eq!(scoped[0].scopes, ["source.test", "second"]);
                    assert_eq!(binary, [0, 1]);
                } else {
                    assert_eq!(scoped.len(), 2);
                    assert_eq!(scoped[0].scopes, ["source.test", "first"]);
                    assert_eq!(scoped[1].scopes, ["source.test", "second"]);
                    assert_eq!((scoped[1].start_index, scoped[1].end_index), (1, 2));
                    assert_eq!(
                        binary,
                        if line == "ab\n" {
                            vec![0, 1]
                        } else {
                            vec![0, 1, 1, 1]
                        }
                    );
                }
                assert!(tokens.tokens.is_empty());
                assert!(tokens.binary_tokens.is_empty());
            }
        }
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
        let overrides =
            TokenTypeMatcher::from_selector("meta.embedded", StandardTokenType::String).unwrap();
        let selectors = BalancedBracketSelectors::new(&["*".into()], &[]).unwrap();
        let mut tokens = LineTokens::new(true, "x\n", &overrides, Some(&selectors));
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

    #[test]
    fn multi_theme_scan_releases_completed_sibling_scopes_and_deduplicates_many_themes() {
        let theme_a = Arc::new(crate::Theme::create_from_raw_theme(None, None).unwrap());
        let theme_b = Arc::new(crate::Theme::create_from_raw_theme(None, None).unwrap());
        let theme_c = Arc::new(crate::Theme::create_from_raw_theme(None, None).unwrap());
        let theme_d = Arc::new(crate::Theme::create_from_raw_theme(None, None).unwrap());
        let theme_e = Arc::new(crate::Theme::create_from_raw_theme(None, None).unwrap());
        // >4 themes exercises the HashMap deduplication path with duplicates.
        let themes = [
            Arc::clone(&theme_a),
            Arc::clone(&theme_b),
            Arc::clone(&theme_c),
            Arc::clone(&theme_d),
            Arc::clone(&theme_e),
            Arc::clone(&theme_a),
            Arc::clone(&theme_c),
        ];

        let root = AttributedScopeStack::create_root(
            "source.test",
            EncodedTokenAttributes::default(),
            FontAttribute::default(),
        );
        let child = |name: &str| {
            Arc::new(AttributedScopeStack {
                parent: Some(Arc::clone(&root)),
                scope_path: crate::ScopeStack::push(Some(Arc::clone(&root.scope_path)), [name])
                    .unwrap(),
                token_attributes: EncodedTokenAttributes::default(),
                font_attributes: None,
            })
        };

        let basic_provider = Arc::new(crate::BasicScopeAttributesProvider::new(0, None));
        let mut line_tokens = LineTokens::new(false, "abab\n", &[], None).with_themes(
            &themes,
            false,
            Arc::clone(&basic_provider),
            None,
            None,
        );
        assert_eq!(line_tokens.multi_theme.as_ref().unwrap().slots.len(), 5);

        let first_sibling = child("keyword.a");
        let first_weak = Arc::downgrade(&first_sibling.scope_path);
        line_tokens.produce_from_scopes(Some(&first_sibling), 1);
        drop(first_sibling);
        // Active ancestry holds only Weak<ScopeStack>, so completed sibling
        // nodes are released as soon as the caller drops them.
        assert!(first_weak.upgrade().is_none());

        // Subsequent siblings stay bounded to depth 2.
        for index in 2..=100 {
            let next_sibling = child("keyword.b");
            line_tokens.produce_from_scopes(Some(&next_sibling), index);
            drop(next_sibling);
        }
        assert!(
            first_weak.upgrade().is_none(),
            "completed sibling ScopeStack must be dropped during the scan"
        );
        assert_eq!(
            line_tokens.multi_theme.as_ref().unwrap().active_nodes.len(),
            2
        );
        assert_eq!(
            line_tokens
                .multi_theme
                .as_ref()
                .unwrap()
                .active_node_index
                .len(),
            2
        );

        let stack = state(Arc::clone(&root));
        let multi_result = line_tokens.multi_binary_result(&stack, 101);
        assert!(multi_result.ancestry.is_some());
        assert_eq!(multi_result.binary_tokens.len(), themes.len());
        assert_eq!(multi_result.binary_tokens[0], multi_result.binary_tokens[5]);
        assert_eq!(multi_result.binary_tokens[2], multi_result.binary_tokens[6]);
    }

    #[test]
    fn compacts_or_drops_multi_theme_ancestry_after_deep_scope_unwinds() {
        let theme = Arc::new(crate::Theme::create_from_raw_theme(None, None).unwrap());
        let basic_provider = Arc::new(crate::BasicScopeAttributesProvider::new(0, None));

        let root = AttributedScopeStack::create_root(
            "source.test",
            EncodedTokenAttributes::default(),
            FontAttribute::default(),
        );
        let child = Arc::new(AttributedScopeStack {
            parent: Some(Arc::clone(&root)),
            scope_path: crate::ScopeStack::push(Some(Arc::clone(&root.scope_path)), ["meta.outer"])
                .unwrap(),
            token_attributes: EncodedTokenAttributes::default(),
            font_attributes: None,
        });
        let mut deep = Arc::clone(&child);
        for _ in 0..300 {
            deep = Arc::new(AttributedScopeStack {
                parent: Some(Arc::clone(&deep)),
                scope_path: crate::ScopeStack::push(
                    Some(Arc::clone(&deep.scope_path)),
                    ["meta.nested"],
                )
                .unwrap(),
                token_attributes: EncodedTokenAttributes::default(),
                font_attributes: None,
            });
        }

        // Unwinding from depth 302 down to depth 2 shrinks over-allocated capacities.
        let mut unwound = LineTokens::new(false, "ab\n", &[], None).with_themes(
            &[Arc::clone(&theme)],
            false,
            Arc::clone(&basic_provider),
            None,
            None,
        );
        unwound.produce_from_scopes(Some(&deep), 1);
        unwound.produce_from_scopes(Some(&child), 2);
        let ancestry = unwound
            .multi_binary_result(&state(Arc::clone(&child)), 3)
            .ancestry
            .expect("depth 2 retains compacted ancestry");
        assert_eq!(ancestry.active_nodes.len(), 2);
        assert!(ancestry.active_nodes.capacity() <= 64);
        assert!(ancestry.active_node_index.capacity() <= 64);
        assert!(ancestry.active_attrs[0].capacity() <= 64);

        // Unwinding all the way to depth 1 (root only) drops the ancestry entry.
        let mut root_only = LineTokens::new(false, "ab\n", &[], None).with_themes(
            &[Arc::clone(&theme)],
            false,
            basic_provider,
            None,
            None,
        );
        root_only.produce_from_scopes(Some(&deep), 1);
        root_only.produce_from_scopes(Some(&root), 2);
        let root_ancestry = root_only
            .multi_binary_result(&state(Arc::clone(&root)), 3)
            .ancestry;
        assert!(root_ancestry.is_none());

        // Dropping the caller's scopes must free the entire ScopeStack chain
        // even while `ancestry` is still retained.
        let root_weak = Arc::downgrade(&root.scope_path);
        drop(deep);
        drop(child);
        drop(root);
        assert!(
            root_weak.upgrade().is_none(),
            "MultiThemeAncestry must store Weak<ScopeStack> so prefix chains drop with the caller's stack"
        );
        assert_eq!(ancestry.active_nodes.len(), 2);
    }

    #[test]
    fn detects_rtl_with_ascii_fast_path() {
        assert!(!super::contains_rtl(""));
        assert!(!super::contains_rtl("const x = 42;\n"));
        assert!(!super::contains_rtl("café 日本語 🦀\n"));
        assert!(super::contains_rtl("hello שלום\n"));
        assert!(super::contains_rtl("مرحبا\n"));
        assert!(super::contains_rtl("a\u{200f}b\n"));
    }
}
