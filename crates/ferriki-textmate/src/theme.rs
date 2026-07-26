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
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTheme {
    pub name: Option<String>,
    #[serde(default)]
    pub settings: Vec<RawThemeSetting>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
pub struct RawThemeStyle {
    pub font_style: Option<String>,
    pub foreground: Option<String>,
    pub background: Option<String>,
    pub font_family: Option<String>,
    pub font_size: Option<f64>,
    pub line_height: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
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
pub fn font_style_to_string(font_style: FontStyle) -> String {
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
pub struct ParsedThemeRule {
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
pub struct StyleAttributes {
    pub font_style: FontStyle,
    pub foreground_id: u32,
    pub background_id: u32,
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
}

#[derive(Debug)]
pub struct ScopeStack {
    pub parent: Option<Arc<Self>>,
    pub scope_name: String,
}

impl ScopeStack {
    #[must_use]
    pub fn push<I, S>(mut path: Option<Arc<Self>>, scope_names: I) -> Option<Arc<Self>>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
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
    pub fn from<I, S>(segments: I) -> Option<Arc<Self>>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self::push(None, segments)
    }

    #[must_use]
    pub fn push_scope(self: &Arc<Self>, scope_name: impl Into<String>) -> Arc<Self> {
        Arc::new(Self {
            parent: Some(Arc::clone(self)),
            scope_name: scope_name.into(),
        })
    }

    #[must_use]
    pub fn get_segments(&self) -> Vec<String> {
        let mut item = Some(self);
        let mut result = Vec::new();
        while let Some(scope) = item {
            result.push(scope.scope_name.clone());
            item = scope.parent.as_deref();
        }
        result.reverse();
        result
    }

    #[must_use]
    pub fn extends(self: &Arc<Self>, other: &Arc<Self>) -> bool {
        if Arc::ptr_eq(self, other) {
            return true;
        }
        self.parent
            .as_ref()
            .is_some_and(|parent| parent.extends(other))
    }

    #[must_use]
    pub fn get_extension_if_defined(
        self: &Arc<Self>,
        base: Option<&Arc<Self>>,
    ) -> Option<Vec<String>> {
        let mut result = Vec::new();
        let mut item = Some(Arc::clone(self));

        while let Some(scope) = item.as_ref() {
            if base.is_some_and(|base| Arc::ptr_eq(scope, base)) {
                break;
            }
            result.push(scope.scope_name.clone());
            item = scope.parent.clone();
        }

        let reached_base = match (item.as_ref(), base) {
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

impl fmt::Display for ScopeStack {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.get_segments().join(" "))
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum ThemeError {
    MissingFrozenColor(String),
}

impl fmt::Display for ThemeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingFrozenColor(color) => {
                write!(formatter, "missing color in color map - {color}")
            }
        }
    }
}

impl std::error::Error for ThemeError {}

pub struct Theme {
    color_map: ColorMap,
    defaults: StyleAttributes,
    root: ThemeTrieElement,
    cached_match_root: RwLock<HashMap<String, Vec<ThemeTrieElementRule>>>,
}

impl Theme {
    pub fn create_from_raw_theme(
        source: Option<&RawTheme>,
        color_map: Option<Vec<String>>,
    ) -> Result<Self, ThemeError> {
        Self::create_from_parsed_theme(parse_theme(source), color_map)
    }

    pub fn create_from_parsed_theme(
        source: Vec<ParsedThemeRule>,
        color_map: Option<Vec<String>>,
    ) -> Result<Self, ThemeError> {
        resolve_parsed_theme_rules(source, color_map)
    }

    #[must_use]
    pub fn get_color_map(&self) -> Vec<String> {
        self.color_map.get_color_map()
    }

    #[must_use]
    pub const fn get_defaults(&self) -> &StyleAttributes {
        &self.defaults
    }

    #[must_use]
    pub fn match_scope(&self, scope_path: Option<&ScopeStack>) -> Option<StyleAttributes> {
        let Some(scope_path) = scope_path else {
            return Some(self.defaults.clone());
        };

        let scope_name = &scope_path.scope_name;
        let cached_rules = self
            .cached_match_root
            .read()
            .expect("theme match cache lock poisoned")
            .get(scope_name)
            .cloned();
        let matching_trie_elements = cached_rules.unwrap_or_else(|| {
            let rules = self.root.match_scope(scope_name);
            self.cached_match_root
                .write()
                .expect("theme match cache lock poisoned")
                .insert(scope_name.clone(), rules.clone());
            rules
        });

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
pub fn parse_theme(source: Option<&RawTheme>) -> Vec<ParsedThemeRule> {
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
        foreground_id: color_map.get_id(Some(&default_foreground))?,
        background_id: color_map.get_id(Some(&default_background))?,
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
        let foreground = color_map.get_id(rule.foreground.as_deref())?;
        let background = color_map.get_id(rule.background.as_deref())?;
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

    fn get_id(&mut self, color: Option<&str>) -> Result<u32, ThemeError> {
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
            return Ok(value);
        }
        if self.is_frozen {
            return Err(ThemeError::MissingFrozenColor(color));
        }

        self.last_color_id += 1;
        let value = self.last_color_id;
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
}

impl ThemeTrieElement {
    fn new(main_rule: ThemeTrieElementRule) -> Self {
        Self {
            main_rule,
            rules_with_parent_scopes: Vec::new(),
            children: BTreeMap::new(),
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

    fn match_scope(&self, scope: &str) -> Vec<ThemeTrieElementRule> {
        if !scope.is_empty() {
            let (head, tail) = scope
                .split_once('.')
                .map_or((scope, ""), |(head, tail)| (head, tail));
            if let Some(child) = self.children.get(head) {
                return child.match_scope(tail);
            }
        }

        let mut rules = self.rules_with_parent_scopes.clone();
        rules.push(self.main_rule.clone());
        rules.sort_by(Self::compare_by_specificity);
        rules
    }

    #[allow(clippy::too_many_arguments)]
    fn insert(
        &mut self,
        scope_depth: usize,
        scope: &str,
        parent_scopes: Option<Vec<String>>,
        font_style: FontStyle,
        foreground: u32,
        background: u32,
        font_family: String,
        font_size: f64,
        line_height: f64,
    ) {
        if scope.is_empty() {
            self.insert_here(
                scope_depth,
                parent_scopes,
                font_style,
                foreground,
                background,
                font_family,
                font_size,
                line_height,
            );
            return;
        }

        let (head, tail) = scope
            .split_once('.')
            .map_or((scope, ""), |(head, tail)| (head, tail));
        let child = self
            .children
            .entry(head.to_owned())
            .or_insert_with(|| Self {
                main_rule: self.main_rule.clone(),
                rules_with_parent_scopes: self.rules_with_parent_scopes.clone(),
                children: BTreeMap::new(),
            });
        child.insert(
            scope_depth + 1,
            tail,
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

#[cfg(test)]
mod tests {
    use super::{
        font_style_to_string, parse_theme, FontStyle, ParsedThemeRule, RawTheme, RawThemeScope,
        RawThemeSetting, RawThemeStyle, ScopeStack, Theme,
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
}
