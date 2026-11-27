/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Theme parsing, inheritance, and scope matching.
//!
//! This module follows vscode-textmate's `theme.ts` data flow and ordering.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::ops::{BitOr, BitOrAssign};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, OnceLock, RwLock};

use serde::{Deserialize, Serialize};

use crate::encoded_token_attributes::{MAX_BACKGROUND_COLOR_ID, MAX_FOREGROUND_COLOR_ID};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RawTheme {
    pub name: Option<String>,
    #[serde(default)]
    pub settings: Vec<RawThemeSetting>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RawThemeSetting {
    pub name: Option<String>,
    pub scope: Option<RawThemeScope>,
    pub settings: Option<RawThemeStyle>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RawThemeScope {
    String(String),
    Array(Vec<String>),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RawThemeStyle {
    pub font_style: Option<String>,
    pub foreground: Option<String>,
    pub background: Option<String>,
    pub font_family: Option<String>,
    pub font_size: Option<f64>,
    pub line_height: Option<f64>,
}

/// TextMate font style bits. Serializes as its integer value; `NOT_SET` is `-1`.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FontStyle(i32);

impl FontStyle {
    pub const NOT_SET: Self = Self(-1);
    pub const NONE: Self = Self(0);
    pub const ITALIC: Self = Self(1);
    pub const BOLD: Self = Self(2);
    pub const UNDERLINE: Self = Self(4);
    pub const STRIKETHROUGH: Self = Self(8);

    #[must_use]
    pub const fn from_bits(value: i32) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn bits(self) -> i32 {
        self.0
    }

    #[must_use]
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 != 0
    }
}

impl BitOr for FontStyle {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl BitOrAssign for FontStyle {
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

#[must_use]
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "ported from vscode-textmate; used by the theme specs"
    )
)]
pub(crate) fn font_style_to_string(font_style: FontStyle) -> String {
    if font_style == FontStyle::NOT_SET {
        return "not set".to_owned();
    }

    let mut styles = Vec::new();
    if font_style.contains(FontStyle::ITALIC) {
        styles.push("italic");
    }
    if font_style.contains(FontStyle::BOLD) {
        styles.push("bold");
    }
    if font_style.contains(FontStyle::UNDERLINE) {
        styles.push("underline");
    }
    if font_style.contains(FontStyle::STRIKETHROUGH) {
        styles.push("strikethrough");
    }
    if styles.is_empty() {
        return "none".to_owned();
    }
    styles.join(" ")
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ParsedThemeRule {
    pub scope: String,
    pub parent_scopes: Option<Vec<String>>,
    pub index: i32,
    pub font_style: FontStyle,
    pub foreground: Option<String>,
    pub background: Option<String>,
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StyleAttributes {
    pub font_style: FontStyle,
    pub foreground_id: u32,
    pub background_id: u32,
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
}

#[derive(Debug)]
pub(crate) struct ScopeStack {
    pub parent: Option<Arc<Self>>,
    pub scope_name: Arc<str>,
}

impl ScopeStack {
    #[must_use]
    pub(crate) fn push<I, S>(mut path: Option<Arc<Self>>, scope_names: I) -> Option<Arc<Self>>
    where
        I: IntoIterator<Item = S>,
        S: Into<Arc<str>>,
    {
        for scope_name in scope_names {
            path = Some(Arc::new(Self {
                parent: path,
                scope_name: scope_name.into(),
            }));
        }
        path
    }

    #[must_use]
    pub(crate) fn push_arc(self: &Arc<Self>, scope_name: Arc<str>) -> Arc<Self> {
        Arc::new(Self {
            parent: Some(Arc::clone(self)),
            scope_name,
        })
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn from<I, S>(segments: I) -> Option<Arc<Self>>
    where
        I: IntoIterator<Item = S>,
        S: Into<Arc<str>>,
    {
        Self::push(None, segments)
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn push_scope(self: &Arc<Self>, scope_name: impl Into<Arc<str>>) -> Arc<Self> {
        self.push_arc(scope_name.into())
    }

    #[must_use]
    pub(crate) fn get_segments(&self) -> Vec<String> {
        let mut item = Some(self);
        let mut result = Vec::new();
        while let Some(scope) = item {
            result.push((*scope.scope_name).to_owned());
            item = scope.parent.as_deref();
        }
        result.reverse();
        result
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn extends(self: &Arc<Self>, other: &Arc<Self>) -> bool {
        let mut current = Some(self);
        while let Some(scope) = current {
            if Arc::ptr_eq(scope, other) {
                return true;
            }
            current = scope.parent.as_ref();
        }
        false
    }

    #[must_use]
    pub(crate) fn get_extension_if_defined(
        self: &Arc<Self>,
        base: Option<&Arc<Self>>,
    ) -> Option<Vec<String>> {
        let mut result = Vec::new();
        let mut item = Some(self);

        while let Some(scope) = item {
            if base.is_some_and(|base| Arc::ptr_eq(scope, base)) {
                break;
            }
            result.push((*scope.scope_name).to_owned());
            item = scope.parent.as_ref();
        }

        let reached_base = match (item, base) {
            (None, None) => true,
            (Some(item), Some(base)) => Arc::ptr_eq(item, base),
            _ => false,
        };
        if !reached_base {
            return None;
        }

        result.reverse();
        Some(result)
    }
}

impl Drop for ScopeStack {
    fn drop(&mut self) {
        let mut parent = self.parent.take();
        while let Some(node) = parent {
            parent = Arc::try_unwrap(node)
                .ok()
                .and_then(|mut inner| inner.parent.take());
        }
    }
}

impl fmt::Display for ScopeStack {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.get_segments().join(" "))
    }
}

impl RawTheme {
    /// Sets the theme name.
    #[must_use]
    pub fn with_name(mut self, value: Option<String>) -> Self {
        self.name = value;
        self
    }

    /// Sets the token color rules.
    #[must_use]
    pub fn with_settings(mut self, value: Vec<RawThemeSetting>) -> Self {
        self.settings = value;
        self
    }
}

impl RawThemeSetting {
    /// Sets the rule name.
    #[must_use]
    pub fn with_name(mut self, value: Option<String>) -> Self {
        self.name = value;
        self
    }

    /// Sets the scope selector; `None` makes this the default rule.
    #[must_use]
    pub fn with_scope(mut self, value: Option<RawThemeScope>) -> Self {
        self.scope = value;
        self
    }

    /// Sets the style this rule applies.
    #[must_use]
    pub fn with_settings(mut self, value: Option<RawThemeStyle>) -> Self {
        self.settings = value;
        self
    }
}

impl RawThemeStyle {
    /// Sets the space-separated font style, such as `"italic bold"`.
    #[must_use]
    pub fn with_font_style(mut self, value: Option<String>) -> Self {
        self.font_style = value;
        self
    }

    /// Sets the foreground color.
    #[must_use]
    pub fn with_foreground(mut self, value: Option<String>) -> Self {
        self.foreground = value;
        self
    }

    /// Sets the background color.
    #[must_use]
    pub fn with_background(mut self, value: Option<String>) -> Self {
        self.background = value;
        self
    }

    /// Sets the font family.
    #[must_use]
    pub fn with_font_family(mut self, value: Option<String>) -> Self {
        self.font_family = value;
        self
    }

    /// Sets the font size multiplier.
    #[must_use]
    pub fn with_font_size(mut self, value: Option<f64>) -> Self {
        self.font_size = value;
        self
    }

    /// Sets the line height multiplier.
    #[must_use]
    pub fn with_line_height(mut self, value: Option<f64>) -> Self {
        self.line_height = value;
        self
    }
}

#[derive(Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum ThemeError {
    MissingFrozenColor(String),
    InvalidScopeSelector(String),
    ColorMapOverflow {
        color: String,
        id: u32,
        max_id: u32,
    },
    InvalidLanguageId {
        language_id: u32,
        max_language_id: u32,
    },
}

impl fmt::Display for ThemeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingFrozenColor(color) => {
                write!(formatter, "missing color in color map - {color}")
            }
            Self::InvalidScopeSelector(message) => {
                write!(formatter, "invalid scope selector - {message}")
            }
            Self::ColorMapOverflow { color, id, max_id } => {
                write!(
                    formatter,
                    "color map capacity exceeded for {color}: color id {id} exceeds maximum encodable id {max_id}"
                )
            }
            Self::InvalidLanguageId {
                language_id,
                max_language_id,
            } => {
                write!(
                    formatter,
                    "language id {language_id} exceeds maximum encodable id {max_language_id}"
                )
            }
        }
    }
}

impl std::error::Error for ThemeError {}

/// Maximum number of exact scope-name entries retained in `Theme::cached_match_root`.
/// Capture-derived dynamic scope names cannot grow a long-lived cached theme past
/// this bound; misses still hit per-node pre-sorted rules on the static trie.
const MAX_CACHED_SCOPE_MATCHES: usize = 4_096;

/// Scope names longer than this threshold bypass `cached_match_root` and resolve
/// directly against the static trie's per-node rule cache.
const MAX_CACHED_SCOPE_NAME_BYTES: usize = 256;

/// Monotonic non-zero identity assigned to each compiled [`Theme`].
static NEXT_THEME_ID: AtomicU64 = AtomicU64::new(1);

/// A compiled TextMate theme trie, color map, and thread-safe scope-match cache.
///
/// Compile once with [`Self::create_from_raw_theme`] and share across
/// [`crate::SyncRegistry::set_compiled_theme`] or
/// [`crate::Grammar::tokenize_line_with_themes`] without rebuilding the trie.
pub struct Theme {
    id: u64,
    color_map: ColorMap,
    defaults: StyleAttributes,
    root: ThemeTrieElement,
    cached_match_root: RwLock<HashMap<String, Arc<[ThemeTrieElementRule]>>>,
}

impl fmt::Debug for Theme {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Theme")
            .field("colors", &self.color_map.as_slice().len())
            .finish_non_exhaustive()
    }
}

impl Theme {
    pub fn create_from_raw_theme(
        source: Option<&RawTheme>,
        color_map: Option<Vec<String>>,
    ) -> Result<Self, ThemeError> {
        Self::create_from_parsed_theme(parse_theme(source), color_map)
    }

    pub(crate) fn create_from_parsed_theme(
        source: Vec<ParsedThemeRule>,
        color_map: Option<Vec<String>>,
    ) -> Result<Self, ThemeError> {
        resolve_parsed_theme_rules(source, color_map)
    }

    #[must_use]
    pub(crate) fn get_color_map(&self) -> Vec<String> {
        self.color_map.get_color_map()
    }

    /// Borrows the resolved color table indexed by encoded foreground/background IDs.
    #[must_use]
    pub fn color_map(&self) -> &[String] {
        self.color_map.as_slice()
    }

    #[must_use]
    pub(crate) const fn id(&self) -> u64 {
        self.id
    }

    #[must_use]
    pub(crate) const fn get_defaults(&self) -> &StyleAttributes {
        &self.defaults
    }

    #[cfg(test)]
    #[must_use]
    pub(crate) fn cached_match_count(&self) -> usize {
        self.cached_match_root
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    fn cached_scope_rules(&self, scope_name: &str) -> Arc<[ThemeTrieElementRule]> {
        if scope_name.len() > MAX_CACHED_SCOPE_NAME_BYTES {
            return self.root.match_scope(scope_name);
        }
        if let Ok(cache) = self.cached_match_root.read()
            && let Some(rules) = cache.get(scope_name)
        {
            return Arc::clone(rules);
        }
        let rules = self.root.match_scope(scope_name);
        {
            let mut cache = self.cached_match_root.write().unwrap_or_else(|poisoned| {
                let mut guard = poisoned.into_inner();
                guard.clear();
                self.cached_match_root.clear_poison();
                guard
            });
            if !cache.contains_key(scope_name) {
                if cache.len() >= MAX_CACHED_SCOPE_MATCHES {
                    cache.clear();
                }
                cache.insert(scope_name.to_owned(), Arc::clone(&rules));
            }
        }
        rules
    }

    #[must_use]
    pub(crate) fn match_scope_token_style(
        &self,
        scope_path: &ScopeStack,
    ) -> Option<(FontStyle, u32, u32)> {
        let matching_trie_elements = self.cached_scope_rules(&scope_path.scope_name);
        let effective_rule = matching_trie_elements.iter().find(|rule| {
            scope_path_matches_parent_scopes(scope_path.parent.as_deref(), &rule.parent_scopes)
        })?;
        Some((
            effective_rule.font_style,
            effective_rule.foreground,
            effective_rule.background,
        ))
    }

    #[must_use]
    pub(crate) fn match_scope(&self, scope_path: Option<&ScopeStack>) -> Option<StyleAttributes> {
        let Some(scope_path) = scope_path else {
            return Some(self.defaults.clone());
        };

        let matching_trie_elements = self.cached_scope_rules(&scope_path.scope_name);
        let effective_rule = matching_trie_elements.iter().find(|rule| {
            scope_path_matches_parent_scopes(scope_path.parent.as_deref(), &rule.parent_scopes)
        })?;

        Some(StyleAttributes {
            font_style: effective_rule.font_style,
            foreground_id: effective_rule.foreground,
            background_id: effective_rule.background,
            font_family: effective_rule.font_family.clone(),
            font_size: effective_rule.font_size,
            line_height: effective_rule.line_height,
        })
    }
}

#[must_use]
pub(crate) fn parse_theme(source: Option<&RawTheme>) -> Vec<ParsedThemeRule> {
    let Some(source) = source else {
        return Vec::new();
    };

    let mut result = Vec::new();
    for (index, entry) in source.settings.iter().enumerate() {
        let Some(settings) = entry.settings.as_ref() else {
            continue;
        };

        let scopes = match entry.scope.as_ref() {
            Some(RawThemeScope::String(scope)) => scope
                .trim_matches(',')
                .split(',')
                .map(str::to_owned)
                .collect(),
            Some(RawThemeScope::Array(scopes)) => scopes.clone(),
            None => vec![String::new()],
        };

        let font_style = settings
            .font_style
            .as_deref()
            .map_or(FontStyle::NOT_SET, parse_font_style);
        let foreground = settings
            .foreground
            .as_ref()
            .filter(|color| is_valid_hex_color(color))
            .cloned();
        let background = settings
            .background
            .as_ref()
            .filter(|color| is_valid_hex_color(color))
            .cloned();
        let font_family = settings.font_family.clone().unwrap_or_default();
        let font_size = settings.font_size.unwrap_or_default();
        let line_height = settings.line_height.unwrap_or_default();

        for scope in scopes {
            let trimmed_scope = scope.trim();
            let mut segments: Vec<_> = trimmed_scope.split(' ').collect();
            let scope = segments.pop().unwrap_or_default().to_owned();
            let parent_scopes = if segments.is_empty() {
                None
            } else {
                segments.reverse();
                Some(segments.into_iter().map(str::to_owned).collect())
            };

            result.push(ParsedThemeRule {
                scope,
                parent_scopes,
                index: i32::try_from(index).unwrap_or(i32::MAX),
                font_style,
                foreground: foreground.clone(),
                background: background.clone(),
                font_family: font_family.clone(),
                font_size,
                line_height,
            });
        }
    }
    result
}

fn parse_font_style(value: &str) -> FontStyle {
    let mut font_style = FontStyle::NONE;
    for segment in value.split(' ') {
        match segment {
            "italic" => font_style |= FontStyle::ITALIC,
            "bold" => font_style |= FontStyle::BOLD,
            "underline" => font_style |= FontStyle::UNDERLINE,
            "strikethrough" => font_style |= FontStyle::STRIKETHROUGH,
            _ => {}
        }
    }
    font_style
}

fn is_valid_hex_color(color: &str) -> bool {
    matches!(color.len(), 4 | 5 | 7 | 9)
        && color.starts_with('#')
        && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn scope_path_matches_parent_scopes(
    mut scope_path: Option<&ScopeStack>,
    parent_scopes: &[String],
) -> bool {
    if parent_scopes.is_empty() {
        return true;
    }

    let mut index = 0;
    while index < parent_scopes.len() {
        let mut scope_pattern = parent_scopes[index].as_str();
        let mut scope_must_match = false;

        if scope_pattern == ">" {
            if index == parent_scopes.len() - 1 {
                return false;
            }
            index += 1;
            scope_pattern = &parent_scopes[index];
            scope_must_match = true;
        }

        while let Some(scope) = scope_path {
            if matches_scope(&scope.scope_name, scope_pattern) {
                break;
            }
            if scope_must_match {
                return false;
            }
            scope_path = scope.parent.as_deref();
        }

        let Some(matched_scope) = scope_path else {
            return false;
        };
        scope_path = matched_scope.parent.as_deref();
        index += 1;
    }
    true
}

fn matches_scope(scope_name: &str, scope_pattern: &str) -> bool {
    scope_name == scope_pattern
        || scope_name
            .strip_prefix(scope_pattern)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

fn resolve_parsed_theme_rules(
    mut parsed_theme_rules: Vec<ParsedThemeRule>,
    frozen_color_map: Option<Vec<String>>,
) -> Result<Theme, ThemeError> {
    parsed_theme_rules.sort_by(|first, second| {
        first
            .scope
            .cmp(&second.scope)
            .then_with(|| {
                compare_optional_string_arrays(&first.parent_scopes, &second.parent_scopes)
            })
            .then_with(|| first.index.cmp(&second.index))
    });

    let mut default_font_style = FontStyle::NONE;
    let mut default_foreground = "#000000".to_owned();
    let mut default_background = "#ffffff".to_owned();
    let mut default_font_family = String::new();
    let mut default_font_size = 0.0;
    let mut default_line_height = 0.0;

    let default_rule_count = parsed_theme_rules
        .iter()
        .take_while(|rule| rule.scope.is_empty())
        .count();
    for incoming_defaults in parsed_theme_rules.drain(..default_rule_count) {
        if incoming_defaults.font_style != FontStyle::NOT_SET {
            default_font_style = incoming_defaults.font_style;
        }
        if let Some(foreground) = incoming_defaults.foreground {
            default_foreground = foreground;
        }
        if let Some(background) = incoming_defaults.background {
            default_background = background;
        }
        default_font_family = incoming_defaults.font_family;
        default_font_size = incoming_defaults.font_size;
        default_line_height = incoming_defaults.line_height;
    }

    let mut color_map = ColorMap::new(frozen_color_map);
    let defaults = StyleAttributes {
        font_style: default_font_style,
        foreground_id: color_map.get_id(Some(&default_foreground), MAX_FOREGROUND_COLOR_ID)?,
        background_id: color_map.get_id(Some(&default_background), MAX_BACKGROUND_COLOR_ID)?,
        font_family: default_font_family.clone(),
        font_size: default_font_size,
        line_height: default_line_height,
    };

    let mut root = ThemeTrieElement::new(ThemeTrieElementRule::new(
        0,
        None,
        FontStyle::NOT_SET,
        0,
        0,
        default_font_family,
        default_font_size,
        default_line_height,
    ));
    for rule in parsed_theme_rules {
        let foreground = color_map.get_id(rule.foreground.as_deref(), MAX_FOREGROUND_COLOR_ID)?;
        let background = color_map.get_id(rule.background.as_deref(), MAX_BACKGROUND_COLOR_ID)?;
        root.insert(
            0,
            &rule.scope,
            rule.parent_scopes,
            rule.font_style,
            foreground,
            background,
            rule.font_family,
            rule.font_size,
            rule.line_height,
        );
    }

    Ok(Theme {
        id: NEXT_THEME_ID.fetch_add(1, AtomicOrdering::Relaxed),
        color_map,
        defaults,
        root,
        cached_match_root: RwLock::new(HashMap::new()),
    })
}

fn compare_optional_string_arrays(
    first: &Option<Vec<String>>,
    second: &Option<Vec<String>>,
) -> Ordering {
    match (first, second) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(first), Some(second)) => first
            .len()
            .cmp(&second.len())
            .then_with(|| first.iter().cmp(second)),
    }
}

struct ColorMap {
    is_frozen: bool,
    last_color_id: u32,
    id_to_color: Vec<String>,
    color_to_id: HashMap<String, u32>,
}

impl ColorMap {
    fn new(frozen_color_map: Option<Vec<String>>) -> Self {
        let mut color_map = Self {
            is_frozen: frozen_color_map.is_some(),
            last_color_id: 0,
            id_to_color: frozen_color_map.unwrap_or_default(),
            color_to_id: HashMap::new(),
        };
        for (index, color) in color_map.id_to_color.iter().enumerate() {
            color_map
                .color_to_id
                .insert(color.clone(), u32::try_from(index).unwrap_or(u32::MAX));
        }
        color_map
    }

    fn get_id(&mut self, color: Option<&str>, max_id: u32) -> Result<u32, ThemeError> {
        let Some(color) = color else {
            return Ok(0);
        };
        let color = color.to_uppercase();
        if let Some(value) = self
            .color_to_id
            .get(&color)
            .copied()
            .filter(|value| *value != 0)
        {
            if value > max_id {
                return Err(ThemeError::ColorMapOverflow {
                    color,
                    id: value,
                    max_id,
                });
            }
            return Ok(value);
        }
        if self.is_frozen {
            return Err(ThemeError::MissingFrozenColor(color));
        }

        let Some(value) = self.last_color_id.checked_add(1).filter(|&id| id <= max_id) else {
            return Err(ThemeError::ColorMapOverflow {
                color,
                id: self.last_color_id.saturating_add(1),
                max_id,
            });
        };
        self.last_color_id = value;
        let index = usize::try_from(value).expect("color ID exceeds addressable memory");
        if self.id_to_color.len() <= index {
            self.id_to_color.resize(index + 1, String::new());
        }
        self.color_to_id.insert(color.clone(), value);
        self.id_to_color[index] = color;
        Ok(value)
    }

    fn get_color_map(&self) -> Vec<String> {
        self.id_to_color.clone()
    }

    fn as_slice(&self) -> &[String] {
        &self.id_to_color
    }
}

#[derive(Clone)]
struct ThemeTrieElementRule {
    scope_depth: usize,
    parent_scopes: Vec<String>,
    font_style: FontStyle,
    foreground: u32,
    background: u32,
    font_family: String,
    font_size: f64,
    line_height: f64,
}

impl ThemeTrieElementRule {
    #[allow(clippy::too_many_arguments)]
    fn new(
        scope_depth: usize,
        parent_scopes: Option<Vec<String>>,
        font_style: FontStyle,
        foreground: u32,
        background: u32,
        font_family: String,
        font_size: f64,
        line_height: f64,
    ) -> Self {
        Self {
            scope_depth,
            parent_scopes: parent_scopes.unwrap_or_default(),
            font_style,
            foreground,
            background,
            font_family,
            font_size,
            line_height,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn accept_overwrite(
        &mut self,
        scope_depth: usize,
        font_style: FontStyle,
        foreground: u32,
        background: u32,
        font_family: String,
        font_size: f64,
        line_height: f64,
    ) {
        if self.scope_depth <= scope_depth {
            self.scope_depth = scope_depth;
        }
        if font_style != FontStyle::NOT_SET {
            self.font_style = font_style;
        }
        if foreground != 0 {
            self.foreground = foreground;
        }
        if background != 0 {
            self.background = background;
        }
        if !font_family.is_empty() {
            self.font_family = font_family;
        }
        if font_size != 0.0 {
            self.font_size = font_size;
        }
        if line_height != 0.0 {
            self.line_height = line_height;
        }
    }
}

struct ThemeTrieElement {
    main_rule: ThemeTrieElementRule,
    rules_with_parent_scopes: Vec<ThemeTrieElementRule>,
    children: BTreeMap<String, Self>,
    matched_rules: OnceLock<Arc<[ThemeTrieElementRule]>>,
}

impl ThemeTrieElement {
    fn new(main_rule: ThemeTrieElementRule) -> Self {
        Self {
            main_rule,
            rules_with_parent_scopes: Vec::new(),
            children: BTreeMap::new(),
            matched_rules: OnceLock::new(),
        }
    }

    fn compare_by_specificity(
        first: &ThemeTrieElementRule,
        second: &ThemeTrieElementRule,
    ) -> Ordering {
        let scope_depth_order = second.scope_depth.cmp(&first.scope_depth);
        if scope_depth_order != Ordering::Equal {
            return scope_depth_order;
        }

        let mut first_parent_index = 0;
        let mut second_parent_index = 0;
        loop {
            if first
                .parent_scopes
                .get(first_parent_index)
                .map(String::as_str)
                == Some(">")
            {
                first_parent_index += 1;
            }
            if second
                .parent_scopes
                .get(second_parent_index)
                .map(String::as_str)
                == Some(">")
            {
                second_parent_index += 1;
            }
            let (Some(first_parent), Some(second_parent)) = (
                first.parent_scopes.get(first_parent_index),
                second.parent_scopes.get(second_parent_index),
            ) else {
                break;
            };

            let parent_scope_length_order = second_parent.len().cmp(&first_parent.len());
            if parent_scope_length_order != Ordering::Equal {
                return parent_scope_length_order;
            }
            first_parent_index += 1;
            second_parent_index += 1;
        }

        second.parent_scopes.len().cmp(&first.parent_scopes.len())
    }

    fn match_scope(&self, scope: &str) -> Arc<[ThemeTrieElementRule]> {
        let mut node = self;
        let mut rest = scope;
        while !rest.is_empty() {
            let (head, tail) = rest
                .split_once('.')
                .map_or((rest, ""), |(head, tail)| (head, tail));
            let Some(child) = node.children.get(head) else {
                break;
            };
            node = child;
            rest = tail;
        }

        Arc::clone(node.matched_rules.get_or_init(|| {
            let mut rules = node.rules_with_parent_scopes.clone();
            rules.push(node.main_rule.clone());
            rules.sort_by(Self::compare_by_specificity);
            rules.into()
        }))
    }

    #[allow(clippy::too_many_arguments)]
    fn insert(
        &mut self,
        mut scope_depth: usize,
        mut scope: &str,
        parent_scopes: Option<Vec<String>>,
        font_style: FontStyle,
        foreground: u32,
        background: u32,
        font_family: String,
        font_size: f64,
        line_height: f64,
    ) {
        let mut current = self;
        while !scope.is_empty() {
            let (head, tail) = scope
                .split_once('.')
                .map_or((scope, ""), |(head, tail)| (head, tail));
            let main_rule = &current.main_rule;
            let rules_with_parent_scopes = &current.rules_with_parent_scopes;
            current = current
                .children
                .entry(head.to_owned())
                .or_insert_with(|| Self {
                    main_rule: main_rule.clone(),
                    rules_with_parent_scopes: rules_with_parent_scopes.clone(),
                    children: BTreeMap::new(),
                    matched_rules: OnceLock::new(),
                });
            scope_depth += 1;
            scope = tail;
        }

        current.insert_here(
            scope_depth,
            parent_scopes,
            font_style,
            foreground,
            background,
            font_family,
            font_size,
            line_height,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_here(
        &mut self,
        scope_depth: usize,
        parent_scopes: Option<Vec<String>>,
        mut font_style: FontStyle,
        mut foreground: u32,
        mut background: u32,
        mut font_family: String,
        mut font_size: f64,
        mut line_height: f64,
    ) {
        let Some(parent_scopes) = parent_scopes else {
            self.main_rule.accept_overwrite(
                scope_depth,
                font_style,
                foreground,
                background,
                font_family,
                font_size,
                line_height,
            );
            return;
        };

        if let Some(rule) = self
            .rules_with_parent_scopes
            .iter_mut()
            .find(|rule| rule.parent_scopes == parent_scopes)
        {
            rule.accept_overwrite(
                scope_depth,
                font_style,
                foreground,
                background,
                font_family,
                font_size,
                line_height,
            );
            return;
        }

        if font_style == FontStyle::NOT_SET {
            font_style = self.main_rule.font_style;
        }
        if foreground == 0 {
            foreground = self.main_rule.foreground;
        }
        if background == 0 {
            background = self.main_rule.background;
        }
        if font_family.is_empty() {
            font_family.clone_from(&self.main_rule.font_family);
        }
        if font_size == 0.0 {
            font_size = self.main_rule.font_size;
        }
        if line_height == 0.0 {
            line_height = self.main_rule.line_height;
        }

        self.rules_with_parent_scopes
            .push(ThemeTrieElementRule::new(
                scope_depth,
                Some(parent_scopes),
                font_style,
                foreground,
                background,
                font_family,
                font_size,
                line_height,
            ));
    }
}

impl Drop for ThemeTrieElement {
    fn drop(&mut self) {
        if self.children.is_empty() {
            return;
        }
        let mut stack = vec![std::mem::take(&mut self.children).into_values()];
        while let Some(iter) = stack.last_mut() {
            let Some(mut child) = iter.next() else {
                stack.pop();
                continue;
            };
            if !child.children.is_empty() {
                stack.push(std::mem::take(&mut child.children).into_values());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        FontStyle, ParsedThemeRule, RawTheme, RawThemeScope, RawThemeSetting, RawThemeStyle,
        ScopeStack, Theme, font_style_to_string, parse_theme,
    };

    fn style(
        font_style: Option<&str>,
        foreground: Option<&str>,
        background: Option<&str>,
    ) -> RawThemeStyle {
        RawThemeStyle {
            font_style: font_style.map(str::to_owned),
            foreground: foreground.map(str::to_owned),
            background: background.map(str::to_owned),
            ..RawThemeStyle::default()
        }
    }

    fn setting(scope: Option<RawThemeScope>, settings: RawThemeStyle) -> RawThemeSetting {
        RawThemeSetting {
            scope,
            settings: Some(settings),
            ..RawThemeSetting::default()
        }
    }

    fn string_scope(scope: &str) -> Option<RawThemeScope> {
        Some(RawThemeScope::String(scope.to_owned()))
    }

    fn theme(settings: Vec<RawThemeSetting>) -> Theme {
        Theme::create_from_raw_theme(
            Some(&RawTheme {
                settings,
                ..RawTheme::default()
            }),
            None,
        )
        .unwrap()
    }

    fn match_theme(theme: &Theme, path: &[&str]) -> (String, Option<String>, Option<String>) {
        let scope_stack = ScopeStack::from(path.iter().copied()).unwrap();
        let result = theme.match_scope(Some(&scope_stack)).unwrap();
        let color_map = theme.get_color_map();
        (
            font_style_to_string(result.font_style),
            (result.foreground_id != 0).then(|| color_map[result.foreground_id as usize].clone()),
            (result.background_id != 0).then(|| color_map[result.background_id as usize].clone()),
        )
    }

    #[test]
    fn scope_stack_preserves_identity_based_extensions() {
        let base = ScopeStack::from(["source.ts", "meta.function"]).unwrap();
        let extended = base.push_scope("variable.parameter");
        let unrelated = ScopeStack::from(["source.ts", "meta.function"]).unwrap();

        assert!(extended.extends(&base));
        assert!(!extended.extends(&unrelated));
        assert_eq!(
            extended.get_extension_if_defined(Some(&base)),
            Some(vec!["variable.parameter".to_owned()])
        );
        assert_eq!(extended.get_extension_if_defined(Some(&unrelated)), None);
        assert_eq!(
            extended.get_segments(),
            ["source.ts", "meta.function", "variable.parameter"]
        );
    }

    #[test]
    fn parses_upstream_theme_rules_and_ignores_invalid_colors() {
        let source = RawTheme {
            settings: vec![
                setting(None, style(None, Some("#F8F8F2"), Some("#272822"))),
                setting(
                    string_scope("source, something"),
                    style(None, None, Some("#100000")),
                ),
                setting(
                    Some(RawThemeScope::Array(vec![
                        "bar".to_owned(),
                        "baz".to_owned(),
                    ])),
                    style(None, None, Some("#010000")),
                ),
                setting(
                    string_scope("source.css selector bar"),
                    style(Some("bold"), None, None),
                ),
                setting(
                    string_scope("constant.numeric.bin"),
                    style(Some("bold strikethrough"), None, None),
                ),
                setting(
                    string_scope("variable.parameter"),
                    style(Some("italic"), Some(""), None),
                ),
            ],
            ..RawTheme::default()
        };

        assert_eq!(
            parse_theme(Some(&source)),
            vec![
                ParsedThemeRule {
                    scope: String::new(),
                    parent_scopes: None,
                    index: 0,
                    font_style: FontStyle::NOT_SET,
                    foreground: Some("#F8F8F2".to_owned()),
                    background: Some("#272822".to_owned()),
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
                ParsedThemeRule {
                    scope: "source".to_owned(),
                    parent_scopes: None,
                    index: 1,
                    font_style: FontStyle::NOT_SET,
                    foreground: None,
                    background: Some("#100000".to_owned()),
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
                ParsedThemeRule {
                    scope: "something".to_owned(),
                    parent_scopes: None,
                    index: 1,
                    font_style: FontStyle::NOT_SET,
                    foreground: None,
                    background: Some("#100000".to_owned()),
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
                ParsedThemeRule {
                    scope: "bar".to_owned(),
                    parent_scopes: None,
                    index: 2,
                    font_style: FontStyle::NOT_SET,
                    foreground: None,
                    background: Some("#010000".to_owned()),
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
                ParsedThemeRule {
                    scope: "baz".to_owned(),
                    parent_scopes: None,
                    index: 2,
                    font_style: FontStyle::NOT_SET,
                    foreground: None,
                    background: Some("#010000".to_owned()),
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
                ParsedThemeRule {
                    scope: "bar".to_owned(),
                    parent_scopes: Some(vec!["selector".to_owned(), "source.css".to_owned()]),
                    index: 3,
                    font_style: FontStyle::BOLD,
                    foreground: None,
                    background: None,
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
                ParsedThemeRule {
                    scope: "constant.numeric.bin".to_owned(),
                    parent_scopes: None,
                    index: 4,
                    font_style: FontStyle::BOLD | FontStyle::STRIKETHROUGH,
                    foreground: None,
                    background: None,
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
                ParsedThemeRule {
                    scope: "variable.parameter".to_owned(),
                    parent_scopes: None,
                    index: 5,
                    font_style: FontStyle::ITALIC,
                    foreground: None,
                    background: None,
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
            ]
        );
    }

    #[test]
    fn strips_trailing_commas_from_multiline_scope_selectors() {
        let source = RawTheme {
            settings: vec![setting(
                string_scope(
                    "meta.at-rule.return.scss,\nmeta.at-rule.return.scss punctuation.definition,",
                ),
                style(None, Some("#CC7832"), None),
            )],
            ..RawTheme::default()
        };

        let parsed = parse_theme(Some(&source));
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].scope, "meta.at-rule.return.scss");
        assert_eq!(parsed[0].parent_scopes, None);
        assert_eq!(parsed[1].scope, "punctuation.definition");
        assert_eq!(
            parsed[1].parent_scopes,
            Some(vec!["meta.at-rule.return.scss".to_owned()])
        );
    }

    #[test]
    fn matches_upstream_inheritance_and_not_set_cases() {
        let theme = theme(vec![
            setting(None, style(None, Some("#F8F8F2"), Some("#272822"))),
            setting(
                string_scope("source, something"),
                style(None, None, Some("#100000")),
            ),
            setting(
                Some(RawThemeScope::Array(vec![
                    "bar".to_owned(),
                    "baz".to_owned(),
                ])),
                style(None, None, Some("#200000")),
            ),
            setting(
                string_scope("source.css selector bar"),
                style(Some("bold"), None, None),
            ),
            setting(
                string_scope("constant"),
                style(Some("italic"), Some("#300000"), None),
            ),
            setting(
                string_scope("constant.numeric"),
                style(None, Some("#400000"), None),
            ),
            setting(
                string_scope("constant.numeric.hex"),
                style(Some("bold"), None, None),
            ),
            setting(
                string_scope("constant.numeric.oct"),
                style(Some("bold italic underline"), None, None),
            ),
            setting(
                string_scope("constant.numeric.dec"),
                style(Some(""), Some("#500000"), None),
            ),
            setting(
                string_scope("storage.object.bar"),
                style(Some(""), Some("#600000"), None),
            ),
        ]);

        let cases = [
            (vec!["source.ts"], ("not set", None, Some("#100000"))),
            (vec!["constant.string"], ("italic", Some("#300000"), None)),
            (vec!["constant.numeric"], ("italic", Some("#400000"), None)),
            (
                vec!["constant.numeric.hex.baz"],
                ("bold", Some("#400000"), None),
            ),
            (
                vec!["constant.numeric.oct"],
                ("italic bold underline", Some("#400000"), None),
            ),
            (
                vec!["constant.numeric.dec.baz"],
                ("none", Some("#500000"), None),
            ),
            (vec!["storage.object.bart"], ("not set", None, None)),
            (
                vec!["source.css", "selector", "bar"],
                ("bold", None, Some("#200000")),
            ),
        ];

        for (path, (font_style, foreground, background)) in cases {
            let actual = match_theme(&theme, &path);
            assert_eq!(actual.0, font_style, "{path:?}");
            assert_eq!(actual.1.as_deref(), foreground, "{path:?}");
            assert_eq!(actual.2.as_deref(), background, "{path:?}");
        }
    }

    #[test]
    fn gives_deeper_scope_matches_priority() {
        let theme = theme(vec![
            setting(None, style(None, Some("#100000"), Some("#200000"))),
            setting(
                string_scope("punctuation.definition.string.begin.html"),
                style(None, Some("#300000"), None),
            ),
            setting(
                string_scope("meta.tag punctuation.definition.string"),
                style(None, Some("#400000"), None),
            ),
        ]);

        assert_eq!(
            match_theme(&theme, &["punctuation.definition.string.begin.html"]).1,
            Some("#300000".to_owned())
        );
    }

    #[test]
    fn gives_deeper_parent_scopes_priority() {
        let theme = theme(vec![
            setting(None, style(None, Some("#100000"), None)),
            setting(string_scope("y.z a.b"), style(None, Some("#200000"), None)),
            setting(string_scope("x y a.b"), style(None, Some("#300000"), None)),
        ]);

        assert_eq!(
            match_theme(&theme, &["x", "y", "a.b"]).1,
            Some("#300000".to_owned())
        );
        assert_eq!(
            match_theme(&theme, &["x", "y.z", "a.b"]).1,
            Some("#200000".to_owned())
        );
    }

    #[test]
    fn matches_parent_scopes_and_child_combinators() {
        let theme = theme(vec![
            setting(None, style(None, Some("#100000"), None)),
            setting(string_scope("b a"), style(None, Some("#200000"), None)),
            setting(string_scope("b > a"), style(None, Some("#300000"), None)),
            setting(
                string_scope("c > b > a"),
                style(None, Some("#400000"), None),
            ),
            setting(string_scope("a"), style(None, Some("#500000"), None)),
        ]);

        let cases = [
            (vec!["b", "a"], "#300000"),
            (vec!["b", "c", "a"], "#200000"),
            (vec!["c", "b", "a"], "#400000"),
            (vec!["c", "b", "d", "a"], "#200000"),
        ];
        for (path, expected) in cases {
            assert_eq!(
                match_theme(&theme, &path).1,
                Some(expected.to_owned()),
                "{path:?}"
            );
        }
    }

    #[test]
    fn merges_defaults_and_same_parent_rules_in_source_order() {
        let theme = Theme::create_from_parsed_theme(
            vec![
                ParsedThemeRule {
                    scope: String::new(),
                    parent_scopes: None,
                    index: -1,
                    font_style: FontStyle::NOT_SET,
                    foreground: None,
                    background: Some("#ff0000".to_owned()),
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
                ParsedThemeRule {
                    scope: String::new(),
                    parent_scopes: None,
                    index: 0,
                    font_style: FontStyle::BOLD,
                    foreground: Some("#00ff00".to_owned()),
                    background: None,
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
                ParsedThemeRule {
                    scope: "var".to_owned(),
                    parent_scopes: None,
                    index: 1,
                    font_style: FontStyle::BOLD,
                    foreground: Some("#100000".to_owned()),
                    background: None,
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
                ParsedThemeRule {
                    scope: "var".to_owned(),
                    parent_scopes: Some(vec!["source.css".to_owned()]),
                    index: 2,
                    font_style: FontStyle::ITALIC,
                    foreground: Some("#300000".to_owned()),
                    background: None,
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
                ParsedThemeRule {
                    scope: "var".to_owned(),
                    parent_scopes: Some(vec!["source.css".to_owned()]),
                    index: 3,
                    font_style: FontStyle::UNDERLINE,
                    foreground: None,
                    background: None,
                    font_family: String::new(),
                    font_size: 0.0,
                    line_height: 0.0,
                },
            ],
            None,
        )
        .unwrap();

        assert_eq!(theme.get_defaults().font_style, FontStyle::BOLD);
        let colors = theme.get_color_map();
        assert_eq!(
            colors[theme.get_defaults().foreground_id as usize],
            "#00FF00"
        );
        assert_eq!(
            colors[theme.get_defaults().background_id as usize],
            "#FF0000"
        );

        let stack = ScopeStack::from(["source.css", "var"]).unwrap();
        let result = theme.match_scope(Some(&stack)).unwrap();
        assert_eq!(result.font_style, FontStyle::UNDERLINE);
        assert_eq!(colors[result.foreground_id as usize], "#300000");
    }

    #[test]
    fn drops_and_walks_deep_scope_stack_chain_iteratively() {
        let root = ScopeStack::from(["source.test"]).unwrap();
        let mut current = std::sync::Arc::clone(&root);
        for _ in 0..50_000 {
            current = current.push_scope("meta.nested");
        }
        assert!(current.extends(&root));
        drop(current);
        drop(root);
    }

    #[test]
    fn compiled_theme_is_send_sync_debug_and_borrows_color_map() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Theme>();

        let theme = theme(vec![RawThemeSetting {
            scope: Some(RawThemeScope::String("keyword.test".into())),
            settings: Some(RawThemeStyle {
                foreground: Some("#112233".into()),
                ..RawThemeStyle::default()
            }),
            ..RawThemeSetting::default()
        }]);
        assert_eq!(theme.color_map(), theme.get_color_map().as_slice());
        assert!(theme.color_map().iter().any(|color| color == "#112233"));
        let debug = format!("{theme:?}");
        assert!(debug.starts_with("Theme {"));
    }

    #[test]
    fn bounds_cached_scope_matches_for_dynamic_capture_derived_scopes() {
        let theme = theme(vec![RawThemeSetting {
            scope: Some(RawThemeScope::String("markup.underline.link".into())),
            settings: Some(RawThemeStyle {
                foreground: Some("#2266aa".into()),
                ..RawThemeStyle::default()
            }),
            ..RawThemeSetting::default()
        }]);
        let expected_color = "#2266AA";

        for index in 0..(super::MAX_CACHED_SCOPE_MATCHES * 2 + 17) {
            let scope = format!("markup.underline.link.rfc.{index}.hyperlink");
            let stack = ScopeStack::from([scope.as_str()]).unwrap();
            let style = theme.match_scope(Some(&stack)).unwrap();
            assert_eq!(
                theme.color_map()[style.foreground_id as usize],
                expected_color
            );
            assert!(theme.cached_match_count() <= super::MAX_CACHED_SCOPE_MATCHES);
        }

        let before_oversized = theme.cached_match_count();
        let oversized = format!(
            "markup.underline.link.{}.hyperlink",
            "x".repeat(super::MAX_CACHED_SCOPE_NAME_BYTES + 32)
        );
        let stack = ScopeStack::from([oversized.as_str()]).unwrap();
        let style = theme.match_scope(Some(&stack)).unwrap();
        assert_eq!(
            theme.color_map()[style.foreground_id as usize],
            expected_color
        );
        assert_eq!(
            theme.cached_match_count(),
            before_oversized,
            "oversized dynamic scope names must bypass cached_match_root"
        );
    }

    #[test]
    fn handles_and_drops_deeply_dotted_theme_scopes_iteratively() {
        let deep_scope = format!("{}leaf", "a.".repeat(10_000));
        let deeper_scope = format!("{deep_scope}.extra");
        let trailing_dot_scope = "b.".repeat(10_000);
        let theme = theme(vec![
            setting(None, style(None, Some("#100000"), Some("#200000"))),
            setting(
                string_scope(&deep_scope),
                style(Some("bold"), Some("#300000"), None),
            ),
            setting(
                string_scope(&trailing_dot_scope),
                style(Some("italic"), Some("#400000"), None),
            ),
        ]);

        assert_eq!(
            match_theme(&theme, &[&deep_scope]),
            ("bold".to_owned(), Some("#300000".to_owned()), None)
        );
        assert_eq!(
            match_theme(&theme, &[&deeper_scope]),
            ("bold".to_owned(), Some("#300000".to_owned()), None)
        );
        assert_eq!(
            match_theme(&theme, &[&trailing_dot_scope]),
            ("italic".to_owned(), Some("#400000".to_owned()), None)
        );
        assert_eq!(
            match_theme(&theme, &[&format!("{}other", "a.".repeat(10_000))]),
            ("not set".to_owned(), None, None)
        );
        drop(theme);
    }

    fn hex_color(index: u32) -> String {
        format!("#{index:06X}")
    }

    #[test]
    fn allows_up_to_511_foreground_colors_and_rejects_512th() {
        // Default foreground (#000000 -> ID 1) and default background (#FFFFFF -> ID 2)
        // leave 509 additional foreground slots (IDs 3..=511).
        let mut settings: Vec<RawThemeSetting> = (3..=511)
            .map(|id| {
                setting(
                    string_scope(&format!("scope.fg{id:03}")),
                    style(None, Some(&hex_color(id)), None),
                )
            })
            .collect();

        let valid_theme = Theme::create_from_raw_theme(
            Some(&RawTheme {
                settings: settings.clone(),
                ..RawTheme::default()
            }),
            None,
        )
        .expect("511 foreground colors with default background ID 2 must fit in 9-bit foreground");
        assert_eq!(valid_theme.color_map().len(), 512);
        let stack = ScopeStack::from(["scope.fg511"]).unwrap();
        let matched = valid_theme.match_scope(Some(&stack)).unwrap();
        assert_eq!(matched.foreground_id, 511);
        assert_eq!(matched.background_id, 0);
        assert_eq!(valid_theme.color_map()[511], hex_color(511));

        // Adding a 512th distinct foreground color exceeds the 9-bit foreground capacity.
        settings.push(setting(
            string_scope("scope.fg512"),
            style(None, Some(&hex_color(512)), None),
        ));
        let err = Theme::create_from_raw_theme(
            Some(&RawTheme {
                settings,
                ..RawTheme::default()
            }),
            None,
        )
        .unwrap_err();
        assert_eq!(
            err,
            super::ThemeError::ColorMapOverflow {
                color: hex_color(512),
                id: 512,
                max_id: super::MAX_FOREGROUND_COLOR_ID,
            }
        );
    }

    #[test]
    fn enforces_8_bit_background_color_capacity_for_new_and_reused_colors() {
        // Default foreground (ID 1) and background (ID 2), plus 253 background colors -> IDs 3..=255.
        let mut settings: Vec<RawThemeSetting> = (3..=255)
            .map(|id| {
                setting(
                    string_scope(&format!("scope.bg{id:03}")),
                    style(None, None, Some(&hex_color(id))),
                )
            })
            .collect();

        let valid_theme = Theme::create_from_raw_theme(
            Some(&RawTheme {
                settings: settings.clone(),
                ..RawTheme::default()
            }),
            None,
        )
        .expect("255 background colors must fit in 8-bit background");
        let stack = ScopeStack::from(["scope.bg255"]).unwrap();
        let matched = valid_theme.match_scope(Some(&stack)).unwrap();
        assert_eq!(matched.background_id, 255);

        // Adding a 256th distinct background color exceeds the 8-bit background capacity.
        let mut overflow_new_bg = settings.clone();
        overflow_new_bg.push(setting(
            string_scope("scope.bg256"),
            style(None, None, Some(&hex_color(256))),
        ));
        let err = Theme::create_from_raw_theme(
            Some(&RawTheme {
                settings: overflow_new_bg,
                ..RawTheme::default()
            }),
            None,
        )
        .unwrap_err();
        assert_eq!(
            err,
            super::ThemeError::ColorMapOverflow {
                color: hex_color(256),
                id: 256,
                max_id: super::MAX_BACKGROUND_COLOR_ID,
            }
        );

        // Registering ID 256 as a foreground color succeeds, but reusing that same
        // ID 256 color as a background color in a later rule must fail.
        settings.push(setting(
            string_scope("scope.fg256"),
            style(None, Some(&hex_color(256)), None),
        ));
        assert!(
            Theme::create_from_raw_theme(
                Some(&RawTheme {
                    settings: settings.clone(),
                    ..RawTheme::default()
                }),
                None,
            )
            .is_ok()
        );

        settings.push(setting(
            string_scope("scope.z_reuse_bg256"),
            style(None, None, Some(&hex_color(256))),
        ));
        let err = Theme::create_from_raw_theme(
            Some(&RawTheme {
                settings,
                ..RawTheme::default()
            }),
            None,
        )
        .unwrap_err();
        assert_eq!(
            err,
            super::ThemeError::ColorMapOverflow {
                color: hex_color(256),
                id: 256,
                max_id: super::MAX_BACKGROUND_COLOR_ID,
            }
        );
    }

    #[test]
    fn enforces_color_bitfield_bounds_for_frozen_color_maps() {
        let mut frozen = vec![String::new(), "#000000".to_owned(), "#FFFFFF".to_owned()];
        for id in 3..=512 {
            frozen.push(hex_color(id));
        }

        // Foreground at ID 300 and background at ID 255 fit in their respective bitfields.
        let valid = Theme::create_from_raw_theme(
            Some(&RawTheme {
                settings: vec![setting(
                    string_scope("scope.valid"),
                    style(None, Some(&hex_color(300)), Some(&hex_color(255))),
                )],
                ..RawTheme::default()
            }),
            Some(frozen.clone()),
        )
        .expect("frozen foreground 300 and background 255 must be accepted");
        let stack = ScopeStack::from(["scope.valid"]).unwrap();
        let matched = valid.match_scope(Some(&stack)).unwrap();
        assert_eq!(matched.foreground_id, 300);
        assert_eq!(matched.background_id, 255);

        // Frozen background at ID 256 exceeds 8 bits.
        let bg_err = Theme::create_from_raw_theme(
            Some(&RawTheme {
                settings: vec![setting(
                    string_scope("scope.bad_bg"),
                    style(None, None, Some(&hex_color(256))),
                )],
                ..RawTheme::default()
            }),
            Some(frozen.clone()),
        )
        .unwrap_err();
        assert_eq!(
            bg_err,
            super::ThemeError::ColorMapOverflow {
                color: hex_color(256),
                id: 256,
                max_id: super::MAX_BACKGROUND_COLOR_ID,
            }
        );

        // Frozen foreground at ID 512 exceeds 9 bits.
        let fg_err = Theme::create_from_raw_theme(
            Some(&RawTheme {
                settings: vec![setting(
                    string_scope("scope.bad_fg"),
                    style(None, Some(&hex_color(512)), None),
                )],
                ..RawTheme::default()
            }),
            Some(frozen),
        )
        .unwrap_err();
        assert_eq!(
            fg_err,
            super::ThemeError::ColorMapOverflow {
                color: hex_color(512),
                id: 512,
                max_id: super::MAX_FOREGROUND_COLOR_ID,
            }
        );
    }

    #[test]
    fn recovers_and_clears_match_cache_after_poisoned_lock() {
        let theme = Theme::create_from_raw_theme(
            Some(&RawTheme {
                settings: vec![setting(
                    string_scope("keyword.control"),
                    style(Some("bold"), Some("#FF0000"), None),
                )],
                ..RawTheme::default()
            }),
            None,
        )
        .unwrap();

        let scope = ScopeStack::from(["keyword.control"]).unwrap();
        let expected = theme.match_scope(Some(scope.as_ref()));
        assert_eq!(theme.cached_match_count(), 1);

        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = theme.cached_match_root.write().unwrap();
            panic!("simulate poisoned theme match cache");
        }));
        assert!(theme.cached_match_root.is_poisoned());

        assert_eq!(theme.match_scope(Some(scope.as_ref())), expected);
        assert!(!theme.cached_match_root.is_poisoned());
        assert_eq!(theme.cached_match_count(), 1);
    }
}
