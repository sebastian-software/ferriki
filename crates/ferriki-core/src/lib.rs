mod asset_catalog;

use ferroni::regexec;
use ferroni::scanner::{OnigString, Scanner, ScannerFindOptions};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub use asset_catalog::{LanguageAssetCatalog, StandardAssetCatalogs, ThemeAssetCatalog};

#[napi(js_name = "ferrikiVersion")]
pub fn ferriki_version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub struct FerrikiHighlighter {
  _options_json: String,
  standard_assets: Option<StandardAssetCatalogs>,
  grammars: RefCell<HashMap<String, Value>>,
  aliases: RefCell<HashMap<String, String>>,
  themes: RefCell<HashMap<String, ThemeData>>,
  compiled_grammars: RefCell<HashMap<String, CompiledGrammar>>,
  /// Maps target scope → list of injecting grammar scope names
  injection_map: RefCell<HashMap<String, Vec<String>>>,
}

#[derive(Clone, Copy)]
enum LangMode {
  Plaintext,
  Json,
  Grammar,
}

struct JsonToken {
  kind: &'static str,
  start_utf16: usize,
  end_utf16: usize,
  content: String,
}

#[derive(Clone)]
struct StyledJsonToken {
  content: String,
  content_utf16_len: usize,
  offset_utf16: usize,
  color: Arc<str>,
  font_style: u8,
  dark_color: Option<Arc<str>>,
}

struct JsonThemeProfile {
  pre_class: String,
  pre_style: Option<String>,
  theme_name: String,
  fg: Option<String>,
  bg: Option<String>,
}

struct HtmlThemeProfile {
  pre_class: String,
  pre_style: Option<String>,
  theme_name: String,
  dark_theme_name: Option<String>,
  disable_token_coloring: bool,
}

struct ThemeRule {
  scopes: Vec<String>,
  /// Pre-split selector parts for each scope (avoids repeated split_whitespace)
  scope_parts: Vec<Vec<String>>,
  foreground: Option<Arc<str>>,
  font_style: u8,
}

impl ThemeRule {
  fn new(scopes: Vec<String>, foreground: Option<String>, font_style: u8) -> Self {
    let scope_parts = scopes.iter()
      .map(|s| s.split_whitespace().map(str::to_owned).collect())
      .collect();
    // Pre-normalize foreground color at registration time
    let foreground = foreground
      .map(|c| normalize_hex_color(&c))
      .map(Arc::<str>::from);
    Self { scopes, scope_parts, foreground, font_style }
  }
}

struct ThemeData {
  name: String,
  fg: String,
  fg_normalized: Arc<str>,
  bg: String,
  settings: Vec<ThemeRule>,
}

struct GrammarRegistration {
  scope_name: String,
  grammar: Value,
  aliases: Vec<String>,
  has_explicit_grammar: bool,
  inject_to: Vec<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// New RuleId-based architecture (port of vscode-textmate)
// ─────────────────────────────────────────────────────────────────────────────

type RuleId = i32;
const END_RULE_ID: RuleId = -1;
static NEXT_ONIG_STR_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct GrammarCapture {
  index: usize,
  name: Option<String>,
}

struct RuleRegistry {
  rules: Vec<Option<Rule>>,
  next_id: RuleId,
}

impl RuleRegistry {
  fn new() -> Self {
    RuleRegistry {
      rules: vec![None], // index 0 is unused (root sentinel)
      next_id: 1,
    }
  }

  fn alloc_id(&mut self) -> RuleId {
    let id = self.next_id;
    self.next_id += 1;
    // Ensure vec is large enough
    while self.rules.len() <= id as usize {
      self.rules.push(None);
    }
    id
  }

  fn store(&mut self, id: RuleId, rule: Rule) {
    self.rules[id as usize] = Some(rule);
  }

  fn get(&self, id: RuleId) -> Option<&Rule> {
    if id < 0 || id as usize >= self.rules.len() {
      return None;
    }
    self.rules[id as usize].as_ref()
  }
}

enum Rule {
  Match {
    _id: RuleId,
    name: Option<String>,
    match_re: String,
    captures: Vec<GrammarCapture>,
  },
  IncludeOnly {
    _id: RuleId,
    _name: Option<String>,
    _content_name: Option<String>,
    patterns: Vec<RuleId>,
  },
  BeginEnd {
    _id: RuleId,
    name: Option<String>,
    content_name: Option<String>,
    begin_re: String,
    end_re: String,
    end_has_back_references: bool,
    apply_end_pattern_last: bool,
    begin_captures: Vec<GrammarCapture>,
    end_captures: Vec<GrammarCapture>,
    patterns: Vec<RuleId>,
  },
  BeginWhile {
    _id: RuleId,
    name: Option<String>,
    content_name: Option<String>,
    begin_re: String,
    while_re: String,
    while_has_back_references: bool,
    begin_captures: Vec<GrammarCapture>,
    while_captures: Vec<GrammarCapture>,
    patterns: Vec<RuleId>,
  },
}


struct CompiledScanner {
  scanner: Scanner,
  rule_ids: Vec<RuleId>, // match index → RuleId
  regexes: Vec<String>,
  single_scanners: Vec<Option<Scanner>>,
}

struct StateFrame {
  rule_id: RuleId,
  _enter_pos: i32,
  _anchor_pos: i32,
  end_rule: Option<String>,
  name_scopes: Vec<String>,
  content_scopes: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InjectionPriority {
  Left,
  Default,
  Right,
}

struct CompiledSelector {
  clauses: Vec<CompiledSelectorClause>,
}

struct CompiledSelectorClause {
  disjuncts: Vec<CompiledSelectorDisjunct>,
}

struct CompiledSelectorDisjunct {
  terms: Vec<CompiledSelectorTerm>,
}

struct CompiledSelectorTerm {
  negate: bool,
  expr: CompiledSelectorExpr,
}

enum CompiledSelectorExpr {
  Token(String),
  AnyOf(Vec<CompiledSelectorDisjunct>),
}

struct Injection {
  compiled_selector: CompiledSelector,
  rule_id: RuleId,
  priority: InjectionPriority,
}

struct CompiledGrammar {
  registry: RuleRegistry,
  root_rule_id: RuleId,
  injections: Vec<Injection>,
  scanner_cache: HashMap<(RuleId, Option<String>), CompiledScanner>,
  injection_scanner_cache: HashMap<RuleId, CompiledScanner>,
  /// Cache for single-pattern while-condition scanners, keyed by regex string
  while_scanner_cache: HashMap<String, Scanner>,
}

const COLOR_DEFAULT_FG: &str = "#DBD7CAEE";
const COLOR_DEFAULT_BG: &str = "#121212";
const COLOR_INHERIT: &str = "inherit";

// ─────────────────────────────────────────────────────────────────────────────
// Grammar parsing helpers (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

fn parse_lang(options_json: &str) -> Option<String> {
  let parsed: Value = serde_json::from_str(options_json).ok()?;
  parsed.get("lang")?.as_str().map(str::to_owned)
}

fn parse_theme(options_json: &str) -> Option<String> {
  let parsed: Value = serde_json::from_str(options_json).ok()?;
  parsed.get("theme")?.as_str().map(str::to_owned)
}

fn parse_dual_themes(options_json: &str) -> Option<(String, String)> {
  let parsed: Value = serde_json::from_str(options_json).ok()?;
  let themes = parsed.get("themes")?.as_object()?;
  let light = themes.get("light")?.as_str()?.to_owned();
  let dark = themes.get("dark")?.as_str()?.to_owned();
  Some((light, dark))
}

fn serialize_state_frames(stack: &[StateFrame], root_scope: Option<&str>) -> Value {
  let mut obj = serde_json::Map::new();
  if let Some(scope) = root_scope {
    obj.insert("rootScope".to_owned(), Value::String(scope.to_owned()));
  }
  let frames: Vec<Value> = stack.iter().map(|frame| {
    json!({
      "ruleId": frame.rule_id,
      "endRule": frame.end_rule,
      "nameScopes": frame.name_scopes,
      "contentScopes": frame.content_scopes,
    })
  }).collect();
  obj.insert("frames".to_owned(), Value::Array(frames));
  Value::Object(obj)
}

fn deserialize_state_frames(value: &Value) -> Option<Vec<StateFrame>> {
  // Support both new format { rootScope, frames: [...] } and legacy bare array
  let arr = if let Some(obj) = value.as_object() {
    obj.get("frames")?.as_array()?
  } else {
    value.as_array()?
  };
  let mut frames = Vec::with_capacity(arr.len());
  for item in arr {
    let obj = item.as_object()?;
    let rule_id = obj.get("ruleId")?.as_i64()? as RuleId;
    let end_rule = obj.get("endRule").and_then(|v| v.as_str().map(str::to_owned));
    let name_scopes = obj.get("nameScopes")
      .and_then(|v| v.as_array())
      .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
      .unwrap_or_default();
    let content_scopes = obj.get("contentScopes")
      .and_then(|v| v.as_array())
      .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
      .unwrap_or_default();
    frames.push(StateFrame {
      rule_id,
      _enter_pos: 0,
      _anchor_pos: 0,
      end_rule,
      name_scopes,
      content_scopes,
    });
  }
  Some(frames)
}

fn parse_initial_state_from_options(options_json: &str) -> Option<Vec<StateFrame>> {
  let parsed: Value = serde_json::from_str(options_json).ok()?;
  if let Some(rust_state) = parsed.get("_rustState") {
    return deserialize_state_frames(rust_state);
  }
  None
}

fn parse_grammar_context_code(options_json: &str) -> Option<String> {
  let parsed: Value = serde_json::from_str(options_json).ok()?;
  parsed.get("grammarContextCode")?.as_str().map(str::to_owned)
}

fn parse_standard_asset_root(options_json: &str) -> Option<String> {
  let parsed: Value = serde_json::from_str(options_json).ok()?;
  parsed.get("standardAssetRoot")?.as_str().map(str::to_owned)
}

fn parse_string_array(value: Option<&Value>) -> Vec<String> {
  let Some(Value::Array(items)) = value else {
    return Vec::new();
  };

  items
    .iter()
    .filter_map(|item| item.as_str().map(str::to_owned))
    .collect::<Vec<_>>()
}

fn parse_grammar_registration(payload_json: &str) -> Result<GrammarRegistration> {
  let payload: Value = serde_json::from_str(payload_json)
    .map_err(|err| Error::from_reason(format!("Failed to parse grammar registration JSON: {err}")))?;

  let payload_obj = payload
    .as_object()
    .ok_or_else(|| Error::from_reason("Grammar registration payload must be an object."))?;

  let has_explicit_grammar = payload_obj.contains_key("grammar")
    || payload_obj.contains_key("patterns")
    || payload_obj.contains_key("repository")
    || payload_obj.contains_key("injections");
  let mut grammar = payload
    .get("grammar")
    .cloned()
    .unwrap_or_else(|| payload.clone());

  let mut scope_name = payload_obj
    .get("scopeName")
    .and_then(Value::as_str)
    .map(str::to_owned);
  if scope_name.is_none() {
    scope_name = grammar
      .get("scopeName")
      .and_then(Value::as_str)
      .map(str::to_owned);
  }
  let scope_name = scope_name
    .ok_or_else(|| Error::from_reason("Grammar registration requires `scopeName`."))?;

  if let Value::Object(ref mut grammar_obj) = grammar {
    grammar_obj
      .entry("scopeName".to_owned())
      .or_insert_with(|| Value::String(scope_name.clone()));
  }
  else {
    return Err(Error::from_reason(
      "Grammar registration `grammar` must be an object.",
    ));
  }

  let mut aliases = parse_string_array(payload_obj.get("aliases"));
  if aliases.is_empty() {
    aliases = parse_string_array(grammar.get("aliases"));
  }

  let inject_to = parse_string_array(payload_obj.get("injectTo"));

  Ok(GrammarRegistration {
    scope_name,
    grammar,
    aliases,
    has_explicit_grammar,
    inject_to,
  })
}

fn parse_theme_registration(payload_json: &str) -> Result<ThemeData> {
  let payload: Value = serde_json::from_str(payload_json)
    .map_err(|err| Error::from_reason(format!("Failed to parse theme registration JSON: {err}")))?;

  let obj = payload
    .as_object()
    .ok_or_else(|| Error::from_reason("Theme registration payload must be an object."))?;

  let name = obj
    .get("name")
    .and_then(Value::as_str)
    .ok_or_else(|| Error::from_reason("Theme registration requires `name`."))?
    .to_owned();

  let fg = obj
    .get("fg")
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_owned();

  let bg = obj
    .get("bg")
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_owned();

  let mut settings = Vec::new();
  if let Some(Value::Array(rules)) = obj.get("settings") {
    for rule in rules {
      let rule_obj = match rule.as_object() {
        Some(o) => o,
        None => continue,
      };
      let scopes = match rule_obj.get("scope") {
        Some(Value::Array(arr)) => arr
          .iter()
          .filter_map(|v| v.as_str().map(str::to_owned))
          .collect(),
        _ => Vec::new(),
      };
      let foreground = rule_obj
        .get("foreground")
        .and_then(Value::as_str)
        .map(str::to_owned);
      let font_style = rule_obj
        .get("fontStyle")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u8;
      settings.push(ThemeRule::new(scopes, foreground, font_style));
    }
  }

  Ok(ThemeData {
    name,
    fg_normalized: Arc::<str>::from(normalize_hex_color(&fg)),
    fg,
    bg,
    settings,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme / scope resolution (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct ResolvedStyle {
  foreground: Option<Arc<str>>,
  font_style: u8,
}

/// Identity hasher for already-hashed u64 cache keys.
#[derive(Default)]
struct U64IdentityHasher(u64);

impl Hasher for U64IdentityHasher {
  fn finish(&self) -> u64 {
    self.0
  }

  fn write(&mut self, bytes: &[u8]) {
    // Fallback path; u64 keys use `write_u64`.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
      h ^= *b as u64;
      h = h.wrapping_mul(0x100000001b3);
    }
    self.0 = h;
  }

  fn write_u64(&mut self, i: u64) {
    self.0 = i;
  }
}

type U64HashBuilder = BuildHasherDefault<U64IdentityHasher>;

/// Cache for theme resolution results, keyed by a hash of the scope stack.
struct ThemeCache {
  map: HashMap<u64, ResolvedStyle, U64HashBuilder>,
}

impl ThemeCache {
  fn new() -> Self {
    Self { map: HashMap::with_hasher(U64HashBuilder::default()) }
  }

  /// Hash scope stack from &[String] without intermediate Vec<&str>
  fn scope_hash_owned(scope_stack: &[String]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    h ^= scope_stack.len() as u64;
    h = h.wrapping_mul(0x100000001b3);
    for s in scope_stack {
      for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
      }
      h ^= 0xff;
      h = h.wrapping_mul(0x100000001b3);
    }
    h
  }

  fn scope_hash_with_extra_owned(scope_stack: &[String], extra: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    h ^= (scope_stack.len() + 1) as u64;
    h = h.wrapping_mul(0x100000001b3);
    for s in scope_stack {
      for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
      }
      h ^= 0xff;
      h = h.wrapping_mul(0x100000001b3);
    }
    for b in extra.as_bytes() {
      h ^= *b as u64;
      h = h.wrapping_mul(0x100000001b3);
    }
    h
  }

  fn resolve_owned(&mut self, scope_stack: &[String], theme: &ThemeData) -> &ResolvedStyle {
    let key = Self::scope_hash_owned(scope_stack);
    self.map.entry(key).or_insert_with(|| {
      let refs: Vec<&str> = scope_stack.iter().map(String::as_str).collect();
      resolve_token_style(&refs, theme)
    })
  }

  fn resolve_with_extra_owned(&mut self, scope_stack: &[String], extra: &str, theme: &ThemeData) -> &ResolvedStyle {
    let key = Self::scope_hash_with_extra_owned(scope_stack, extra);
    self.map.entry(key).or_insert_with(|| {
      let mut refs: Vec<&str> = scope_stack.iter().map(String::as_str).collect();
      refs.push(extra);
      resolve_token_style(&refs, theme)
    })
  }
}

fn scope_component_matches(selector: &str, scope: &str) -> bool {
  selector == scope
    || (scope.starts_with(selector)
        && scope.as_bytes().get(selector.len()) == Some(&b'.'))
}

fn selector_matches_presplit(parts: &[String], scope_stack: &[&str]) -> Option<usize> {
  if parts.is_empty() {
    return None;
  }

  let innermost = scope_stack.last()?;
  if !scope_component_matches(&parts[parts.len() - 1], innermost) {
    return None;
  }

  if parts.len() == 1 {
    return Some(parts[0].len());
  }

  let mut part_idx = (parts.len() - 2) as isize;
  let parent_scopes = &scope_stack[..scope_stack.len() - 1];
  let mut stack_idx = (parent_scopes.len() as isize) - 1;

  while part_idx >= 0 && stack_idx >= 0 {
    if scope_component_matches(&parts[part_idx as usize], parent_scopes[stack_idx as usize]) {
      part_idx -= 1;
    }
    stack_idx -= 1;
  }

  if part_idx < 0 {
    return Some(parts.iter().map(|p| p.len()).sum());
  }

  None
}

fn resolve_token_style(scope_stack: &[&str], theme: &ThemeData) -> ResolvedStyle {
  let mut best_score: usize = 0;
  let mut best_fg: Option<Arc<str>> = None;
  let mut best_font_style: u8 = 0;
  let mut has_global = false;

  for rule in &theme.settings {
    if rule.scopes.is_empty() {
      if !has_global {
        has_global = true;
        best_fg = rule.foreground.clone();
        best_font_style = rule.font_style;
      }
      continue;
    }

    for parts in &rule.scope_parts {
      if let Some(score) = selector_matches_presplit(parts, scope_stack) {
        if score > best_score {
          best_score = score;
          best_fg = rule.foreground.clone().or(best_fg);
          best_font_style = rule.font_style;
        }
      }
    }
  }

  ResolvedStyle {
    foreground: best_fg,
    font_style: best_font_style,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Grammar capture parsing (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

fn parse_grammar_captures(value: Option<&Value>) -> Vec<GrammarCapture> {
  let Some(Value::Object(obj)) = value else {
    return Vec::new();
  };

  let mut captures = obj
    .iter()
    .filter_map(|(key, capture)| {
      let index = key.parse::<usize>().ok()?;
      let name = capture
        .as_object()
        .and_then(|entry| entry.get("name"))
        .and_then(Value::as_str)
        .map(str::to_owned);
      Some(GrammarCapture { index, name })
    })
    .collect::<Vec<_>>();

  captures.sort_by_key(|entry| entry.index);
  captures
}

// ─────────────────────────────────────────────────────────────────────────────
// Injection selector parsing (unchanged from old code)
// ─────────────────────────────────────────────────────────────────────────────

fn parse_injection_clause_priority(clause: &str) -> (InjectionPriority, &str) {
  let mut priority = InjectionPriority::Default;
  let mut rest = clause.trim();

  loop {
    if let Some(stripped) = rest.strip_prefix("L:") {
      priority = InjectionPriority::Left;
      rest = stripped.trim_start();
      continue;
    }
    if let Some(stripped) = rest.strip_prefix("R:") {
      priority = InjectionPriority::Right;
      rest = stripped.trim_start();
      continue;
    }
    if let Some(stripped) = rest.strip_prefix("B:") {
      priority = InjectionPriority::Default;
      rest = stripped.trim_start();
      continue;
    }
    break;
  }

  (priority, rest.trim())
}

fn scope_token_matches_root(token: &str, root_scope: &str) -> bool {
  if token.is_empty() {
    return false;
  }
  if token == "*" || token == "$self" || token == root_scope {
    return true;
  }
  if root_scope
    .strip_prefix(token)
    .map(|rest| rest.is_empty() || rest.starts_with('.'))
    .unwrap_or(false)
  {
    return true;
  }
  false
}

fn parse_injection_term(term: &str) -> (bool, &str) {
  let mut negate = false;
  let mut out = term.trim();

  loop {
    if let Some(rest) = out.strip_prefix('!') {
      negate = !negate;
      out = rest.trim_start();
      continue;
    }
    if let Some(rest) = out.strip_prefix('-') {
      negate = !negate;
      out = rest.trim_start();
      continue;
    }
    break;
  }

  let out = out.trim_matches(|ch: char| matches!(ch, '(' | ')' | '^'));
  (negate, out)
}

fn split_top_level<'a>(input: &'a str, separators: &[char]) -> Vec<&'a str> {
  let mut out = Vec::new();
  let mut depth = 0usize;
  let mut segment_start = 0usize;

  for (idx, ch) in input.char_indices() {
    match ch {
      '(' => depth = depth.saturating_add(1),
      ')' => depth = depth.saturating_sub(1),
      _ => {}
    }

    if depth == 0 && separators.contains(&ch) {
      if segment_start <= idx {
        let segment = input[segment_start..idx].trim();
        if !segment.is_empty() {
          out.push(segment);
        }
      }
      segment_start = idx.saturating_add(ch.len_utf8());
    }
  }

  if segment_start <= input.len() {
    let segment = input[segment_start..].trim();
    if !segment.is_empty() {
      out.push(segment);
    }
  }

  out
}

fn split_selector_terms(disjunct: &str) -> Vec<&str> {
  let mut out = Vec::new();
  let mut depth = 0usize;
  let mut segment_start: Option<usize> = None;

  for (idx, ch) in disjunct.char_indices() {
    match ch {
      '(' => {
        depth = depth.saturating_add(1);
        if segment_start.is_none() {
          segment_start = Some(idx);
        }
      }
      ')' => depth = depth.saturating_sub(1),
      '&' if depth == 0 => {
        if let Some(start) = segment_start.take() {
          let term = disjunct[start..idx].trim();
          if !term.is_empty() {
            out.push(term);
          }
        }
      }
      _ if depth == 0 && ch.is_whitespace() => {
        if let Some(start) = segment_start.take() {
          let term = disjunct[start..idx].trim();
          if !term.is_empty() {
            out.push(term);
          }
        }
      }
      _ => {
        if segment_start.is_none() {
          segment_start = Some(idx);
        }
      }
    }
  }

  if let Some(start) = segment_start {
    let term = disjunct[start..].trim();
    if !term.is_empty() {
      out.push(term);
    }
  }

  out
}

fn compile_selector_disjunct(disjunct: &str) -> Option<CompiledSelectorDisjunct> {
  let raw_terms = split_selector_terms(disjunct);
  if raw_terms.is_empty() {
    return None;
  }

  let mut terms: Vec<CompiledSelectorTerm> = Vec::new();
  let mut index = 0usize;
  while index < raw_terms.len() {
    let mut raw_term = raw_terms[index].trim();
    if raw_term.is_empty() {
      index = index.saturating_add(1);
      continue;
    }

    let mut detached_negate = false;
    if (raw_term == "!" || raw_term == "-") && index + 1 < raw_terms.len() {
      detached_negate = true;
      index = index.saturating_add(1);
      raw_term = raw_terms[index].trim();
    }

    let (term_negate, term) = parse_injection_term(raw_term);
    let negate = detached_negate ^ term_negate;
    if term.is_empty() {
      index = index.saturating_add(1);
      continue;
    }

    let branches = split_top_level(term, &['|']);
    let expr = if branches.len() > 1 {
      let mut compiled_branches: Vec<CompiledSelectorDisjunct> = Vec::new();
      for branch in branches {
        if let Some(compiled) = compile_selector_disjunct(branch) {
          compiled_branches.push(compiled);
        }
      }
      if compiled_branches.is_empty() {
        index = index.saturating_add(1);
        continue;
      }
      CompiledSelectorExpr::AnyOf(compiled_branches)
    } else {
      CompiledSelectorExpr::Token(term.to_owned())
    };

    terms.push(CompiledSelectorTerm { negate, expr });

    index = index.saturating_add(1);
  }

  if terms.is_empty() {
    None
  } else {
    Some(CompiledSelectorDisjunct { terms })
  }
}

fn compile_selector(selector: &str) -> CompiledSelector {
  let mut clauses: Vec<CompiledSelectorClause> = Vec::new();

  for clause in split_top_level(selector, &[',']) {
    let (_priority, normalized) = parse_injection_clause_priority(clause);
    if normalized.is_empty() {
      continue;
    }

    let mut disjuncts: Vec<CompiledSelectorDisjunct> = Vec::new();
    for disjunct in split_top_level(normalized, &['|']) {
      if let Some(compiled) = compile_selector_disjunct(disjunct) {
        disjuncts.push(compiled);
      }
    }
    if !disjuncts.is_empty() {
      clauses.push(CompiledSelectorClause { disjuncts });
    }
  }

  CompiledSelector { clauses }
}

fn selector_disjunct_matches_compiled(
  disjunct: &CompiledSelectorDisjunct,
  root_scope: &str,
) -> bool {
  let mut has_term = false;
  for term in &disjunct.terms {
    has_term = true;
    let matches = match &term.expr {
      CompiledSelectorExpr::Token(token) => scope_token_matches_root(token, root_scope),
      CompiledSelectorExpr::AnyOf(branches) => branches
        .iter()
        .any(|branch| selector_disjunct_matches_compiled(branch, root_scope)),
    };

    if term.negate {
      if matches {
        return false;
      }
    } else if !matches {
      return false;
    }
  }

  has_term
}

fn selector_matches_compiled(selector: &CompiledSelector, root_scope: &str) -> bool {
  selector.clauses.iter().any(|clause| {
    clause
      .disjuncts
      .iter()
      .any(|disjunct| selector_disjunct_matches_compiled(disjunct, root_scope))
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule compilation (port of vscode-textmate getCompiledRuleId/_compilePatterns)
// ─────────────────────────────────────────────────────────────────────────────

/// Port of vscode-textmate initGrammar(): creates synthetic $self and $base
/// entries in the repository.
/// If `base_grammar` is provided, $base points to the base grammar's $self.
/// Otherwise, $base = $self (the grammar itself).
fn init_grammar(grammar: &Value, base_grammar: Option<&Value>) -> Value {
  let mut g = grammar.clone();
  if let Value::Object(ref mut obj) = g {
    // Ensure repository exists
    if !obj.contains_key("repository") {
      obj.insert("repository".to_owned(), json!({}));
    }

    // Build $self = { patterns: grammar.patterns, name: grammar.scopeName }
    let self_entry = {
      let mut entry = serde_json::Map::new();
      if let Some(patterns) = obj.get("patterns").cloned() {
        entry.insert("patterns".to_owned(), patterns);
      }
      if let Some(name) = obj.get("scopeName").cloned() {
        entry.insert("name".to_owned(), name);
      }
      Value::Object(entry)
    };

    // Build $base entry: from base_grammar if provided, else same as $self
    let base_entry = if let Some(base) = base_grammar {
      if let Some(base_obj) = base.as_object() {
        let mut entry = serde_json::Map::new();
        if let Some(patterns) = base_obj.get("patterns").cloned() {
          entry.insert("patterns".to_owned(), patterns);
        }
        if let Some(name) = base_obj.get("scopeName").cloned() {
          entry.insert("name".to_owned(), name);
        }
        // Also merge in the base grammar's repository for $base includes
        if let Some(repo) = base_obj.get("repository").cloned() {
          entry.insert("repository".to_owned(), repo);
        }
        Value::Object(entry)
      } else {
        self_entry.clone()
      }
    } else {
      self_entry.clone()
    };

    if let Some(Value::Object(ref mut repo)) = obj.get_mut("repository") {
      repo.insert("$self".to_owned(), self_entry);
      repo.insert("$base".to_owned(), base_entry);
    }
  }
  g
}

/// Check if a pattern string contains back-references like \1, \2, etc.
fn has_back_references(pattern: &str) -> bool {
  let mut chars = pattern.chars().peekable();
  while let Some(ch) = chars.next() {
    if ch == '\\' {
      if let Some(next) = chars.peek() {
        if next.is_ascii_digit() && *next != '0' {
          return true;
        }
      }
    }
  }
  false
}

/// Compile a grammar descriptor into the rule registry, returning its RuleId.
/// Port of vscode-textmate RuleFactory.getCompiledRuleId().
fn compile_rule(
  desc: &Value,
  registry: &mut RuleRegistry,
  compiled_map: &mut HashMap<String, RuleId>,
  repository: &serde_json::Map<String, Value>,
  grammar_pool: &HashMap<String, Value>,
  desc_key: &str,
  host_grammar: Option<&Value>,
) -> Option<RuleId> {
  compile_rule_inner(desc, registry, compiled_map, repository, grammar_pool, desc_key, host_grammar, 0)
}

const MAX_COMPILE_DEPTH: usize = 64;

fn compile_rule_inner(
  desc: &Value,
  registry: &mut RuleRegistry,
  compiled_map: &mut HashMap<String, RuleId>,
  repository: &serde_json::Map<String, Value>,
  grammar_pool: &HashMap<String, Value>,
  desc_key: &str,
  host_grammar: Option<&Value>,
  depth: usize,
) -> Option<RuleId> {
  if depth > MAX_COMPILE_DEPTH {
    return None;
  }

  // Memoize: if already compiled, return existing id
  if let Some(&id) = compiled_map.get(desc_key) {
    return Some(id);
  }

  let obj = desc.as_object()?;

  // Allocate ID before recursing (prevents infinite recursion)
  let id = registry.alloc_id();
  compiled_map.insert(desc_key.to_owned(), id);

  let name = obj.get("name").and_then(Value::as_str).map(str::to_owned);
  let content_name = obj.get("contentName").and_then(Value::as_str).map(str::to_owned);

  if let Some(match_re) = obj.get("match").and_then(Value::as_str) {
    // MatchRule
    let captures = parse_grammar_captures(obj.get("captures"));
    registry.store(id, Rule::Match {
      _id: id,
      name,
      match_re: match_re.to_owned(),
      captures,
    });
    return Some(id);
  }

  if let Some(begin_re) = obj.get("begin").and_then(Value::as_str) {
    let while_re = obj.get("while").and_then(Value::as_str);

    if let Some(while_re_str) = while_re {
      // BeginWhileRule
      let captures = parse_grammar_captures(obj.get("captures"));
      let mut begin_captures = parse_grammar_captures(obj.get("beginCaptures"));
      if begin_captures.is_empty() {
        begin_captures = captures.clone();
      }
      let mut while_captures = parse_grammar_captures(obj.get("whileCaptures"));
      if while_captures.is_empty() {
        while_captures = captures;
      }
      let patterns = compile_patterns_inner(
        obj.get("set").or_else(|| obj.get("patterns")),
        registry,
        compiled_map,
        repository,
        grammar_pool,
        desc_key,
        host_grammar,
        depth,
      );
      registry.store(id, Rule::BeginWhile {
        _id: id,
        name,
        content_name,
        begin_re: begin_re.to_owned(),
        while_re: while_re_str.to_owned(),
        while_has_back_references: has_back_references(while_re_str),
        begin_captures,
        while_captures,
        patterns,
      });
      return Some(id);
    }

    // BeginEndRule
    let end_re_str = obj.get("end").and_then(Value::as_str).unwrap_or("\u{FFFF}");
    let captures = parse_grammar_captures(obj.get("captures"));
    let mut begin_captures = parse_grammar_captures(obj.get("beginCaptures"));
    if begin_captures.is_empty() {
      begin_captures = captures.clone();
    }
    let mut end_captures = parse_grammar_captures(obj.get("endCaptures"));
    if end_captures.is_empty() {
      end_captures = captures;
    }
    let apply_end_pattern_last = obj
      .get("applyEndPatternLast")
      .and_then(|v| v.as_bool().or_else(|| v.as_u64().map(|n| n != 0)))
      .unwrap_or(false);
    let patterns = compile_patterns_inner(
      obj.get("set").or_else(|| obj.get("patterns")),
      registry,
      compiled_map,
      repository,
      grammar_pool,
      desc_key,
      host_grammar,
      depth,
    );
    registry.store(id, Rule::BeginEnd {
      _id: id,
      name,
      content_name,
      begin_re: begin_re.to_owned(),
      end_re: end_re_str.to_owned(),
      end_has_back_references: has_back_references(end_re_str),
      apply_end_pattern_last,
      begin_captures,
      end_captures,
      patterns,
    });
    return Some(id);
  }

  // IncludeOnlyRule: has patterns (or is a bare include wrapper)
  // If it has an include directive, wrap it in patterns
  let nested_patterns = if obj.contains_key("include") {
    // Bare include — treat as a single-element patterns list
    compile_patterns_inner(
      Some(&json!([desc.clone()])),
      registry,
      compiled_map,
      repository,
      grammar_pool,
      desc_key,
      host_grammar,
      depth,
    )
  } else {
    compile_patterns_inner(
      obj.get("patterns").or_else(|| obj.get("set")),
      registry,
      compiled_map,
      repository,
      grammar_pool,
      desc_key,
      host_grammar,
      depth,
    )
  };

  registry.store(id, Rule::IncludeOnly {
    _id: id,
    _name: name,
    _content_name: content_name,
    patterns: nested_patterns,
  });
  Some(id)
}

/// Port of vscode-textmate _compilePatterns().
/// Resolves include references and returns a Vec of RuleIds.
fn compile_patterns(
  patterns: Option<&Value>,
  registry: &mut RuleRegistry,
  compiled_map: &mut HashMap<String, RuleId>,
  repository: &serde_json::Map<String, Value>,
  grammar_pool: &HashMap<String, Value>,
  parent_key: &str,
  host_grammar: Option<&Value>,
) -> Vec<RuleId> {
  compile_patterns_inner(patterns, registry, compiled_map, repository, grammar_pool, parent_key, host_grammar, 0)
}

/// Stable identifier for a repository, using the pointer address of the Map.
/// This ensures that the same repo key name in different grammars gets a distinct cache key.
fn repo_id(repository: &serde_json::Map<String, Value>) -> usize {
  repository as *const _ as usize
}

fn compile_patterns_inner(
  patterns: Option<&Value>,
  registry: &mut RuleRegistry,
  compiled_map: &mut HashMap<String, RuleId>,
  repository: &serde_json::Map<String, Value>,
  grammar_pool: &HashMap<String, Value>,
  parent_key: &str,
  host_grammar: Option<&Value>,
  depth: usize,
) -> Vec<RuleId> {
  let Some(Value::Array(items)) = patterns else {
    return Vec::new();
  };

  let mut out = Vec::new();
  for (idx, item) in items.iter().enumerate() {
    let Some(obj) = item.as_object() else {
      continue;
    };

    if let Some(include) = obj.get("include").and_then(Value::as_str) {
      // Handle include references
      if include == "$self" || include == "$base" {
        let key = include;
        if let Some(target) = repository.get(key) {
          // Use stable key scoped to this repository to enable memoization across call sites
          let desc_key = format!("{}:repo/{key}", repo_id(repository));
          if let Some(rule_id) = compile_rule_inner(target, registry, compiled_map, repository, grammar_pool, &desc_key, host_grammar, depth + 1) {
            out.push(rule_id);
          }
        }
        continue;
      }

      if let Some(key) = include.strip_prefix('#') {
        if let Some(target) = repository.get(key) {
          // Use stable key scoped to this repository to enable memoization.
          // This is critical for grammars with cycles (e.g. jsx-children ↔ jsx-tag).
          let desc_key = format!("{}:repo/{key}", repo_id(repository));
          if let Some(rule_id) = compile_rule_inner(target, registry, compiled_map, repository, grammar_pool, &desc_key, host_grammar, depth + 1) {
            out.push(rule_id);
          }
        }
        continue;
      }

      // Cross-grammar reference: "scope#key"
      if let Some((scope, key)) = include.split_once('#') {
        if !scope.is_empty() && !key.is_empty() {
          if let Some(target_grammar) = grammar_pool.get(scope) {
            // Pass the host grammar as $base for the target grammar
            let initialized = init_grammar(target_grammar, host_grammar);
            if let Some(target_obj) = initialized.as_object() {
              if let Some(target_repo) = target_obj.get("repository").and_then(Value::as_object) {
                if let Some(target_rule) = target_repo.get(key) {
                  let desc_key = format!("cross:{scope}#{key}");
                  if let Some(rule_id) = compile_rule_inner(target_rule, registry, compiled_map, target_repo, grammar_pool, &desc_key, host_grammar, depth + 1) {
                    out.push(rule_id);
                  }
                }
              }
            }
          }
        }
        continue;
      }

      // Top-level scope reference: "source.xxx"
      if let Some(target_grammar) = grammar_pool.get(include) {
        // Pass the host grammar as $base for the target grammar
        let initialized = init_grammar(target_grammar, host_grammar);
        if let Some(target_obj) = initialized.as_object() {
          if let Some(target_repo) = target_obj.get("repository").and_then(Value::as_object) {
            if let Some(self_entry) = target_repo.get("$self") {
              let desc_key = format!("scope:{include}/$self");
              if let Some(rule_id) = compile_rule_inner(self_entry, registry, compiled_map, target_repo, grammar_pool, &desc_key, host_grammar, depth + 1) {
                out.push(rule_id);
              }
            }
          }
        }
      }
      continue;
    }

    // Normal rule (not an include)
    let desc_key = format!("{parent_key}/pat/{idx}");
    if let Some(rule_id) = compile_rule_inner(item, registry, compiled_map, repository, grammar_pool, &desc_key, host_grammar, depth + 1) {
      out.push(rule_id);
    }
  }

  out
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanner compilation (port of Rule.collectPatterns / _getCachedCompiledPatterns)
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum number of regex patterns allowed per Scanner.
const MAX_SCANNER_PATTERNS: usize = 256;

/// Recursively collect (regex, rule_id) pairs from a rule's patterns.
fn collect_patterns(rule_id: RuleId, registry: &RuleRegistry, out: &mut Vec<(String, RuleId)>) {
  let Some(rule) = registry.get(rule_id) else {
    return;
  };

  match rule {
    Rule::Match { match_re, _id, .. } => {
      out.push((match_re.clone(), *_id));
    }
    Rule::IncludeOnly { patterns, .. } => {
      for &pat_id in patterns {
        if out.len() >= MAX_SCANNER_PATTERNS {
          break;
        }
        collect_patterns(pat_id, registry, out);
      }
    }
    Rule::BeginEnd { begin_re, _id, .. } => {
      out.push((begin_re.clone(), *_id));
    }
    Rule::BeginWhile { begin_re, _id, .. } => {
      out.push((begin_re.clone(), *_id));
    }
  }
}

/// Build a compiled scanner for matching against a rule's child patterns,
/// optionally including an end pattern.
fn build_scanner_for_rule(
  rule_id: RuleId,
  registry: &RuleRegistry,
  end_re: Option<&str>,
  apply_end_pattern_last: bool,
) -> Option<CompiledScanner> {
  let mut pattern_pairs: Vec<(String, RuleId)> = Vec::new();

  // Collect child patterns
  let Some(rule) = registry.get(rule_id) else {
    return None;
  };

  let child_patterns = match rule {
    Rule::IncludeOnly { patterns, .. } => patterns.clone(),
    Rule::BeginEnd { patterns, .. } => patterns.clone(),
    Rule::BeginWhile { patterns, .. } => patterns.clone(),
    Rule::Match { .. } => Vec::new(),
  };

  // Insert end pattern (if any) at beginning or end based on applyEndPatternLast
  if !apply_end_pattern_last {
    if let Some(end) = end_re {
      pattern_pairs.push((end.to_owned(), END_RULE_ID));
    }
  }

  for &pat_id in &child_patterns {
    if pattern_pairs.len() >= MAX_SCANNER_PATTERNS {
      break;
    }
    collect_patterns(pat_id, registry, &mut pattern_pairs);
  }

  if apply_end_pattern_last {
    if let Some(end) = end_re {
      if pattern_pairs.len() < MAX_SCANNER_PATTERNS {
        pattern_pairs.push((end.to_owned(), END_RULE_ID));
      }
    }
  }

  if pattern_pairs.is_empty() {
    return None;
  }

  // Build scanner, filtering out invalid regexes
  let regexes: Vec<String> = pattern_pairs.iter().map(|(re, _)| re.clone()).collect();
  let rule_ids: Vec<RuleId> = pattern_pairs.iter().map(|(_, id)| *id).collect();

  if regexes.len() > 128 {
    // For large pattern sets, try building the scanner directly
    let regex_refs: Vec<&str> = regexes.iter().map(String::as_str).collect();
    match Scanner::new(&regex_refs) {
      Ok(scanner) => {
        let single_scanners = std::iter::repeat_with(|| None)
          .take(regexes.len())
          .collect();
        Some(CompiledScanner {
          scanner,
          rule_ids,
          regexes,
          single_scanners,
        })
      }
      Err(_) => None,
    }
  } else {
    // For smaller sets, validate each regex individually
    let mut valid_regexes = Vec::new();
    let mut valid_ids = Vec::new();
    for (regex, rule_id) in regexes.into_iter().zip(rule_ids.into_iter()) {
      if Scanner::new(&[regex.as_str()]).is_ok() {
        valid_regexes.push(regex);
        valid_ids.push(rule_id);
      }
    }

    if valid_regexes.is_empty() {
      return None;
    }

    let regex_refs: Vec<&str> = valid_regexes.iter().map(String::as_str).collect();
    match Scanner::new(&regex_refs) {
      Ok(scanner) => {
        let single_scanners = std::iter::repeat_with(|| None)
          .take(valid_regexes.len())
          .collect();
        Some(CompiledScanner {
          scanner,
          rule_ids: valid_ids,
          regexes: valid_regexes,
          single_scanners,
        })
      }
      Err(_) => None,
    }
  }
}

fn find_next_match_ordered(
  compiled_scanner: &mut CompiledScanner,
  input: &OnigString,
  line_str_id: u64,
  cursor: usize,
  find_options: ScannerFindOptions,
) -> Option<ferroni::scanner::ScannerMatch> {
  let best = compiled_scanner
    .scanner
    .find_next_match_utf16_with_id(input, line_str_id, cursor, find_options)?;
  let mut best_match = best;
  let mut best_start = best_match
    .capture_indices
    .first()
    .map(|capture| capture.start)
    .unwrap_or(usize::MAX);

  for index in 0..best_match.index {
    if compiled_scanner.single_scanners[index].is_none() {
      compiled_scanner.single_scanners[index] =
        Scanner::new(&[compiled_scanner.regexes[index].as_str()]).ok();
    }
    let Some(scanner) = compiled_scanner.single_scanners[index].as_mut() else {
      continue;
    };
    let Some(candidate) = scanner.find_next_match_utf16_with_id(input, line_str_id, cursor, find_options) else {
      continue;
    };
    let candidate_start = candidate
      .capture_indices
      .first()
      .map(|capture| capture.start)
      .unwrap_or(usize::MAX);
    if candidate_start < best_start || candidate_start == best_start {
      best_start = candidate_start;
      best_match = candidate;
      if best_start == cursor {
        break;
      }
    }
  }

  Some(best_match)
}

// ─────────────────────────────────────────────────────────────────────────────
// Injection compilation
// ─────────────────────────────────────────────────────────────────────────────

fn collect_injections(
  grammar: &Value,
  registry: &mut RuleRegistry,
  compiled_map: &mut HashMap<String, RuleId>,
  repository: &serde_json::Map<String, Value>,
  grammar_pool: &HashMap<String, Value>,
) -> Vec<Injection> {
  let Some(obj) = grammar.as_object() else {
    return Vec::new();
  };

  let Some(injections) = obj.get("injections").and_then(Value::as_object) else {
    return Vec::new();
  };

  let mut result = Vec::new();

  for (selector, injection_value) in injections {
    let compiled_selector = compile_selector(selector);
    if compiled_selector.clauses.is_empty() {
      continue;
    }

    let (priority, _normalized) = parse_injection_clause_priority(selector);

    // Compile the injection rule
    let desc_key = format!("injection:{selector}");
    if let Some(rule_id) = compile_rule(injection_value, registry, compiled_map, repository, grammar_pool, &desc_key, None) {
      result.push(Injection {
        compiled_selector,
        rule_id,
        priority,
      });
    }
  }

  result
}

/// Collect an external injection from a grammar that declares `injectTo` targeting
/// the grammar being compiled. Reads the `injectionSelector` from the external
/// grammar's top-level field and compiles the external grammar's root patterns
/// as an injection rule.
fn collect_external_injection(
  ext_grammar: &Value,
  injections: &mut Vec<Injection>,
  registry: &mut RuleRegistry,
  compiled_map: &mut HashMap<String, RuleId>,
  _repository: &serde_json::Map<String, Value>,
  grammar_pool: &HashMap<String, Value>,
) {
  let ext_obj = match ext_grammar.as_object() {
    Some(obj) => obj,
    None => return,
  };

  // The injectionSelector is a top-level field on the grammar JSON
  let selector = match ext_obj.get("injectionSelector").and_then(Value::as_str) {
    Some(s) if !s.is_empty() => s.to_owned(),
    _ => return,
  };
  let compiled_selector = compile_selector(&selector);
  if compiled_selector.clauses.is_empty() {
    return;
  }

  let (priority, _normalized) = parse_injection_clause_priority(&selector);

  let ext_scope = ext_obj.get("scopeName").and_then(Value::as_str).unwrap_or("");
  let desc_key = format!("external-injection:{ext_scope}");

  // Build the external grammar's patterns as an injection rule.
  // We initialize the external grammar (which merges repository/$base/$self)
  // and compile its $self entry as the injection rule.
  let initialized = init_grammar(ext_grammar, None);
  let init_obj = match initialized.as_object() {
    Some(obj) => obj,
    None => return,
  };
  let ext_repo = match init_obj.get("repository").and_then(Value::as_object) {
    Some(r) => r,
    None => return,
  };
  let self_entry = match ext_repo.get("$self") {
    Some(e) => e,
    None => return,
  };

  if let Some(rule_id) = compile_rule(self_entry, registry, compiled_map, ext_repo, grammar_pool, &desc_key, Some(ext_grammar)) {
    injections.push(Injection {
      compiled_selector,
      rule_id,
      priority,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Grammar compilation (caching entry point)
// ─────────────────────────────────────────────────────────────────────────────

fn compile_grammar(
  grammar: &Value,
  grammar_pool: &HashMap<String, Value>,
  injection_map: &HashMap<String, Vec<String>>,
) -> Result<CompiledGrammar> {
  let initialized = init_grammar(grammar, None);
  let obj = initialized.as_object().ok_or_else(|| Error::from_reason("Grammar is not an object"))?;
  let repository = obj.get("repository").and_then(Value::as_object)
    .ok_or_else(|| Error::from_reason("Grammar has no repository"))?;

  let mut registry = RuleRegistry::new();
  let mut compiled_map: HashMap<String, RuleId> = HashMap::new();

  let self_entry = repository.get("$self")
    .ok_or_else(|| Error::from_reason("Grammar missing $self after init"))?;
  let root_rule_id = compile_rule(
    self_entry,
    &mut registry,
    &mut compiled_map,
    repository,
    grammar_pool,
    "root/$self",
    Some(grammar),
  ).ok_or_else(|| Error::from_reason("Failed to compile root grammar rule"))?;

  let mut injections = collect_injections(
    &initialized,
    &mut registry,
    &mut compiled_map,
    repository,
    grammar_pool,
  );

  // Collect external injections from the injection map
  let scope_name = grammar.get("scopeName").and_then(Value::as_str).unwrap_or("");
  if !scope_name.is_empty() {
    let scope_parts: Vec<&str> = scope_name.split('.').collect();
    for i in 1..=scope_parts.len() {
      let sub_scope = scope_parts[..i].join(".");
      if let Some(injecting_scopes) = injection_map.get(&sub_scope) {
        for injecting_scope in injecting_scopes {
          if let Some(ext_grammar) = grammar_pool.get(injecting_scope) {
            collect_external_injection(
              ext_grammar,
              &mut injections,
              &mut registry,
              &mut compiled_map,
              repository,
              grammar_pool,
            );
          }
        }
      }
    }
  }

  let mut scanner_cache: HashMap<(RuleId, Option<String>), CompiledScanner> = HashMap::new();
  let root_scanner = build_scanner_for_rule(root_rule_id, &registry, None, false);
  if let Some(scanner) = root_scanner {
    scanner_cache.insert((root_rule_id, None), scanner);
  }

  Ok(CompiledGrammar {
    registry,
    root_rule_id,
    injections,
    scanner_cache,
    injection_scanner_cache: HashMap::new(),
    while_scanner_cache: HashMap::new(),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenization helpers (mostly unchanged)
// ─────────────────────────────────────────────────────────────────────────────

fn push_styled_slice(
  out: &mut Vec<StyledJsonToken>,
  utf16_map: &[usize],
  code: &str,
  start_utf16: usize,
  end_utf16: usize,
  color: &Arc<str>,
  font_style: u8,
) -> Result<()> {
  if end_utf16 <= start_utf16 || end_utf16 >= utf16_map.len() {
    return Ok(());
  }

  let start_byte = utf16_map[start_utf16];
  let end_byte = utf16_map[end_utf16];
  let content = code
    .get(start_byte..end_byte)
    .ok_or_else(|| Error::from_reason("Ferriki grammar tokenizer failed to slice source text."))?;

  if content.is_empty() {
    return Ok(());
  }

  let utf16_len = end_utf16 - start_utf16;
  out.push(StyledJsonToken {
    content: content.to_owned(),
    content_utf16_len: utf16_len,
    offset_utf16: start_utf16,
    color: color.clone(),
    font_style,
    dark_color: None,
  });
  Ok(())
}

struct CaptureRange {
  start: usize,
  end: usize,
  color: Arc<str>,
  font_style: u8,
}

fn push_with_capture_ranges(
  out: &mut Vec<StyledJsonToken>,
  utf16_map: &[usize],
  code: &str,
  match_start_utf16: usize,
  match_end_utf16: usize,
  base_color: &Arc<str>,
  base_font_style: u8,
  mut capture_ranges: Vec<CaptureRange>,
) -> Result<()> {
  if capture_ranges.is_empty() {
    return push_styled_slice(
      out,
      utf16_map,
      code,
      match_start_utf16,
      match_end_utf16,
      base_color,
      base_font_style,
    );
  }

  capture_ranges.sort_by(|a, b| a.start.cmp(&b.start).then(a.end.cmp(&b.end)));

  let mut cursor = match_start_utf16;
  for cr in &capture_ranges {
    if cr.start > cursor {
      push_styled_slice(out, utf16_map, code, cursor, cr.start, base_color, base_font_style)?;
    }
    let segment_start = cr.start.max(cursor);
    if cr.end > segment_start {
      push_styled_slice(out, utf16_map, code, segment_start, cr.end, &cr.color, cr.font_style)?;
      cursor = cr.end;
    }
  }

  if match_end_utf16 > cursor {
    push_styled_slice(out, utf16_map, code, cursor, match_end_utf16, base_color, base_font_style)?;
  }

  Ok(())
}

fn escape_regex_literal(input: &str) -> String {
  let mut out = String::with_capacity(input.len());
  for ch in input.chars() {
    match ch {
      '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' => {
        out.push('\\');
        out.push(ch);
      }
      _ => out.push(ch),
    }
  }
  out
}

fn resolve_pattern_backrefs(
  pattern: &str,
  capture_indices: &[ferroni::scanner::CaptureIndex],
  utf16_map: &[usize],
  code: &str,
) -> String {
  let mut out = String::with_capacity(pattern.len());
  let mut chars = pattern.chars().peekable();

  while let Some(ch) = chars.next() {
    if ch != '\\' {
      out.push(ch);
      continue;
    }

    let mut digits = String::new();
    while let Some(next) = chars.peek() {
      if next.is_ascii_digit() {
        digits.push(*next);
        chars.next();
      }
      else {
        break;
      }
    }

    if digits.is_empty() {
      out.push('\\');
      continue;
    }

    let Ok(index) = digits.parse::<usize>() else {
      continue;
    };
    let Some(range) = capture_indices.get(index) else {
      continue;
    };
    if range.end <= range.start {
      continue;
    }
    if range.start >= utf16_map.len() || range.end >= utf16_map.len() {
      continue;
    }

    let start_byte = utf16_map[range.start];
    let end_byte = utf16_map[range.end];
    let Some(captured) = code.get(start_byte..end_byte) else {
      continue;
    };

    out.push_str(&escape_regex_literal(captured));
  }

  out
}

fn resolve_capture_name_backrefs(
  pattern: &str,
  capture_indices: &[ferroni::scanner::CaptureIndex],
  utf16_map: &[usize],
  code: &str,
) -> String {
  let mut out = String::with_capacity(pattern.len());
  let chars = pattern.as_bytes();
  let mut index = 0usize;

  while index < chars.len() {
    if chars[index] != b'$' {
      out.push(chars[index] as char);
      index += 1;
      continue;
    }

    if index + 1 >= chars.len() {
      out.push('$');
      index += 1;
      continue;
    }

    if chars[index + 1] == b'{' {
      let mut cursor = index + 2;
      let mut digits = String::new();
      while cursor < chars.len() && chars[cursor].is_ascii_digit() {
        digits.push(chars[cursor] as char);
        cursor += 1;
      }

      let mut transform = None;
      if cursor + 2 < chars.len() && chars[cursor] == b':' && chars[cursor + 1] == b'/' {
        cursor += 2;
        let start = cursor;
        while cursor < chars.len() && chars[cursor] != b'}' {
          cursor += 1;
        }
        if cursor <= chars.len() {
          transform = std::str::from_utf8(&chars[start..cursor]).ok();
        }
      }

      if cursor < chars.len() && chars[cursor] == b'}' {
        if let Some(captured) = resolve_capture_reference(&digits, capture_indices, utf16_map, code) {
          match transform {
            Some("downcase") => out.push_str(&captured.to_lowercase()),
            Some("upcase") => out.push_str(&captured.to_uppercase()),
            _ => out.push_str(&captured),
          }
          index = cursor + 1;
          continue;
        }
      }
    }

    let mut cursor = index + 1;
    let mut digits = String::new();
    while cursor < chars.len() && chars[cursor].is_ascii_digit() {
      digits.push(chars[cursor] as char);
      cursor += 1;
    }
    if let Some(captured) = resolve_capture_reference(&digits, capture_indices, utf16_map, code) {
      out.push_str(&captured);
      index = cursor;
      continue;
    }

    out.push('$');
    index += 1;
  }

  out
}

fn resolve_capture_reference(
  digits: &str,
  capture_indices: &[ferroni::scanner::CaptureIndex],
  utf16_map: &[usize],
  code: &str,
) -> Option<String> {
  let index = digits.parse::<usize>().ok()?;
  let range = capture_indices.get(index)?;
  if range.end <= range.start || range.start >= utf16_map.len() || range.end >= utf16_map.len() {
    return None;
  }
  let start_byte = utf16_map[range.start];
  let end_byte = utf16_map[range.end];
  code.get(start_byte..end_byte).map(str::to_owned)
}

fn build_scope_stack_from_frames(stack: &[StateFrame], root_scope: Option<&str>) -> Vec<String> {
  let mut scopes = Vec::new();
  if let Some(root) = root_scope {
    scopes.push(root.to_owned());
  }
  for frame in stack {
    for s in &frame.name_scopes {
      scopes.push(s.clone());
    }
    for s in &frame.content_scopes {
      scopes.push(s.clone());
    }
  }
  scopes
}

fn resolve_color_for_scope_stack_owned(scope_stack: &[String], theme: &ThemeData, cache: &mut ThemeCache) -> (Arc<str>, u8) {
  let style = cache.resolve_owned(scope_stack, theme);
  let color = style.foreground.clone().unwrap_or_else(|| theme.fg_normalized.clone());
  (color, style.font_style)
}

fn resolve_color_with_extra_scope(scope_stack: &[String], extra: &str, theme: &ThemeData, cache: &mut ThemeCache) -> (Arc<str>, u8) {
  let style = cache.resolve_with_extra_owned(scope_stack, extra, theme);
  let color = style.foreground.clone().unwrap_or_else(|| theme.fg_normalized.clone());
  (color, style.font_style)
}

fn is_line_start_utf16(cursor_utf16: usize, utf16_map: &[usize], code: &str) -> bool {
  if cursor_utf16 == 0 {
    return true;
  }
  if cursor_utf16 >= utf16_map.len() {
    return false;
  }
  let byte_idx = utf16_map[cursor_utf16];
  if byte_idx == 0 {
    return true;
  }
  code.as_bytes().get(byte_idx.saturating_sub(1)) == Some(&b'\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Main tokenization loop (port of vscode-textmate _tokenizeString)
// ─────────────────────────────────────────────────────────────────────────────

fn tokenize_with_grammar_skeleton(
  code: &str,
  compiled: &mut CompiledGrammar,
  root_scope: Option<&str>,
  theme: &ThemeData,
  initial_stack: Option<Vec<StateFrame>>,
) -> Result<(Vec<StyledJsonToken>, Vec<StateFrame>)> {
  let root_rule_id = compiled.root_rule_id;

  if !compiled.scanner_cache.contains_key(&(root_rule_id, None)) {
    let default_fg = theme.fg_normalized.clone();
    let default_stack = initial_stack.unwrap_or_else(|| vec![StateFrame {
      rule_id: root_rule_id,
      _enter_pos: -1,
      _anchor_pos: 0,
      end_rule: None,
      name_scopes: Vec::new(),
      content_scopes: Vec::new(),
    }]);
    let utf16_len = code.encode_utf16().count();
    return Ok((vec![StyledJsonToken {
      content: code.to_owned(),
      content_utf16_len: utf16_len,
      offset_utf16: 0,
      color: default_fg,
      font_style: 0,
      dark_color: None,
    }], default_stack));
  }

  // Build state stack
  let mut stack: Vec<StateFrame> = initial_stack.unwrap_or_else(|| vec![StateFrame {
    rule_id: root_rule_id,
    _enter_pos: -1,
    _anchor_pos: 0,
    end_rule: None,
    name_scopes: Vec::new(),
    content_scopes: Vec::new(),
  }]);

  // ── Global UTF-16 map (for output positioning) ──
  let utf16_map = utf16_to_byte_map(code);
  let total_utf16 = utf16_map.len().saturating_sub(1);
  let find_options = ScannerFindOptions::from_bits(0);
  let mut out = Vec::new();

  // Safeguards against infinite loops
  let max_iterations = code.len().saturating_mul(10).max(50_000);
  let mut iterations = 0usize;
  let max_stack_depth: usize = 64;
  let deadline = Instant::now() + Duration::from_secs(30);

  // ── Theme resolution cache ──
  let mut theme_cache = ThemeCache::new();

  // ── Scope-stack & color cache ──
  let mut stack_generation: u64 = 0;
  let mut cached_scope_stack: Vec<String> = build_scope_stack_from_frames(&stack, root_scope);
  let (mut cached_color, mut cached_font_style) = resolve_color_for_scope_stack_owned(&cached_scope_stack, theme, &mut theme_cache);
  let mut cached_generation: u64 = 0;

  // ── Per-line tokenization (like vscode-textmate) ──
  // Split code into lines and process each line with a line-local OnigString.
  // This avoids O(n²) scanning of the full code string on every match.
  let lines: Vec<&str> = code.split('\n').collect();
  let mut global_offset_utf16: usize = 0;
  // Cache frame info to avoid repeated extraction when stack hasn't changed
  let mut last_cache_key: Option<(RuleId, Option<String>)> = None;
  let mut cached_frame_is_while: bool = false;
  let mut cached_frame_apply_end_last: bool = false;
  let mut injection_cache_generation: u64 = u64::MAX;
  let mut active_injections: Vec<(RuleId, InjectionPriority)> = Vec::new();
  let mut selector_scope_match_cache: Vec<HashMap<String, bool>> = (0..compiled.injections.len())
    .map(|_| HashMap::new())
    .collect();

  'line_loop: for (line_idx, &line_text) in lines.iter().enumerate() {
    // Build line text with trailing \n (except last line)
    let has_newline = line_idx < lines.len() - 1;
    let line_with_nl: String;
    let line_str: &str;
    if has_newline {
      let mut buf = String::with_capacity(line_text.len() + 1);
      buf.push_str(line_text);
      buf.push('\n');
      line_with_nl = buf;
      line_str = &line_with_nl;
    } else {
      line_with_nl = String::new(); // unused
      line_str = line_text;
    }
    let line_input = OnigString::new(line_str);
    let line_str_id = NEXT_ONIG_STR_ID.fetch_add(1, Ordering::Relaxed);
    let line_utf16_map = utf16_to_byte_map(line_str);
    let line_utf16_len = line_utf16_map.len().saturating_sub(1);

    if line_utf16_len == 0 {
      global_offset_utf16 += if has_newline { 1 } else { 0 };
      continue;
    }

    let mut cursor: usize = 0; // line-local cursor (UTF-16 units)
    let mut zero_width_count = 0usize;
    let mut last_zero_width_pos = usize::MAX;
    let mut last_zero_width_generation = u64::MAX;

    // While-condition check at start of each line (except first)
    if line_idx > 0 && !stack.is_empty() {
      let top_rule_id = stack.last().map(|f| f.rule_id).unwrap_or(0);
      let top_is_while = matches!(compiled.registry.get(top_rule_id), Some(Rule::BeginWhile { .. }));
      if top_is_while {
        let while_re = {
          let frame = stack.last().unwrap();
          if let Some(end_rule) = &frame.end_rule {
            Some(end_rule.clone())
          } else if let Some(Rule::BeginWhile { while_re, .. }) = compiled.registry.get(top_rule_id) {
            Some(while_re.clone())
          } else {
            None
          }
        };

        if let Some(while_re) = while_re {
          let while_matched = {
            let scanner = compiled.while_scanner_cache
              .entry(while_re.clone())
              .or_insert_with(|| Scanner::new(&[while_re.as_str()]).expect("while scanner compile"));
            scanner.find_next_match_utf16(&line_input, 0, find_options)
          };

          if cached_generation != stack_generation {
            cached_scope_stack = build_scope_stack_from_frames(&stack, root_scope);
            let (c, fs) = resolve_color_for_scope_stack_owned(&cached_scope_stack, theme, &mut theme_cache);
            cached_color = c;
            cached_font_style = fs;
            cached_generation = stack_generation;
          }

          if let Some(found_while) = while_matched {
            let first = found_while.capture_indices.first()
              .ok_or_else(|| Error::from_reason("While scanner returned match without capture 0."))?;
            let while_start = first.start;
            let while_end = first.end;

            if while_start != 0 {
              if stack.len() > 1 {
                stack.pop();
                stack_generation += 1;
                // Don't skip line — continue tokenizing it with the new stack
              }
            } else if while_end <= while_start {
              if stack.len() > 1 {
                stack.pop();
                stack_generation += 1;
              }
            } else {
              // While matched — handle captures and advance cursor
              let while_captures: &[GrammarCapture] = if let Some(Rule::BeginWhile { while_captures, .. }) = compiled.registry.get(top_rule_id) {
                while_captures
              } else {
                &[]
              };

              let scope_stack = &cached_scope_stack;
              let mut capture_ranges = Vec::new();
              for capture in while_captures {
                let Some(range) = found_while.capture_indices.get(capture.index) else { continue };
                if range.end <= range.start { continue; }
                if range.start < while_start || range.end > while_end { continue; }
                let (cap_color, cap_fs) = if let Some(name) = capture.name.as_deref() {
                  let resolved_name = resolve_capture_name_backrefs(
                    name,
                    &found_while.capture_indices,
                    &line_utf16_map,
                    line_str,
                  );
                  resolve_color_with_extra_scope(scope_stack, &resolved_name, theme, &mut theme_cache)
                } else {
                  (cached_color.clone(), cached_font_style)
                };
                capture_ranges.push(CaptureRange {
                  start: while_start + global_offset_utf16,
                  end: range.end + global_offset_utf16,
                  color: cap_color,
                  font_style: cap_fs,
                });
              }
              // Adjust capture ranges back to global coordinates for output
              let global_while_start = while_start + global_offset_utf16;
              let global_while_end = while_end + global_offset_utf16;
              let mut cap_ranges_global = Vec::new();
              for capture in while_captures {
                let Some(range) = found_while.capture_indices.get(capture.index) else { continue };
                if range.end <= range.start { continue; }
                if range.start < while_start || range.end > while_end { continue; }
                let (cap_color, cap_fs) = if let Some(name) = capture.name.as_deref() {
                  let resolved_name = resolve_capture_name_backrefs(
                    name,
                    &found_while.capture_indices,
                    &line_utf16_map,
                    line_str,
                  );
                  resolve_color_with_extra_scope(&cached_scope_stack, &resolved_name, theme, &mut theme_cache)
                } else {
                  (cached_color.clone(), cached_font_style)
                };
                cap_ranges_global.push(CaptureRange {
                  start: range.start + global_offset_utf16,
                  end: range.end + global_offset_utf16,
                  color: cap_color,
                  font_style: cap_fs,
                });
              }
              push_with_capture_ranges(&mut out, &utf16_map, code, global_while_start, global_while_end, &cached_color, cached_font_style, cap_ranges_global)?;
              cursor = while_end;
            }
          } else if stack.len() > 1 {
            stack.pop();
            stack_generation += 1;
          }
        }
      }
    }

    // ── Inner loop: process matches within this line ──
    while cursor < line_utf16_len {
      iterations += 1;
      if iterations > max_iterations || (iterations & 1023 == 0 && Instant::now() > deadline) {
        // Bail out — emit rest of file as single token
        let remaining_global = cursor + global_offset_utf16;
        if remaining_global < total_utf16 {
          if cached_generation != stack_generation {
            cached_scope_stack = build_scope_stack_from_frames(&stack, root_scope);
            let (c, fs) = resolve_color_for_scope_stack_owned(&cached_scope_stack, theme, &mut theme_cache);
            cached_color = c;
            cached_font_style = fs;
            cached_generation = stack_generation;
          }
          push_styled_slice(&mut out, &utf16_map, code, remaining_global, total_utf16, &cached_color, cached_font_style)?;
        }
        break 'line_loop;
      }

      if stack.is_empty() {
        break 'line_loop;
      }

      // Get or build scanner for current frame (cached across iterations)
      if cached_generation != stack_generation || last_cache_key.is_none() {
        let frame_rule_id_new = stack.last().map(|f| f.rule_id).unwrap_or(0);
        let frame_is_while_new = matches!(compiled.registry.get(frame_rule_id_new), Some(Rule::BeginWhile { .. }));
        let frame_end_rule_new = if frame_is_while_new {
          None
        } else {
          stack.last().and_then(|f| f.end_rule.clone())
        };
        let frame_apply_end_last_new = if let Some(Rule::BeginEnd { apply_end_pattern_last, .. }) = compiled.registry.get(frame_rule_id_new) {
          *apply_end_pattern_last
        } else {
          false
        };
        last_cache_key = Some((frame_rule_id_new, frame_end_rule_new));
        cached_frame_is_while = frame_is_while_new;
        cached_frame_apply_end_last = frame_apply_end_last_new;
      }
      let cache_key = last_cache_key.as_ref().unwrap();
      let frame_rule_id = cache_key.0;
      let frame_is_while = cached_frame_is_while;
      if !compiled.scanner_cache.contains_key(cache_key) {
        let scanner = build_scanner_for_rule(
          frame_rule_id,
          &compiled.registry,
          cache_key.1.as_deref(),
          cached_frame_apply_end_last,
        );
        if let Some(scanner) = scanner {
          compiled.scanner_cache.insert(cache_key.clone(), scanner);
        }
      }

      // Refresh scope stack + color cache if stack changed
      if cached_generation != stack_generation {
        cached_scope_stack = build_scope_stack_from_frames(&stack, root_scope);
        let (c, fs) = resolve_color_for_scope_stack_owned(&cached_scope_stack, theme, &mut theme_cache);
        cached_color = c;
        cached_font_style = fs;
        cached_generation = stack_generation;
      }
      let scope_stack = &cached_scope_stack;
      let inherited_color = &cached_color;
      let inherited_font_style = cached_font_style;

      if !compiled.injections.is_empty() && injection_cache_generation != stack_generation {
        active_injections.clear();
        for (idx, injection) in compiled.injections.iter().enumerate() {
          let scope_cache = &mut selector_scope_match_cache[idx];
          let mut matches_scope = false;
          for scope in scope_stack.iter().rev() {
            let scope_matches = if let Some(cached) = scope_cache.get(scope) {
              *cached
            } else {
              let parsed = selector_matches_compiled(&injection.compiled_selector, scope);
              scope_cache.insert(scope.clone(), parsed);
              parsed
            };
            if scope_matches {
              matches_scope = true;
              break;
            }
          }

          if matches_scope {
            active_injections.push((injection.rule_id, injection.priority));
          }
        }
        injection_cache_generation = stack_generation;
      }

      // Scanner uses line-local OnigString and cursor
      let main_match = if let Some(cached_scanner) = compiled.scanner_cache.get_mut(cache_key) {
        let m = find_next_match_ordered(
          cached_scanner,
          &line_input,
          line_str_id,
          cursor,
          find_options,
        );
        m.map(|m| {
          let rule_id = cached_scanner.rule_ids.get(m.index).copied().unwrap_or(0);
          (m, rule_id)
        })
      } else {
        None
      };

      // Injection matches also use line-local input
      let injection_match = if !active_injections.is_empty() {
        find_injection_match(
          compiled,
          &active_injections,
          &line_input,
          line_str_id,
          cursor,
          find_options,
        )
      } else {
        None
      };

      // Pick the best match
      let (found, matched_rule_id) = match (main_match, injection_match) {
        (None, None) => {
          // No match in this line — emit rest of line
          if frame_is_while {
            // For while frames, emit to end of line (while check happens at next line start)
            let g_cursor = cursor + global_offset_utf16;
            let g_end = line_utf16_len + global_offset_utf16;
            push_styled_slice(&mut out, &utf16_map, code, g_cursor, g_end, inherited_color, inherited_font_style)?;
          } else {
            let g_cursor = cursor + global_offset_utf16;
            let g_end = line_utf16_len + global_offset_utf16;
            push_styled_slice(&mut out, &utf16_map, code, g_cursor, g_end, inherited_color, inherited_font_style)?;
          }
          break; // next line
        }
        (Some(m), None) => m,
        (None, Some((inj_found, inj_id, _))) => (inj_found, inj_id),
        (Some((main_found, main_id)), Some((inj_found, inj_id, inj_prio))) => {
          let main_start = main_found.capture_indices.first().map(|c| c.start).unwrap_or(usize::MAX);
          let inj_start = inj_found.capture_indices.first().map(|c| c.start).unwrap_or(usize::MAX);
          if inj_start < main_start {
            (inj_found, inj_id)
          } else if inj_start == main_start && inj_prio == InjectionPriority::Left {
            (inj_found, inj_id)
          } else {
            (main_found, main_id)
          }
        }
      };

      let first = found
        .capture_indices
        .first()
        .ok_or_else(|| Error::from_reason("Ferriki grammar scanner returned match without capture 0."))?;
      // Line-local match positions
      let start_local = first.start;
      let end_local = first.end;
      // Global positions for output
      let start_utf16 = start_local + global_offset_utf16;
      let end_utf16 = end_local + global_offset_utf16;

      if start_local > cursor {
        let g_cursor = cursor + global_offset_utf16;
        push_styled_slice(&mut out, &utf16_map, code, g_cursor, start_utf16, inherited_color, inherited_font_style)?;
        cursor = start_local;
        continue;
      }

      // Zero-width handling
      if end_local <= start_local {
        match matched_rule_id {
          END_RULE_ID => {
            if stack.len() > 1 {
              stack.pop();
              stack_generation += 1;
            }
            continue;
          }
          _ => {
            let is_begin = matches!(
              compiled.registry.get(matched_rule_id),
              Some(Rule::BeginEnd { .. }) | Some(Rule::BeginWhile { .. })
            );
            if !is_begin {
              cursor = start_local.saturating_add(1);
              continue;
            }
            // Fall through to begin handling below
          }
        }
      }

      // Dispatch based on matched rule type
      if matched_rule_id == END_RULE_ID {
        let end_captures: &[GrammarCapture] = if let Some(Rule::BeginEnd { end_captures, .. }) = compiled.registry.get(frame_rule_id) {
          end_captures
        } else {
          &[]
        };

        let mut capture_ranges = Vec::new();
        for capture in end_captures {
          let Some(range) = found.capture_indices.get(capture.index) else { continue };
          if range.end <= range.start { continue; }
          if range.start < start_local || range.end > end_local { continue; }
          let (cap_color, cap_fs) = if let Some(name) = capture.name.as_deref() {
            let resolved_name = resolve_capture_name_backrefs(
              name,
              &found.capture_indices,
              &line_utf16_map,
              line_str,
            );
            resolve_color_with_extra_scope(scope_stack, &resolved_name, theme, &mut theme_cache)
          } else {
            (inherited_color.clone(), inherited_font_style)
          };
          capture_ranges.push(CaptureRange {
            start: range.start + global_offset_utf16,
            end: range.end + global_offset_utf16,
            color: cap_color,
            font_style: cap_fs,
          });
        }
        push_with_capture_ranges(&mut out, &utf16_map, code, start_utf16, end_utf16, inherited_color, inherited_font_style, capture_ranges)?;
        if stack.len() > 1 {
          stack.pop();
          stack_generation += 1;
        }
      } else {
        let matched_rule = compiled.registry.get(matched_rule_id);

        match matched_rule {
          Some(Rule::Match { name, captures, .. }) => {
            let (color, font_style) = if let Some(n) = name.as_deref() {
              resolve_color_with_extra_scope(scope_stack, n, theme, &mut theme_cache)
            } else {
              (inherited_color.clone(), inherited_font_style)
            };
            let mut capture_ranges = Vec::new();
            for capture in captures {
              let Some(range) = found.capture_indices.get(capture.index) else { continue };
              if range.end <= range.start { continue; }
              if range.start < start_local || range.end > end_local { continue; }
              let (cap_color, cap_fs) = if let Some(n) = capture.name.as_deref() {
                let resolved_name = resolve_capture_name_backrefs(
                  n,
                  &found.capture_indices,
                  &line_utf16_map,
                  line_str,
                );
                resolve_color_with_extra_scope(scope_stack, &resolved_name, theme, &mut theme_cache)
              } else {
                (color.clone(), font_style)
              };
              capture_ranges.push(CaptureRange {
                start: range.start + global_offset_utf16,
                end: range.end + global_offset_utf16,
                color: cap_color,
                font_style: cap_fs,
              });
            }
            push_with_capture_ranges(&mut out, &utf16_map, code, start_utf16, end_utf16, &color, font_style, capture_ranges)?;
          }

          Some(Rule::BeginEnd { name, content_name, end_re, end_has_back_references, begin_captures, apply_end_pattern_last: _, .. }) => {
            let resolved_end_re = if *end_has_back_references {
              resolve_pattern_backrefs(end_re, &found.capture_indices, &line_utf16_map, line_str)
            } else {
              end_re.clone()
            };

            let (color, font_style) = if let Some(n) = name.as_deref() {
              resolve_color_with_extra_scope(scope_stack, n, theme, &mut theme_cache)
            } else {
              (inherited_color.clone(), inherited_font_style)
            };

            let mut capture_ranges = Vec::new();
            for capture in begin_captures {
              let Some(range) = found.capture_indices.get(capture.index) else { continue };
              if range.end <= range.start { continue; }
              if range.start < start_local || range.end > end_local { continue; }
              let (cap_color, cap_fs) = if let Some(n) = capture.name.as_deref() {
                let resolved_name = resolve_capture_name_backrefs(
                  n,
                  &found.capture_indices,
                  &line_utf16_map,
                  line_str,
                );
                resolve_color_with_extra_scope(scope_stack, &resolved_name, theme, &mut theme_cache)
              } else {
                (color.clone(), font_style)
              };
              capture_ranges.push(CaptureRange {
                start: range.start + global_offset_utf16,
                end: range.end + global_offset_utf16,
                color: cap_color,
                font_style: cap_fs,
              });
            }

            if end_utf16 > start_utf16 {
              push_with_capture_ranges(&mut out, &utf16_map, code, start_utf16, end_utf16, &color, font_style, capture_ranges)?;
            }

            let name_scopes = name.clone().into_iter().collect();
            let content_scopes = content_name.clone().into_iter().collect();

            stack.push(StateFrame {
              rule_id: matched_rule_id,
              _enter_pos: start_utf16 as i32,
              _anchor_pos: end_utf16 as i32,
              end_rule: Some(resolved_end_re),
              name_scopes,
              content_scopes,
            });
            stack_generation += 1;
          }

          Some(Rule::BeginWhile { name, content_name, while_re, while_has_back_references, begin_captures, .. }) => {
            let resolved_while_re = if *while_has_back_references {
              resolve_pattern_backrefs(while_re, &found.capture_indices, &line_utf16_map, line_str)
            } else {
              while_re.clone()
            };

            let (color, font_style) = if let Some(n) = name.as_deref() {
              resolve_color_with_extra_scope(scope_stack, n, theme, &mut theme_cache)
            } else {
              (inherited_color.clone(), inherited_font_style)
            };

            let mut capture_ranges = Vec::new();
            for capture in begin_captures {
              let Some(range) = found.capture_indices.get(capture.index) else { continue };
              if range.end <= range.start { continue; }
              if range.start < start_local || range.end > end_local { continue; }
              let (cap_color, cap_fs) = if let Some(n) = capture.name.as_deref() {
                let resolved_name = resolve_capture_name_backrefs(
                  n,
                  &found.capture_indices,
                  &line_utf16_map,
                  line_str,
                );
                resolve_color_with_extra_scope(scope_stack, &resolved_name, theme, &mut theme_cache)
              } else {
                (color.clone(), font_style)
              };
              capture_ranges.push(CaptureRange {
                start: range.start + global_offset_utf16,
                end: range.end + global_offset_utf16,
                color: cap_color,
                font_style: cap_fs,
              });
            }

            if end_utf16 > start_utf16 {
              push_with_capture_ranges(&mut out, &utf16_map, code, start_utf16, end_utf16, &color, font_style, capture_ranges)?;
            }

            let name_scopes = name.clone().into_iter().collect();
            let content_scopes = content_name.clone().into_iter().collect();

            stack.push(StateFrame {
              rule_id: matched_rule_id,
              _enter_pos: start_utf16 as i32,
              _anchor_pos: end_utf16 as i32,
              end_rule: Some(resolved_while_re),
              name_scopes,
              content_scopes,
            });
            stack_generation += 1;
          }

          Some(Rule::IncludeOnly { .. }) | None => {
            cursor = end_local.max(cursor.saturating_add(1));
            continue;
          }
        }
      }

      // Zero-width loop detection
      if end_local == cursor {
        if cursor == last_zero_width_pos && stack_generation == last_zero_width_generation {
          zero_width_count += 1;
          if zero_width_count > 3 {
            cursor = cursor.saturating_add(1);
            zero_width_count = 0;
            continue;
          }
        } else {
          last_zero_width_pos = cursor;
          last_zero_width_generation = stack_generation;
          zero_width_count = 1;
        }
      } else {
        zero_width_count = 0;
      }

      // Stack depth limit
      if stack.len() > max_stack_depth {
        if cached_generation != stack_generation {
          cached_scope_stack = build_scope_stack_from_frames(&stack, root_scope);
          let (c, fs) = resolve_color_for_scope_stack_owned(&cached_scope_stack, theme, &mut theme_cache);
          cached_color = c;
          cached_font_style = fs;
          cached_generation = stack_generation;
        }
        push_styled_slice(&mut out, &utf16_map, code, end_utf16, total_utf16, &cached_color, cached_font_style)?;
        break 'line_loop;
      }

      cursor = end_local;
    }

    // Advance global offset past this line.
    // line_utf16_len already includes the \n when has_newline is true,
    // because line_str includes it.
    global_offset_utf16 += line_utf16_len;
  }

  // Merge adjacent tokens with the same color and font_style
  let mut merged = Vec::with_capacity(out.len());
  for token in out {
    if let Some(last) = merged.last_mut() {
      let last: &mut StyledJsonToken = last;
      let last_end_utf16 = last.offset_utf16 + last.content_utf16_len;
      if last.color == token.color
        && last.font_style == token.font_style
        && last_end_utf16 == token.offset_utf16
      {
        last.content.push_str(&token.content);
        last.content_utf16_len += token.content_utf16_len;
        continue;
      }
    }
    merged.push(token);
  }

  Ok((merged, stack))
}

/// Try to find the best injection match at the current position.
/// Returns (match, matched_rule_id, priority) — extracting the single matched rule_id
/// instead of cloning the entire rule_ids Vec.
fn find_injection_match(
  compiled: &mut CompiledGrammar,
  active_injections: &[(RuleId, InjectionPriority)],
  input: &OnigString,
  line_str_id: u64,
  cursor: usize,
  find_options: ScannerFindOptions,
) -> Option<(ferroni::scanner::ScannerMatch, RuleId, InjectionPriority)> {
  let mut best_result: Option<(ferroni::scanner::ScannerMatch, RuleId, usize, InjectionPriority)> = None;

  for (rule_id, priority) in active_injections {
    // Build and cache injection scanner
    if !compiled.injection_scanner_cache.contains_key(rule_id) {
      let mut pattern_pairs: Vec<(String, RuleId)> = Vec::new();
      collect_patterns(*rule_id, &compiled.registry, &mut pattern_pairs);
      if pattern_pairs.is_empty() { continue; }

      let regexes: Vec<String> = pattern_pairs.iter().map(|(re, _)| re.clone()).collect();
      let ids: Vec<RuleId> = pattern_pairs.iter().map(|(_, id)| *id).collect();
      let regex_refs: Vec<&str> = regexes.iter().map(String::as_str).collect();
      let Ok(scanner) = Scanner::new(&regex_refs) else { continue };
      let single_scanners = std::iter::repeat_with(|| None)
        .take(regexes.len())
        .collect();
      compiled.injection_scanner_cache.insert(*rule_id, CompiledScanner {
        scanner,
        rule_ids: ids,
        regexes,
        single_scanners,
      });
    }

    let Some(cached) = compiled.injection_scanner_cache.get_mut(rule_id) else { continue };
    let Some(found) = find_next_match_ordered(cached, input, line_str_id, cursor, find_options) else {
      continue;
    };

    let start = found.capture_indices.first().map(|c| c.start).unwrap_or(usize::MAX);
    let matched_id = cached.rule_ids.get(found.index).copied().unwrap_or(0);

    let dominated = if let Some((_, _, best_start, best_prio)) = &best_result {
      if start < *best_start {
        false
      } else if start == *best_start {
        *best_prio == InjectionPriority::Left && *priority != InjectionPriority::Left
      } else {
        true
      }
    } else {
      false
    };

    if !dominated {
      best_result = Some((found, matched_id, start, *priority));
      if start == cursor && *priority == InjectionPriority::Left {
        break;
      }
    }
  }

  best_result.map(|(found, matched_id, _, prio)| (found, matched_id, prio))
}

// ─────────────────────────────────────────────────────────────────────────────
// UTF-16 mapping and utility functions (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

fn utf16_to_byte_map(input: &str) -> Vec<usize> {
  let mut map = Vec::with_capacity(input.encode_utf16().count() + 1);
  for (byte_idx, ch) in input.char_indices() {
    map.push(byte_idx);
    if ch.len_utf16() == 2 {
      map.push(byte_idx);
    }
  }
  map.push(input.len());
  map
}

fn supports_plaintext(lang: &str) -> bool {
  matches!(lang, "text" | "txt" | "plain" | "plaintext")
}

fn supports_json(lang: &str) -> bool {
  lang == "json"
}

fn lang_mode_from_scope(scope_name: &str) -> Option<LangMode> {
  if scope_name == "source.json" || scope_name.ends_with(".json") {
    return Some(LangMode::Json);
  }
  if scope_name == "text.plain" {
    return Some(LangMode::Plaintext);
  }
  None
}

fn resolve_lang_mode_from_lang(lang: &str) -> Option<LangMode> {
  if supports_plaintext(lang) {
    return Some(LangMode::Plaintext);
  }
  if supports_json(lang) {
    return Some(LangMode::Json);
  }
  None
}

fn resolve_lang_from_options(options_json: &str) -> Result<String> {
  let Some(lang) = parse_lang(options_json) else {
    return Err(Error::from_reason(
      "Ferriki vertical slice requires options.lang.",
    ));
  };
  Ok(lang)
}

fn escape_html(input: &str) -> String {
  let mut escaped = String::with_capacity(input.len());
  for ch in input.chars() {
    match ch {
      '&' => escaped.push_str("&#x26;"),
      '<' => escaped.push_str("&#x3C;"),
      _ => escaped.push(ch),
    }
  }
  escaped
}

fn render_plain_html(code: &str, options_json: &str, themes: &HashMap<String, ThemeData>) -> String {
  let theme = resolve_html_theme_profile(options_json, "ferriki-plain", themes);
  render_unstyled_html(code, &theme)
}

fn render_plain_tokens_json(code: &str, options_json: &str, themes: &HashMap<String, ThemeData>) -> Result<String> {
  let theme = resolve_theme_profile(options_json, "ferriki-plain", themes);
  let utf16_len = code.encode_utf16().count();
  let styled = vec![StyledJsonToken {
    content: code.to_owned(),
    content_utf16_len: utf16_len,
    offset_utf16: 0,
    color: Arc::<str>::from(COLOR_DEFAULT_FG),
    font_style: 0,
    dark_color: None,
  }];
  let styled_lines = styled_json_lines(&styled);
  let line_start_offsets = line_start_offsets_utf16(code);

  let mut out = String::with_capacity(styled_lines.len() * 64);
  out.push_str("{\"tokens\":[");
  for (line_index, line) in styled_lines.into_iter().enumerate() {
    if line_index > 0 { out.push(','); }
    let line_offset = line_start_offsets
      .get(line_index)
      .copied()
      .unwrap_or_else(|| line_start_offsets.last().copied().unwrap_or(0));

    if line.is_empty() {
      out.push_str("[{\"content\":\"\",\"offset\":");
      push_usize(&mut out, line_offset);
      out.push_str("}]");
      continue;
    }

    let mut content = String::new();
    let mut offset = line_offset;
    for (index, token) in line.iter().enumerate() {
      if index == 0 {
        offset = token.offset_utf16;
      }
      content.push_str(&token.content);
    }

    out.push_str("[{\"content\":\"");
    push_json_escaped(&mut out, &content);
    out.push_str("\",\"offset\":");
    push_usize(&mut out, offset);
    out.push_str("}]");
  }
  out.push_str("],\"themeName\":\"");
  push_json_escaped(&mut out, &theme.theme_name);
  out.push_str("\",\"fg\":\"");
  out.push_str(&theme.fg.unwrap_or_default());
  out.push_str("\",\"bg\":\"");
  out.push_str(&theme.bg.unwrap_or_default());
  out.push_str("\"}");
  Ok(out)
}

fn render_plain_hast_json(code: &str, options_json: &str, themes: &HashMap<String, ThemeData>) -> Result<String> {
  let theme = resolve_html_theme_profile(options_json, "ferriki-plain", themes);
  let utf16_len = code.encode_utf16().count();
  let styled = vec![StyledJsonToken {
    content: code.to_owned(),
    content_utf16_len: utf16_len,
    offset_utf16: 0,
    color: Arc::<str>::from(COLOR_DEFAULT_FG),
    font_style: 0,
    dark_color: None,
  }];
  let lines = styled_json_lines(&styled);
  render_styled_hast_payload_json(&lines, options_json, &theme, None)
}

fn line_start_offsets_utf16(input: &str) -> Vec<usize> {
  let mut starts = vec![0usize];
  let mut offset = 0usize;

  for ch in input.chars() {
    offset = offset.saturating_add(ch.len_utf16());
    if ch == '\n' {
      starts.push(offset);
    }
  }

  starts
}

fn push_slice(
  out: &mut Vec<JsonToken>,
  kind: &'static str,
  start_utf16: usize,
  end_utf16: usize,
  utf16_map: &[usize],
  code: &str,
) -> Result<()> {
  if end_utf16 < start_utf16 || end_utf16 >= utf16_map.len() {
    return Err(Error::from_reason("Ferriki JSON tokenizer produced invalid range."));
  }

  let start_byte = utf16_map[start_utf16];
  let end_byte = utf16_map[end_utf16];
  let content = code
    .get(start_byte..end_byte)
    .ok_or_else(|| Error::from_reason("Ferriki JSON tokenizer failed to slice source text."))?
    .to_owned();

  out.push(JsonToken {
    kind,
    start_utf16,
    end_utf16,
    content,
  });
  Ok(())
}

fn tokenize_json_with_ferroni(code: &str) -> Result<Vec<JsonToken>> {
  let patterns = [
    r#""(?:\\.|[^"\\])*""#,
    r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?",
    r"\b(?:true|false|null)\b",
    r"[{}\[\]:,]",
  ];
  let pattern_refs = patterns.to_vec();
  let mut scanner = Scanner::new(&pattern_refs)
    .map_err(|err| Error::from_reason(format!("Failed to initialize Ferroni JSON scanner: {err}")))?;
  let input = OnigString::new(code);
  let utf16_map = utf16_to_byte_map(code);
  let total_utf16 = utf16_map.len().saturating_sub(1);
  let find_options = ScannerFindOptions::from_bits(0);

  let mut cursor = 0usize;
  let mut out = Vec::new();

  while cursor < total_utf16 {
    let Some(found) = scanner.find_next_match_utf16(&input, cursor, find_options) else {
      push_slice(&mut out, "text", cursor, total_utf16, &utf16_map, code)?;
      break;
    };

    let first = found
      .capture_indices
      .first()
      .ok_or_else(|| Error::from_reason("Ferriki JSON scanner returned match without capture 0."))?;
    let start_utf16 = first.start;
    let end_utf16 = first.end;

    if start_utf16 > cursor {
      push_slice(&mut out, "text", cursor, start_utf16, &utf16_map, code)?;
    }

    if end_utf16 <= start_utf16 {
      cursor = start_utf16.saturating_add(1);
      continue;
    }

    let kind = match found.index {
      0 => "string",
      1 => "number",
      2 => "literal",
      3 => "punct",
      _ => "text",
    };

    push_slice(&mut out, kind, start_utf16, end_utf16, &utf16_map, code)?;
    cursor = end_utf16;
  }

  Ok(out)
}

fn merge_adjacent_json_punct_tokens(tokens: Vec<JsonToken>) -> Vec<JsonToken> {
  let mut merged: Vec<JsonToken> = Vec::with_capacity(tokens.len());

  for token in tokens {
    if token.kind == "punct" {
      if let Some(last) = merged.last_mut() {
        if last.kind == "punct" && last.end_utf16 == token.start_utf16 {
          last.end_utf16 = token.end_utf16;
          last.content.push_str(&token.content);
          continue;
        }
      }
    }

    merged.push(token);
  }

  merged
}

fn theme_profile_by_name(theme_name: &str, themes: &HashMap<String, ThemeData>) -> JsonThemeProfile {
  if theme_name == "none" {
    return JsonThemeProfile {
      pre_class: "shiki none".to_owned(),
      pre_style: Some("background-color:;color:".to_owned()),
      theme_name: "none".to_owned(),
      fg: None,
      bg: None,
    };
  }

  if let Some(theme_data) = themes.get(theme_name) {
    let fg = if theme_data.fg.is_empty() { None } else { Some(theme_data.fg.clone()) };
    let bg = if theme_data.bg.is_empty() { None } else { Some(theme_data.bg.clone()) };
    let pre_style = match (&fg, &bg) {
      (Some(f), Some(b)) => Some(format!("background-color:{b};color:{f}")),
      _ => None,
    };
    return JsonThemeProfile {
      pre_class: format!("shiki {theme_name}"),
      pre_style,
      theme_name: theme_name.to_owned(),
      fg,
      bg,
    };
  }

  JsonThemeProfile {
    pre_class: format!("shiki {theme_name}"),
    pre_style: None,
    theme_name: theme_name.to_owned(),
    fg: None,
    bg: None,
  }
}

fn resolve_theme_profile(options_json: &str, fallback_theme: &str, themes: &HashMap<String, ThemeData>) -> JsonThemeProfile {
  if let Some((light, _dark)) = parse_dual_themes(options_json) {
    return theme_profile_by_name(&light, themes);
  }
  let theme_name = parse_theme(options_json).unwrap_or_else(|| fallback_theme.to_owned());
  theme_profile_by_name(&theme_name, themes)
}

fn resolve_html_theme_profile(options_json: &str, fallback_theme: &str, themes: &HashMap<String, ThemeData>) -> HtmlThemeProfile {
  if let Some((light, dark)) = parse_dual_themes(options_json) {
    let light_profile = theme_profile_by_name(&light, themes);
    let dark_profile = theme_profile_by_name(&dark, themes);
    let light_bg = light_profile.bg.clone().unwrap_or_default();
    let light_fg = light_profile.fg.clone().unwrap_or_default();
    let dark_bg = if dark == "none" {
      COLOR_INHERIT.to_owned()
    }
    else {
      dark_profile.bg.clone().unwrap_or_default()
    };
    let dark_fg = if dark == "none" {
      COLOR_INHERIT.to_owned()
    }
    else {
      dark_profile.fg.clone().unwrap_or_default()
    };

    return HtmlThemeProfile {
      pre_class: format!("shiki shiki-themes {light} {dark}"),
      pre_style: Some(format!(
        "background-color:{light_bg};--shiki-dark-bg:{dark_bg};color:{light_fg};--shiki-dark:{dark_fg}"
      )),
      theme_name: light_profile.theme_name,
      dark_theme_name: Some(dark_profile.theme_name),
      disable_token_coloring: light == "none",
    };
  }

  let profile = resolve_theme_profile(options_json, fallback_theme, themes);
  let disable_token_coloring = profile.theme_name == "none";
  HtmlThemeProfile {
    pre_class: profile.pre_class,
    pre_style: profile.pre_style,
    theme_name: profile.theme_name,
    dark_theme_name: None,
    disable_token_coloring,
  }
}

fn resolve_json_theme(options_json: &str, themes: &HashMap<String, ThemeData>) -> JsonThemeProfile {
  resolve_theme_profile(options_json, "ferriki-json", themes)
}

fn is_json_key_string(tokens: &[JsonToken], index: usize) -> bool {
  for token in tokens.iter().skip(index.saturating_add(1)) {
    if token.kind == "text" && token.content.chars().all(char::is_whitespace) {
      continue;
    }
    return token.kind == "punct" && token.content == ":";
  }
  false
}

fn push_styled_token(
  out: &mut Vec<StyledJsonToken>,
  content: String,
  offset_utf16: usize,
  color: &Arc<str>,
) {
  if content.is_empty() {
    return;
  }
  let content_utf16_len = content.encode_utf16().count();
  out.push(StyledJsonToken {
    content,
    content_utf16_len,
    offset_utf16,
    color: color.clone(),
    font_style: 0,
    dark_color: None,
  });
}

fn push_styled_string_token(
  out: &mut Vec<StyledJsonToken>,
  token: &JsonToken,
  _is_key: bool,
  quote_color: &Arc<str>,
  body_color: &Arc<str>,
) {
  if quote_color == body_color {
    push_styled_token(out, token.content.clone(), token.start_utf16, body_color);
    return;
  }

  if token.content.len() >= 2 && token.content.starts_with('"') && token.content.ends_with('"') {
    let char_count = token.content.chars().count();
    if char_count >= 2 {
      let body = token
        .content
        .chars()
        .skip(1)
        .take(char_count.saturating_sub(2))
        .collect::<String>();
      push_styled_token(out, "\"".to_owned(), token.start_utf16, quote_color);
      push_styled_token(out, body, token.start_utf16.saturating_add(1), body_color);
      push_styled_token(out, "\"".to_owned(), token.end_utf16.saturating_sub(1), quote_color);
      return;
    }
  }

  push_styled_token(out, token.content.clone(), token.start_utf16, body_color);
}

/// Write a JSON-escaped string (handles \n, \r, \t, \\, \", and control chars)
fn push_json_escaped(out: &mut String, s: &str) {
  for ch in s.chars() {
    match ch {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\n' => out.push_str("\\n"),
      '\r' => out.push_str("\\r"),
      '\t' => out.push_str("\\t"),
      c if c < '\x20' => {
        out.push_str(&format!("\\u{:04x}", c as u32));
      }
      c => out.push(c),
    }
  }
}

/// Write a usize as decimal digits without allocation
fn push_usize(out: &mut String, n: usize) {
  if n == 0 {
    out.push('0');
    return;
  }
  let start = out.len();
  let mut val = n;
  while val > 0 {
    out.push((b'0' + (val % 10) as u8) as char);
    val /= 10;
  }
  // Reverse the digits we just pushed
  unsafe {
    let bytes = out.as_bytes_mut();
    bytes[start..].reverse();
  }
}

fn normalize_hex_color(color: &str) -> String {
  if color.starts_with('#') {
    format!("#{}", color[1..].to_uppercase())
  } else {
    color.to_owned()
  }
}

fn resolve_json_scope_color(scope_names: &[&str], theme: &ThemeData) -> Arc<str> {
  let style = resolve_token_style(scope_names, theme);
  style.foreground.unwrap_or_else(|| theme.fg_normalized.clone())
}

fn resolve_json_scope_color_with_fallback(scope_names: &[&str], fallback_color: &Arc<str>, theme: &ThemeData) -> Arc<str> {
  let mut has_specific_match = false;
  for rule in &theme.settings {
    if rule.scopes.is_empty() {
      continue;
    }
    for parts in &rule.scope_parts {
      if selector_matches_presplit(parts, scope_names).is_some() {
        has_specific_match = true;
        break;
      }
    }
    if has_specific_match { break; }
  }

  if has_specific_match {
    resolve_json_scope_color(scope_names, theme)
  } else {
    fallback_color.clone()
  }
}

fn style_json_tokens(tokens: &[JsonToken], theme: &ThemeData) -> Vec<StyledJsonToken> {
  let mut styled = Vec::new();
  let root = "source.json";
  let default_fg = theme.fg_normalized.clone();

  // Pre-resolve all JSON scope colors once (avoids repeated theme lookups per token)
  let key_body_color = resolve_json_scope_color(&[root, "string.json", "support.type.property-name.json"], theme);
  let key_quote_color = resolve_json_scope_color_with_fallback(
    &[root, "string.json", "support.type.property-name.json", "punctuation.support.type.property-name.json"],
    &key_body_color,
    theme,
  );
  let key_has_separate_quotes = key_quote_color != key_body_color;

  let str_body_color = resolve_json_scope_color(&[root, "string.quoted.double.json"], theme);
  let str_quote_color = resolve_json_scope_color_with_fallback(
    &[root, "string.quoted.double.json", "punctuation.definition.string.json"],
    &str_body_color,
    theme,
  );
  let str_has_separate_quotes = str_quote_color != str_body_color;

  let number_color = resolve_json_scope_color(&[root, "constant.numeric.json"], theme);
  let literal_color = resolve_json_scope_color(&[root, "constant.language.json"], theme);
  let punct_sep_color = resolve_json_scope_color(&[root, "punctuation.separator.json"], theme);
  let punct_def_color = resolve_json_scope_color(&[root, "punctuation.definition.json"], theme);

  for (index, token) in tokens.iter().enumerate() {
    match token.kind {
      "text" => push_styled_token(
        &mut styled,
        token.content.clone(),
        token.start_utf16,
        &default_fg,
      ),
      "string" => {
        let is_key = is_json_key_string(tokens, index);
        if is_key {
          if key_has_separate_quotes {
            push_styled_string_token(&mut styled, token, true, &key_quote_color, &key_body_color);
          } else {
            push_styled_token(&mut styled, token.content.clone(), token.start_utf16, &key_body_color);
          }
        } else {
          if str_has_separate_quotes {
            push_styled_string_token(&mut styled, token, false, &str_quote_color, &str_body_color);
          } else {
            push_styled_token(&mut styled, token.content.clone(), token.start_utf16, &str_body_color);
          }
        }
      }
      "number" => {
        push_styled_token(&mut styled, token.content.clone(), token.start_utf16, &number_color);
      }
      "literal" => {
        push_styled_token(&mut styled, token.content.clone(), token.start_utf16, &literal_color);
      }
      "punct" => {
        let is_sep = token.content == ":" || token.content == ",";
        let color = if is_sep { &punct_sep_color } else { &punct_def_color };
        push_styled_token(&mut styled, token.content.clone(), token.start_utf16, color);
      }
      _ => push_styled_token(
        &mut styled,
        token.content.clone(),
        token.start_utf16,
        &default_fg,
      ),
    }
  }

  styled
}

fn styled_json_lines(styled: &[StyledJsonToken]) -> Vec<Vec<StyledJsonToken>> {
  let mut lines: Vec<Vec<StyledJsonToken>> = vec![Vec::new()];

  for token in styled {
    let mut piece = String::new();
    let mut offset_utf16 = token.offset_utf16;
    let mut piece_start_utf16 = token.offset_utf16;

    for ch in token.content.chars() {
      if ch == '\r' {
        offset_utf16 = offset_utf16.saturating_add(1);
        continue;
      }

      if ch == '\n' {
        if !piece.is_empty() {
          lines.last_mut().expect("line exists").push(StyledJsonToken {
            content: piece.clone(),
            content_utf16_len: offset_utf16 - piece_start_utf16,
            offset_utf16: piece_start_utf16,
            color: token.color.clone(),
            font_style: token.font_style,
            dark_color: token.dark_color.clone(),
          });
        }
        piece.clear();
        lines.push(Vec::new());
        offset_utf16 = offset_utf16.saturating_add(1);
        piece_start_utf16 = offset_utf16;
        continue;
      }

      if piece.is_empty() {
        piece_start_utf16 = offset_utf16;
      }

      piece.push(ch);
      offset_utf16 = offset_utf16.saturating_add(ch.len_utf16());
    }

    if !piece.is_empty() {
      lines.last_mut().expect("line exists").push(StyledJsonToken {
        content: piece,
        content_utf16_len: offset_utf16 - piece_start_utf16,
        offset_utf16: piece_start_utf16,
        color: token.color.clone(),
        font_style: token.font_style,
        dark_color: token.dark_color.clone(),
      });
    }
  }

  lines
}

fn merge_line_for_html(line: &[StyledJsonToken], _default_fg: &str) -> Vec<StyledJsonToken> {
  let mut merged = Vec::new();
  let mut index = 0usize;

  while index < line.len() {
    let token = &line[index];

    let is_plain_ws = !token.content.is_empty()
      && token.content.chars().all(|ch| ch.is_whitespace());

    if is_plain_ws {
      if let Some(next) = line.get(index.saturating_add(1)) {
        if next.color != token.color {
          let mut combined = next.clone();
          combined.offset_utf16 = token.offset_utf16;
          combined.content = format!("{}{}", token.content, next.content);
          merged.push(combined);
          index = index.saturating_add(2);
          continue;
        }
      }
    }

    merged.push(token.clone());
    index = index.saturating_add(1);
  }

  merged
}

fn apply_dark_theme_inherit(mut styled: Vec<StyledJsonToken>) -> Vec<StyledJsonToken> {
  for token in &mut styled {
    token.dark_color = Some(Arc::<str>::from(COLOR_INHERIT));
  }
  styled
}

fn apply_dark_theme_palette(
  mut light_styled: Vec<StyledJsonToken>,
  dark_styled: &[StyledJsonToken],
) -> Vec<StyledJsonToken> {
  for (index, light) in light_styled.iter_mut().enumerate() {
    let Some(dark) = dark_styled.get(index) else {
      break;
    };
    if dark.offset_utf16 == light.offset_utf16 && dark.content == light.content {
      light.dark_color = Some(dark.color.clone());
    }
  }
  light_styled
}

fn render_unstyled_html(code: &str, theme: &HtmlThemeProfile) -> String {
  let utf16_len = code.encode_utf16().count();
  let styled = vec![StyledJsonToken {
    content: code.to_owned(),
    content_utf16_len: utf16_len,
    offset_utf16: 0,
    color: Arc::<str>::from(COLOR_DEFAULT_FG),
    font_style: 0,
    dark_color: None,
  }];
  let lines = styled_json_lines(&styled);
  render_styled_html_lines(&lines, theme, true)
}

fn render_styled_html_lines(
  lines: &[Vec<StyledJsonToken>],
  theme: &HtmlThemeProfile,
  unstyled_spans: bool,
) -> String {
  let mut html = String::new();
  html.push_str("<pre class=\"");
  html.push_str(&theme.pre_class);
  html.push('"');
  if let Some(style) = &theme.pre_style {
    html.push_str(" style=\"");
    html.push_str(style);
    html.push('"');
  }
  html.push_str(" tabindex=\"0\"><code>");

  for (line_index, line) in lines.iter().enumerate() {
    html.push_str("<span class=\"line\">");
    if line.is_empty() {
      if unstyled_spans {
        html.push_str("<span></span>");
      }
    }
    else {
      for token in line {
        if unstyled_spans {
          html.push_str("<span>");
        }
        else {
          html.push_str("<span style=\"color:");
          html.push_str(&token.color);
          if let Some(dark_color) = &token.dark_color {
            html.push_str(";--shiki-dark:");
            html.push_str(dark_color);
          }
          if token.font_style & 1 != 0 {
            html.push_str(";font-style:italic");
          }
          if token.font_style & 2 != 0 {
            html.push_str(";font-weight:bold");
          }
          if token.font_style & 4 != 0 || token.font_style & 8 != 0 {
            html.push_str(";text-decoration:");
            if token.font_style & 4 != 0 {
              html.push_str("underline");
            }
            if token.font_style & 8 != 0 {
              if token.font_style & 4 != 0 {
                html.push(' ');
              }
              html.push_str("line-through");
            }
          }
          html.push_str("\">");
        }
        html.push_str(&escape_html(&token.content));
        html.push_str("</span>");
      }
    }
    html.push_str("</span>");
    if line_index + 1 < lines.len() {
      html.push('\n');
    }
  }

  html.push_str("</code></pre>");
  html
}

fn styled_token_style_string(token: &StyledJsonToken) -> Option<String> {
  let mut style = String::new();

  if !token.color.is_empty() {
    style.push_str("color:");
    style.push_str(&token.color);
  }
  if let Some(dark_color) = &token.dark_color {
    if !style.is_empty() {
      style.push(';');
    }
    style.push_str("--shiki-dark:");
    style.push_str(dark_color);
  }
  if token.font_style & 1 != 0 {
    if !style.is_empty() {
      style.push(';');
    }
    style.push_str("font-style:italic");
  }
  if token.font_style & 2 != 0 {
    if !style.is_empty() {
      style.push(';');
    }
    style.push_str("font-weight:bold");
  }
  if token.font_style & 4 != 0 || token.font_style & 8 != 0 {
    if !style.is_empty() {
      style.push(';');
    }
    style.push_str("text-decoration:");
    if token.font_style & 4 != 0 {
      style.push_str("underline");
    }
    if token.font_style & 8 != 0 {
      if token.font_style & 4 != 0 {
        style.push(' ');
      }
      style.push_str("line-through");
    }
  }

  if style.is_empty() {
    None
  } else {
    Some(style)
  }
}

fn hast_text_node(value: &str) -> Value {
  json!({
    "type": "text",
    "value": value,
  })
}

fn hast_element_node(
  tag_name: &str,
  properties: serde_json::Map<String, Value>,
  children: Vec<Value>,
  data: Option<Value>,
) -> Value {
  let mut node = serde_json::Map::new();
  node.insert("type".to_owned(), Value::String("element".to_owned()));
  node.insert("tagName".to_owned(), Value::String(tag_name.to_owned()));
  node.insert("properties".to_owned(), Value::Object(properties));
  node.insert("children".to_owned(), Value::Array(children));
  if let Some(data_value) = data {
    node.insert("data".to_owned(), data_value);
  }
  Value::Object(node)
}

fn parse_hast_structure(options: &Value) -> &'static str {
  match options.get("structure").and_then(Value::as_str) {
    Some("inline") => "inline",
    _ => "classic",
  }
}

fn parse_hast_tabindex(options: &Value) -> Option<String> {
  match options.get("tabindex") {
    Some(Value::Bool(false)) | Some(Value::Null) => None,
    Some(Value::String(value)) => Some(value.clone()),
    Some(Value::Number(value)) => Some(value.to_string()),
    Some(Value::Bool(value)) => Some(value.to_string()),
    _ => Some("0".to_owned()),
  }
}

fn resolve_hast_root_style(options: &Value, theme: &HtmlThemeProfile) -> Option<String> {
  match options.get("rootStyle") {
    Some(Value::Bool(false)) => None,
    Some(Value::String(value)) => Some(value.clone()),
    Some(Value::Null) => theme.pre_style.clone(),
    _ => theme.pre_style.clone(),
  }
}

fn render_styled_hast_payload_json(
  lines: &[Vec<StyledJsonToken>],
  options_json: &str,
  theme: &HtmlThemeProfile,
  rust_state: Option<Value>,
) -> Result<String> {
  let options: Value = serde_json::from_str(options_json)
    .map_err(|err| Error::from_reason(format!("Failed to parse codeToHast options JSON: {err}")))?;
  let structure = parse_hast_structure(&options);
  let tabindex = parse_hast_tabindex(&options);
  let root_style = resolve_hast_root_style(&options, theme);

  let mut pre_properties = serde_json::Map::new();
  pre_properties.insert("class".to_owned(), Value::String(theme.pre_class.clone()));
  if let Some(style) = root_style {
    pre_properties.insert("style".to_owned(), Value::String(style));
  }
  if let Some(tabindex) = tabindex {
    pre_properties.insert("tabindex".to_owned(), Value::String(tabindex));
  }
  if let Some(meta) = options.get("meta").and_then(Value::as_object) {
    for (key, value) in meta {
      if !key.starts_with('_') {
        pre_properties.insert(key.clone(), value.clone());
      }
    }
  }

  let mut root_children = Vec::new();
  let mut code_children = Vec::new();

  for (line_index, line) in lines.iter().enumerate() {
    if line_index > 0 {
      if structure == "inline" {
        root_children.push(hast_element_node("br", serde_json::Map::new(), Vec::new(), None));
      } else {
        code_children.push(hast_text_node("\n"));
      }
    }

    let mut line_children = Vec::new();
    for token in line {
      let mut token_properties = serde_json::Map::new();
      if let Some(style) = styled_token_style_string(token) {
        token_properties.insert("style".to_owned(), Value::String(style));
      }
      let token_node = hast_element_node(
        "span",
        token_properties,
        vec![hast_text_node(&token.content)],
        None,
      );
      if structure == "inline" {
        root_children.push(token_node);
      } else {
        line_children.push(token_node);
      }
    }

    if structure == "classic" {
      let mut line_properties = serde_json::Map::new();
      line_properties.insert("class".to_owned(), Value::String("line".to_owned()));
      code_children.push(hast_element_node("span", line_properties, line_children, None));
    }
  }

  if structure == "classic" {
    let code_node = hast_element_node("code", serde_json::Map::new(), code_children, None);
    let pre_node = hast_element_node(
      "pre",
      pre_properties,
      vec![code_node],
      options.get("data").cloned(),
    );
    root_children.push(pre_node);
  }

  let mut root_node = serde_json::Map::new();
  root_node.insert("type".to_owned(), Value::String("root".to_owned()));
  root_node.insert("children".to_owned(), Value::Array(root_children));

  let mut payload = serde_json::Map::new();
  payload.insert("hast".to_owned(), Value::Object(root_node));
  if let Some(rust_state) = rust_state {
    payload.insert("_rustState".to_owned(), rust_state);
  }

  serde_json::to_string(&Value::Object(payload))
    .map_err(|err| Error::from_reason(format!("Failed to serialize codeToHast payload: {err}")))
}

fn render_styled_tokens_json(lines: Vec<Vec<StyledJsonToken>>, theme: JsonThemeProfile) -> Result<String> {
  // Manual JSON construction — avoids serde_json::Value heap allocations
  let mut out = String::with_capacity(lines.len() * 128);
  out.push_str("{\"tokens\":[");
  for (li, line) in lines.iter().enumerate() {
    if li > 0 { out.push(','); }
    out.push('[');
    for (ti, token) in line.iter().enumerate() {
      if ti > 0 { out.push(','); }
      out.push_str("{\"content\":\"");
      push_json_escaped(&mut out, &token.content);
      out.push_str("\",\"offset\":");
      push_usize(&mut out, token.offset_utf16);
      out.push_str(",\"color\":\"");
      out.push_str(&token.color); // pre-normalized hex, no escaping needed
      out.push_str("\",\"fontStyle\":");
      push_usize(&mut out, token.font_style as usize);
      out.push('}');
    }
    out.push(']');
  }
  out.push_str("],\"themeName\":\"");
  push_json_escaped(&mut out, &theme.theme_name);
  out.push('"');
  if let Some(fg) = &theme.fg {
    out.push_str(",\"fg\":\"");
    out.push_str(fg);
    out.push('"');
  }
  if let Some(bg) = &theme.bg {
    out.push_str(",\"bg\":\"");
    out.push_str(bg);
    out.push('"');
  }
  out.push('}');
  Ok(out)
}

fn render_styled_tokens_json_with_state(
  lines: Vec<Vec<StyledJsonToken>>,
  theme: JsonThemeProfile,
  final_stack: &[StateFrame],
  root_scope: Option<&str>,
) -> Result<String> {
  let mut out = String::with_capacity(lines.len() * 128);
  out.push_str("{\"tokens\":[");
  for (li, line) in lines.iter().enumerate() {
    if li > 0 { out.push(','); }
    out.push('[');
    for (ti, token) in line.iter().enumerate() {
      if ti > 0 { out.push(','); }
      out.push_str("{\"content\":\"");
      push_json_escaped(&mut out, &token.content);
      out.push_str("\",\"offset\":");
      push_usize(&mut out, token.offset_utf16);
      out.push_str(",\"color\":\"");
      out.push_str(&token.color);
      out.push_str("\",\"fontStyle\":");
      push_usize(&mut out, token.font_style as usize);
      out.push('}');
    }
    out.push(']');
  }
  out.push_str("],\"themeName\":\"");
  push_json_escaped(&mut out, &theme.theme_name);
  out.push('"');
  if let Some(fg) = &theme.fg {
    out.push_str(",\"fg\":\"");
    out.push_str(fg);
    out.push('"');
  }
  if let Some(bg) = &theme.bg {
    out.push_str(",\"bg\":\"");
    out.push_str(bg);
    out.push('"');
  }
  // Serialize state via serde (complex nested structure)
  let state_value = serialize_state_frames(final_stack, root_scope);
  out.push_str(",\"_rustState\":");
  let state_json = serde_json::to_string(&state_value)
    .map_err(|err| Error::from_reason(format!("Failed to serialize state: {err}")))?;
  out.push_str(&state_json);
  out.push('}');
  Ok(out)
}

fn default_theme_data(theme_name: &str) -> ThemeData {
  let fg = COLOR_DEFAULT_FG.to_owned();
  ThemeData {
    name: theme_name.to_owned(),
    fg_normalized: Arc::<str>::from(COLOR_DEFAULT_FG),
    fg,
    bg: COLOR_DEFAULT_BG.to_owned(),
    settings: Vec::new(),
  }
}

fn resolve_theme_data<'a>(theme_name: &str, themes: &'a HashMap<String, ThemeData>) -> Option<&'a ThemeData> {
  themes.get(theme_name)
}

fn render_json_html(code: &str, options_json: &str, themes: &HashMap<String, ThemeData>) -> Result<String> {
  let html_theme = resolve_html_theme_profile(options_json, "ferriki-json", themes);
  if html_theme.disable_token_coloring {
    return Ok(render_unstyled_html(code, &html_theme));
  }

  let fallback_light = default_theme_data(&html_theme.theme_name);
  let light_theme = resolve_theme_data(&html_theme.theme_name, themes).unwrap_or(&fallback_light);
  let tokens = merge_adjacent_json_punct_tokens(tokenize_json_with_ferroni(code)?);
  let mut styled = style_json_tokens(&tokens, light_theme);
  if let Some(dark_theme_name) = html_theme.dark_theme_name.as_deref() {
    if dark_theme_name == "none" {
      styled = apply_dark_theme_inherit(styled);
    }
    else {
      let fallback_dark = default_theme_data(dark_theme_name);
      let dark_theme = resolve_theme_data(dark_theme_name, themes).unwrap_or(&fallback_dark);
      let dark_styled = style_json_tokens(&tokens, dark_theme);
      styled = apply_dark_theme_palette(styled, &dark_styled);
    }
  }
  let default_fg = light_theme.fg.clone();
  let lines = styled_json_lines(&styled)
    .into_iter()
    .map(|line| merge_line_for_html(&line, &default_fg))
    .collect::<Vec<_>>();
  Ok(render_styled_html_lines(&lines, &html_theme, false))
}

fn render_json_tokens_json(code: &str, options_json: &str, themes: &HashMap<String, ThemeData>) -> Result<String> {
  let tokens = merge_adjacent_json_punct_tokens(tokenize_json_with_ferroni(code)?);
  let theme = resolve_json_theme(options_json, themes);
  let fallback = default_theme_data(&theme.theme_name);
  let theme_data = resolve_theme_data(&theme.theme_name, themes).unwrap_or(&fallback);
  let styled = style_json_tokens(&tokens, theme_data);
  let lines = styled_json_lines(&styled);
  render_styled_tokens_json(lines, theme)
}

fn render_json_hast_json(code: &str, options_json: &str, themes: &HashMap<String, ThemeData>) -> Result<String> {
  let html_theme = resolve_html_theme_profile(options_json, "ferriki-json", themes);
  let fallback_light = default_theme_data(&html_theme.theme_name);
  let light_theme = resolve_theme_data(&html_theme.theme_name, themes).unwrap_or(&fallback_light);
  let tokens = merge_adjacent_json_punct_tokens(tokenize_json_with_ferroni(code)?);
  let mut styled = style_json_tokens(&tokens, light_theme);
  if let Some(dark_theme_name) = html_theme.dark_theme_name.as_deref() {
    if dark_theme_name == "none" {
      styled = apply_dark_theme_inherit(styled);
    }
    else {
      let fallback_dark = default_theme_data(dark_theme_name);
      let dark_theme = resolve_theme_data(dark_theme_name, themes).unwrap_or(&fallback_dark);
      let dark_styled = style_json_tokens(&tokens, dark_theme);
      styled = apply_dark_theme_palette(styled, &dark_styled);
    }
  }
  let lines = styled_json_lines(&styled);
  render_styled_hast_payload_json(&lines, options_json, &html_theme, None)
}

fn resolve_initial_stack(
  options_json: &str,
  code: &str,
  compiled: &mut CompiledGrammar,
  root_scope: Option<&str>,
  theme: &ThemeData,
) -> Result<Option<Vec<StateFrame>>> {
  // Priority: _rustState > grammarContextCode > default (None)
  if let Some(stack) = parse_initial_state_from_options(options_json) {
    return Ok(Some(stack));
  }
  if let Some(context_code) = parse_grammar_context_code(options_json) {
    if !context_code.is_empty() {
      let (_, final_stack) = tokenize_with_grammar_skeleton(&context_code, compiled, root_scope, theme, None)?;
      return Ok(Some(final_stack));
    }
  }
  let _ = code; // suppress unused warning
  Ok(None)
}

fn render_grammar_html(
  code: &str,
  options_json: &str,
  compiled: &mut CompiledGrammar,
  root_scope: Option<&str>,
  themes: &HashMap<String, ThemeData>,
) -> Result<String> {
  let html_theme = resolve_html_theme_profile(options_json, "ferriki-grammar", themes);
  if html_theme.disable_token_coloring {
    return Ok(render_unstyled_html(code, &html_theme));
  }

  let fallback_light = default_theme_data(&html_theme.theme_name);
  let light_theme = resolve_theme_data(&html_theme.theme_name, themes).unwrap_or(&fallback_light);
  let initial_stack = resolve_initial_stack(options_json, code, compiled, root_scope, light_theme)?;
  let (mut styled, _) = tokenize_with_grammar_skeleton(code, compiled, root_scope, light_theme, initial_stack)?;
  if let Some(dark_theme_name) = html_theme.dark_theme_name.as_deref() {
    if dark_theme_name == "none" {
      styled = apply_dark_theme_inherit(styled);
    }
    else {
      let fallback_dark = default_theme_data(dark_theme_name);
      let dark_theme = resolve_theme_data(dark_theme_name, themes).unwrap_or(&fallback_dark);
      let dark_initial = resolve_initial_stack(options_json, code, compiled, root_scope, dark_theme)?;
      let (dark_styled, _) = tokenize_with_grammar_skeleton(code, compiled, root_scope, dark_theme, dark_initial)?;
      styled = apply_dark_theme_palette(styled, &dark_styled);
    }
  }
  let default_fg = light_theme.fg.clone();
  let lines = styled_json_lines(&styled)
    .into_iter()
    .map(|line| merge_line_for_html(&line, &default_fg))
    .collect::<Vec<_>>();
  Ok(render_styled_html_lines(&lines, &html_theme, false))
}

fn render_grammar_tokens_json(
  code: &str,
  options_json: &str,
  compiled: &mut CompiledGrammar,
  root_scope: Option<&str>,
  themes: &HashMap<String, ThemeData>,
) -> Result<String> {
  let theme = resolve_theme_profile(options_json, "ferriki-grammar", themes);
  let fallback = default_theme_data(&theme.theme_name);
  let theme_data = resolve_theme_data(&theme.theme_name, themes).unwrap_or(&fallback);
  let initial_stack = resolve_initial_stack(options_json, code, compiled, root_scope, theme_data)?;
  let (styled, final_stack) = tokenize_with_grammar_skeleton(code, compiled, root_scope, theme_data, initial_stack)?;
  let lines = styled_json_lines(&styled);
  render_styled_tokens_json_with_state(lines, theme, &final_stack, root_scope)
}

fn render_grammar_hast_json(
  code: &str,
  options_json: &str,
  compiled: &mut CompiledGrammar,
  root_scope: Option<&str>,
  themes: &HashMap<String, ThemeData>,
) -> Result<String> {
  let html_theme = resolve_html_theme_profile(options_json, "ferriki-grammar", themes);
  let fallback_light = default_theme_data(&html_theme.theme_name);
  let light_theme = resolve_theme_data(&html_theme.theme_name, themes).unwrap_or(&fallback_light);
  let initial_stack = resolve_initial_stack(options_json, code, compiled, root_scope, light_theme)?;
  let (mut styled, final_stack) = tokenize_with_grammar_skeleton(code, compiled, root_scope, light_theme, initial_stack)?;
  if let Some(dark_theme_name) = html_theme.dark_theme_name.as_deref() {
    if dark_theme_name == "none" {
      styled = apply_dark_theme_inherit(styled);
    }
    else {
      let fallback_dark = default_theme_data(dark_theme_name);
      let dark_theme = resolve_theme_data(dark_theme_name, themes).unwrap_or(&fallback_dark);
      let dark_initial = resolve_initial_stack(options_json, code, compiled, root_scope, dark_theme)?;
      let (dark_styled, _) = tokenize_with_grammar_skeleton(code, compiled, root_scope, dark_theme, dark_initial)?;
      styled = apply_dark_theme_palette(styled, &dark_styled);
    }
  }
  let lines = styled_json_lines(&styled);
  let rust_state = serialize_state_frames(&final_stack, root_scope);
  render_styled_hast_payload_json(&lines, options_json, &html_theme, Some(rust_state))
}

#[napi]
impl FerrikiHighlighter {
  fn resolve_registered_scope(&self, lang_or_scope: &str) -> Option<String> {
    if self.grammars.borrow().contains_key(lang_or_scope) {
      return Some(lang_or_scope.to_owned());
    }
    if let Some(scope) = self.aliases.borrow().get(lang_or_scope).cloned() {
      return Some(scope);
    }
    self.ensure_standard_grammar_loaded(lang_or_scope).ok().flatten()
  }

  fn ensure_standard_theme_loaded(&self, theme_name: &str) -> Result<bool> {
    if self.themes.borrow().contains_key(theme_name) {
      return Ok(true);
    }
    let Some(catalogs) = &self.standard_assets else {
      return Ok(false);
    };
    let Some(asset) = catalogs.themes.load_asset(theme_name)? else {
      return Ok(false);
    };
    let theme = parse_theme_registration(&asset.theme_json)?;
    self.themes.borrow_mut().insert(theme.name.clone(), theme);
    Ok(true)
  }

  fn ensure_standard_themes_for_options(&self, options_json: &str) -> Result<()> {
    if let Some((light, dark)) = parse_dual_themes(options_json) {
      self.ensure_standard_theme_loaded(&light)?;
      self.ensure_standard_theme_loaded(&dark)?;
      return Ok(());
    }
    if let Some(theme) = parse_theme(options_json) {
      self.ensure_standard_theme_loaded(&theme)?;
    }
    Ok(())
  }

  fn ensure_standard_grammar_loaded(&self, lang_or_scope: &str) -> Result<Option<String>> {
    let mut visiting = HashSet::new();
    self.ensure_standard_grammar_loaded_inner(lang_or_scope, &mut visiting)
  }

  fn ensure_standard_grammar_loaded_inner(
    &self,
    lang_or_scope: &str,
    visiting: &mut HashSet<String>,
  ) -> Result<Option<String>> {
    if self.grammars.borrow().contains_key(lang_or_scope) {
      return Ok(Some(lang_or_scope.to_owned()));
    }
    if let Some(scope) = self.aliases.borrow().get(lang_or_scope).cloned() {
      return Ok(Some(scope));
    }

    let Some(catalogs) = &self.standard_assets else {
      return Ok(None);
    };
    let Some(asset) = catalogs.languages.load_asset(lang_or_scope)? else {
      return Ok(None);
    };
    let scope_name = asset.scope_name.clone();
    if self.grammars.borrow().contains_key(&scope_name) {
      return Ok(Some(scope_name));
    }

    let asset_id = asset.id.clone();
    if !visiting.insert(asset_id.clone()) {
      return Ok(Some(scope_name));
    }

    for dependency in asset.embedded_langs.iter().chain(asset.embedded_langs_lazy.iter()) {
      let _ = self.ensure_standard_grammar_loaded_inner(dependency, visiting)?;
    }

    let grammar = serde_json::from_str::<Value>(&asset.grammar_json)
      .map_err(|err| Error::from_reason(format!("Failed to parse standard grammar JSON: {err}")))?;

    self.aliases.borrow_mut().retain(|_, scope| scope != &scope_name);
    {
      let mut aliases = self.aliases.borrow_mut();
      for alias in &asset.aliases {
        aliases.insert(alias.clone(), scope_name.clone());
      }
    }
    self.grammars.borrow_mut().insert(scope_name.clone(), grammar);
    self.compiled_grammars.borrow_mut().remove(&scope_name);

    if !asset.inject_to.is_empty() {
      let mut injection_map = self.injection_map.borrow_mut();
      for target_scope in &asset.inject_to {
        let entry = injection_map.entry(target_scope.clone()).or_default();
        if !entry.contains(&scope_name) {
          entry.push(scope_name.clone());
        }
        self.compiled_grammars.borrow_mut().remove(target_scope);
      }
    }

    visiting.remove(&asset_id);
    Ok(Some(scope_name))
  }

  fn resolve_lang_mode(&self, options_json: &str) -> Result<LangMode> {
    let lang = resolve_lang_from_options(options_json)?;
    if let Some(mode) = resolve_lang_mode_from_lang(&lang) {
      return Ok(mode);
    }

    if let Some(scope) = self.resolve_registered_scope(&lang) {
      if let Some(mode) = lang_mode_from_scope(&scope) {
        return Ok(mode);
      }
      return Ok(LangMode::Grammar);
    }

    Err(Error::from_reason(
      "Ferriki currently supports text/txt/plain/plaintext/json and registered grammar skeleton mode.",
    ))
  }

  fn resolve_grammar_scope_from_options(&self, options_json: &str) -> Result<String> {
    let lang = resolve_lang_from_options(options_json)?;
    self.resolve_registered_scope(&lang).ok_or_else(|| {
      Error::from_reason("Ferriki grammar mode could not resolve registered scope from `options.lang`.")
    })
  }

  #[napi(js_name = "registerTheme")]
  pub fn register_theme(&mut self, payload_json: String) -> Result<()> {
    let theme = parse_theme_registration(&payload_json)?;
    let name = theme.name.clone();
    self.themes.borrow_mut().insert(name, theme);
    Ok(())
  }

  #[napi(js_name = "registerGrammar")]
  pub fn register_grammar(&mut self, payload_json: String) -> Result<()> {
    let registration = parse_grammar_registration(&payload_json)?;
    let scope_name = registration.scope_name.clone();
    let grammar = if registration.has_explicit_grammar {
      Some(registration.grammar)
    }
    else {
      self.grammars.borrow().get(&scope_name).cloned()
    };

    self.aliases
      .borrow_mut()
      .retain(|_, scope| scope != &scope_name);
    for alias in &registration.aliases {
      self.aliases
        .borrow_mut()
        .insert(alias.clone(), scope_name.clone());
    }
    if let Some(grammar) = grammar {
      self.grammars.borrow_mut().insert(scope_name.clone(), grammar);
    }

    // Invalidate compiled grammar cache for this scope
    self.compiled_grammars.borrow_mut().remove(&scope_name);

    // Build external injection map entries
    if !registration.inject_to.is_empty() {
      for target_scope in &registration.inject_to {
        let mut injection_map = self.injection_map.borrow_mut();
        let entry = injection_map.entry(target_scope.clone()).or_default();
        if !entry.contains(&scope_name) {
          entry.push(scope_name.clone());
        }
        // Invalidate compiled grammar cache for the target scope,
        // since it now has a new external injection
        self.compiled_grammars.borrow_mut().remove(target_scope);
      }
    }

    Ok(())
  }

  #[napi(js_name = "loadStandardTheme")]
  pub fn load_standard_theme(&mut self, theme_name: String) -> Result<bool> {
    self.ensure_standard_theme_loaded(&theme_name)
  }

  #[napi(js_name = "loadStandardGrammar")]
  pub fn load_standard_grammar(&mut self, lang_or_scope: String) -> Result<Option<String>> {
    self.ensure_standard_grammar_loaded(&lang_or_scope)
  }

  #[napi(js_name = "resolveGrammarScope")]
  pub fn resolve_grammar_scope(&self, lang_or_scope: String) -> Option<String> {
    self.resolve_registered_scope(&lang_or_scope)
  }

  #[napi(js_name = "getLoadedGrammarScopes")]
  pub fn get_loaded_grammar_scopes(&self) -> Vec<String> {
    let mut scopes = self.grammars.borrow().keys().cloned().collect::<Vec<_>>();
    scopes.sort();
    scopes
  }

  fn get_or_compile_grammar(&self, scope: &str) -> Result<()> {
    let needs_compile = !self.compiled_grammars.borrow().contains_key(scope);
    if needs_compile {
      let compiled = {
        let grammars = self.grammars.borrow();
        let injection_map = self.injection_map.borrow();
        let grammar = grammars
          .get(scope)
          .ok_or_else(|| Error::from_reason("Ferriki grammar not found in registry."))?;
        compile_grammar(grammar, &grammars, &injection_map)?
      };
      self.compiled_grammars.borrow_mut().insert(scope.to_owned(), compiled);
    }
    Ok(())
  }

  #[napi(js_name = "codeToHtml")]
  pub fn code_to_html(&self, code: String, options_json: String) -> Result<String> {
    self.ensure_standard_themes_for_options(&options_json)?;
    match self.resolve_lang_mode(&options_json)? {
      LangMode::Plaintext => {
        let themes = self.themes.borrow();
        Ok(render_plain_html(&code, &options_json, &themes))
      }
      LangMode::Json => {
        let themes = self.themes.borrow();
        render_json_html(&code, &options_json, &themes)
      }
      LangMode::Grammar => {
        let scope = self.resolve_grammar_scope_from_options(&options_json)?;
        self.get_or_compile_grammar(&scope)?;
        let root_scope = Some(scope.as_str());
        let themes = self.themes.borrow();
        let mut cache = self.compiled_grammars.borrow_mut();
        let compiled = cache.get_mut(&scope)
          .ok_or_else(|| Error::from_reason("Ferriki compiled grammar not found after compilation."))?;
        render_grammar_html(&code, &options_json, compiled, root_scope, &themes)
      }
    }
  }

  #[napi(js_name = "codeToTokens")]
  pub fn code_to_tokens(&self, code: String, options_json: String) -> Result<String> {
    self.ensure_standard_themes_for_options(&options_json)?;
    match self.resolve_lang_mode(&options_json)? {
      LangMode::Plaintext => {
        let themes = self.themes.borrow();
        render_plain_tokens_json(&code, &options_json, &themes)
      }
      LangMode::Json => {
        let themes = self.themes.borrow();
        render_json_tokens_json(&code, &options_json, &themes)
      }
      LangMode::Grammar => {
        let scope = self.resolve_grammar_scope_from_options(&options_json)?;
        self.get_or_compile_grammar(&scope)?;
        let root_scope = Some(scope.as_str());
        let themes = self.themes.borrow();
        let mut cache = self.compiled_grammars.borrow_mut();
        let compiled = cache.get_mut(&scope)
          .ok_or_else(|| Error::from_reason("Ferriki compiled grammar not found after compilation."))?;
        render_grammar_tokens_json(&code, &options_json, compiled, root_scope, &themes)
      }
    }
  }

  #[napi(js_name = "codeToHast")]
  pub fn code_to_hast(&self, code: String, options_json: String) -> Result<String> {
    self.ensure_standard_themes_for_options(&options_json)?;
    match self.resolve_lang_mode(&options_json)? {
      LangMode::Plaintext => {
        let themes = self.themes.borrow();
        render_plain_hast_json(&code, &options_json, &themes)
      }
      LangMode::Json => {
        let themes = self.themes.borrow();
        render_json_hast_json(&code, &options_json, &themes)
      }
      LangMode::Grammar => {
        let scope = self.resolve_grammar_scope_from_options(&options_json)?;
        self.get_or_compile_grammar(&scope)?;
        let root_scope = Some(scope.as_str());
        let themes = self.themes.borrow();
        let mut cache = self.compiled_grammars.borrow_mut();
        let compiled = cache.get_mut(&scope)
          .ok_or_else(|| Error::from_reason("Ferriki compiled grammar not found after compilation."))?;
        render_grammar_hast_json(&code, &options_json, compiled, root_scope, &themes)
      }
    }
  }

  #[napi]
  pub fn dispose(&self) {
    // Placeholder for future explicit cleanup.
  }
}

#[napi(js_name = "createHighlighter")]
pub fn create_highlighter(options_json: String) -> FerrikiHighlighter {
  // Set oniguruma limits to prevent catastrophic backtracking
  regexec::onig_set_retry_limit_in_match(50_000);
  regexec::onig_set_retry_limit_in_search(50_000);
  regexec::onig_set_match_stack_limit(10_000);
  let standard_assets = parse_standard_asset_root(&options_json)
    .and_then(|root| StandardAssetCatalogs::load_from_root(std::path::Path::new(&root)).ok());

  FerrikiHighlighter {
    _options_json: options_json,
    standard_assets,
    grammars: RefCell::new(HashMap::new()),
    aliases: RefCell::new(HashMap::new()),
    themes: RefCell::new(HashMap::new()),
    compiled_grammars: RefCell::new(HashMap::new()),
    injection_map: RefCell::new(HashMap::new()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use ferriki_asset_gen::{AssetSourceRef, generate_catalogs_from_upstream};
  use ferroni::scanner::{OnigString, Scanner, ScannerFindOptions};
  use std::fs;
  use std::path::Path;
  use std::time::{SystemTime, UNIX_EPOCH};

  fn temp_output_dir(label: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("clock")
      .as_nanos();
    std::env::temp_dir().join(format!("ferriki-{label}-{nanos}"))
  }

  #[test]
  fn test_scope_component_matches_exact() {
    assert!(scope_component_matches("comment", "comment"));
  }

  #[test]
  fn test_scope_component_matches_prefix() {
    assert!(scope_component_matches("comment", "comment.line"));
    assert!(scope_component_matches("keyword", "keyword.control.ts"));
  }

  #[test]
  fn test_scope_component_no_partial() {
    assert!(!scope_component_matches("key", "keyword"));
    assert!(!scope_component_matches("comment.l", "comment.line"));
  }

  /// Test helper: split selector and call selector_matches_presplit
  fn selector_matches(selector: &str, scope_stack: &[&str]) -> Option<usize> {
    let parts: Vec<String> = selector.split_whitespace().map(str::to_owned).collect();
    selector_matches_presplit(&parts, scope_stack)
  }

  #[test]
  fn test_selector_matches_single() {
    let stack = vec!["source.ts", "keyword.control.ts"];
    assert!(selector_matches("keyword", &stack).is_some());
    assert!(selector_matches("keyword.control", &stack).is_some());
    assert!(selector_matches("keyword.control.ts", &stack).is_some());
    assert!(selector_matches("string", &stack).is_none());
  }

  #[test]
  fn test_selector_matches_ancestor_chain() {
    let stack = vec!["source.ts", "meta.block.ts", "keyword.control.ts"];
    assert!(selector_matches("source.ts keyword.control", &stack).is_some());
    assert!(selector_matches("meta.block keyword.control", &stack).is_some());
    assert!(selector_matches("source.ts meta.block keyword.control", &stack).is_some());
    assert!(selector_matches("string keyword.control", &stack).is_none());
  }

  #[test]
  fn test_selector_specificity_longer_wins() {
    let stack = vec!["source.ts", "comment.line.ts"];
    let score1 = selector_matches("comment", &stack).unwrap();
    let score2 = selector_matches("comment.line", &stack).unwrap();
    assert!(score2 > score1);
  }

  #[test]
  fn test_resolve_token_style_basic() {
    let theme = ThemeData {
      name: "test".to_owned(),
      fg: "#ffffff".to_owned(),
      fg_normalized: Arc::<str>::from("#FFFFFF"),
      bg: "#000000".to_owned(),
      settings: vec![
        ThemeRule::new(vec![], Some("#ffffff".to_owned()), 0),
        ThemeRule::new(vec!["comment".to_owned()], Some("#666666".to_owned()), 1),
        ThemeRule::new(vec!["keyword".to_owned()], Some("#ff0000".to_owned()), 0),
      ],
    };

    let style = resolve_token_style(&["source.ts", "comment.line.ts"], &theme);
    assert_eq!(style.foreground.as_deref(), Some("#666666"));
    assert_eq!(style.font_style, 1);

    let style2 = resolve_token_style(&["source.ts", "keyword.control.ts"], &theme);
    assert_eq!(style2.foreground.as_deref(), Some("#FF0000"));

    let style3 = resolve_token_style(&["source.ts", "variable.other.ts"], &theme);
    assert_eq!(style3.foreground.as_deref(), Some("#FFFFFF"));
  }

  #[test]
  fn test_resolve_token_style_specificity() {
    let theme = ThemeData {
      name: "test".to_owned(),
      fg: "#ffffff".to_owned(),
      fg_normalized: Arc::<str>::from("#FFFFFF"),
      bg: "#000000".to_owned(),
      settings: vec![
        ThemeRule::new(vec!["string".to_owned()], Some("#aaaaaa".to_owned()), 0),
        ThemeRule::new(vec!["string.quoted".to_owned()], Some("#bbbbbb".to_owned()), 0),
        ThemeRule::new(vec!["string.quoted.double".to_owned()], Some("#cccccc".to_owned()), 0),
      ],
    };

    let style = resolve_token_style(&["source.ts", "string.quoted.double.ts"], &theme);
    assert_eq!(style.foreground.as_deref(), Some("#CCCCCC"));
  }

  #[test]
  fn test_has_back_references() {
    assert!(has_back_references("\\1"));
    assert!(has_back_references("foo\\2bar"));
    assert!(!has_back_references("foo\\\\1"));
    assert!(!has_back_references("foo\\0bar"));
    assert!(!has_back_references("no backrefs here"));
  }

  #[test]
  fn test_init_grammar_creates_self_and_base() {
    let grammar = json!({
      "scopeName": "source.test",
      "patterns": [{"match": "foo"}],
      "repository": {
        "strings": {"match": "bar"}
      }
    });

    let initialized = init_grammar(&grammar, None);
    let repo = initialized.get("repository").unwrap().as_object().unwrap();
    assert!(repo.contains_key("$self"));
    assert!(repo.contains_key("$base"));

    let self_entry = repo.get("$self").unwrap();
    assert_eq!(
      self_entry.get("name").unwrap().as_str().unwrap(),
      "source.test"
    );
  }

  #[test]
  fn test_rule_registry_alloc_and_get() {
    let mut reg = RuleRegistry::new();
    let id1 = reg.alloc_id();
    let id2 = reg.alloc_id();
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);

    reg.store(id1, Rule::Match {
      _id: id1,
      name: Some("test".to_owned()),
      match_re: "foo".to_owned(),
      captures: vec![],
    });

    assert!(reg.get(id1).is_some());
    assert!(reg.get(id2).is_none()); // Not yet stored
    assert!(reg.get(END_RULE_ID).is_none()); // Negative
  }

  #[test]
  fn create_highlighter_can_load_standard_assets_from_root() {
    let upstream_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../ferriki-asset-gen/tests/fixtures/upstream/textmate-grammars-themes");
    let output_dir = temp_output_dir("standard-asset-root");
    generate_catalogs_from_upstream(
      &upstream_dir,
      &output_dir,
      AssetSourceRef {
        upstream: "textmate-grammars-themes".to_owned(),
        version: Some("1.0.0".to_owned()),
        commit: Some("abc123".to_owned()),
      },
    )
    .expect("generate");

    let mut highlighter = create_highlighter(
      json!({ "standardAssetRoot": output_dir.display().to_string() }).to_string(),
    );

    assert!(highlighter.load_standard_theme("vitesse-light".to_owned()).expect("theme"));
    assert_eq!(
      highlighter.load_standard_grammar("js".to_owned()).expect("grammar"),
      Some("source.js".to_owned())
    );
    assert_eq!(
      highlighter.resolve_grammar_scope("mjs".to_owned()),
      Some("source.js".to_owned())
    );

    fs::remove_dir_all(output_dir).expect("cleanup");
  }

  #[test]
  fn load_standard_grammar_recursively_registers_embedded_standard_dependencies() {
    let asset_root = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../../assets/shiki");

    let mut highlighter = create_highlighter(
      json!({ "standardAssetRoot": asset_root.display().to_string() }).to_string(),
    );

    assert_eq!(
      highlighter.load_standard_grammar("vue".to_owned()).expect("grammar"),
      Some("text.html.vue".to_owned())
    );

    let scopes = highlighter.get_loaded_grammar_scopes();
    assert!(scopes.contains(&"text.html.vue".to_owned()));
    assert!(scopes.contains(&"text.html.basic".to_owned()));
    assert!(scopes.contains(&"source.js".to_owned()));
    assert!(scopes.contains(&"source.ts".to_owned()));
  }

  #[test]
  fn standard_js_function_calls_and_whitespace_match_expected_theme_scopes() {
    let asset_root = Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../../assets/shiki");

    let highlighter = create_highlighter(
      json!({ "standardAssetRoot": asset_root.display().to_string() }).to_string(),
    );
    assert!(highlighter.ensure_standard_theme_loaded("nord").expect("theme"));
    let themes = highlighter.themes.borrow();
    let nord = themes.get("Nord").or_else(|| themes.get("nord")).expect("nord theme");
    let direct_function_style = resolve_token_style(&["source.js", "entity.name.function.js"], nord);
    assert_eq!(direct_function_style.foreground.as_deref(), Some("#88C0D0"));
    let nested_function_style = resolve_token_style(
      &["source.js", "meta.function-call.js", "entity.name.function.js"],
      nord,
    );
    assert_eq!(nested_function_style.foreground.as_deref(), Some("#88C0D0"));
    drop(themes);

    let generated_catalogs = StandardAssetCatalogs::load_from_root(&asset_root).expect("catalogs");
    let generated_js_asset = generated_catalogs
      .languages
      .load_asset("javascript")
      .expect("asset")
      .expect("present");
    let js_grammar: Value = serde_json::from_str(&generated_js_asset.grammar_json).expect("grammar json");
    let function_call_begin = js_grammar["repository"]["function-call"]["patterns"][0]["begin"]
      .as_str()
      .expect("function-call begin");
    let mut function_call_scanner = Scanner::new(&[function_call_begin]).expect("scanner");
    let function_call_match = function_call_scanner.find_next_match_utf16(
      &OnigString::new("console.log("),
      0,
      ScannerFindOptions::from_bits(0),
    );
    assert!(
      function_call_match.is_some(),
      "Ferroni should match the JavaScript function-call begin rule for console.log("
    );

    let js_tokens = highlighter
      .code_to_tokens(
        "console.log(\"Hi\")".to_owned(),
        json!({
          "lang": "javascript",
          "theme": "nord",
        })
        .to_string(),
      )
      .expect("tokens");
    let js_payload: Value = serde_json::from_str(&js_tokens).expect("json");
    let js_line = js_payload["tokens"][0].as_array().expect("line");

    let js_pairs = js_line
      .iter()
      .map(|token| {
        (
          token["content"].as_str().unwrap().to_owned(),
          token["color"].as_str().unwrap().to_owned(),
        )
      })
      .collect::<Vec<_>>();
    assert_eq!(
      js_pairs,
      vec![
        ("console".to_owned(), "#D8DEE9".to_owned()),
        (".".to_owned(), "#ECEFF4".to_owned()),
        ("log".to_owned(), "#88C0D0".to_owned()),
        ("(".to_owned(), "#D8DEE9FF".to_owned()),
        ("\"".to_owned(), "#ECEFF4".to_owned()),
        ("Hi".to_owned(), "#A3BE8C".to_owned()),
        ("\"".to_owned(), "#ECEFF4".to_owned()),
        (")".to_owned(), "#D8DEE9FF".to_owned()),
      ]
    );

    let whitespace_html = highlighter
      .code_to_html(
        "  space()\n\t\ttab()".to_owned(),
        json!({
          "lang": "javascript",
          "theme": "vitesse-light",
        })
        .to_string(),
      )
      .expect("html");
    assert_eq!(
      whitespace_html,
      "<pre class=\"shiki vitesse-light\" style=\"background-color:#ffffff;color:#393a34\" tabindex=\"0\"><code><span class=\"line\"><span style=\"color:#59873A\">  space</span><span style=\"color:#999999\">()</span></span>\n<span class=\"line\"><span style=\"color:#59873A\">\t\ttab</span><span style=\"color:#999999\">()</span></span></code></pre>"
    );
  }

  #[test]
  fn ferroni_matches_simple_after_tag_lookbehind() {
    let mut scanner = Scanner::new(&["(?<=>)"]).expect("scanner");
    let matched = scanner.find_next_match_utf16(
      &OnigString::new(">\n"),
      1,
      ScannerFindOptions::from_bits(0),
    );
    assert!(matched.is_some(), "Ferroni should match (?<=>) after a tag close.");
  }
}
