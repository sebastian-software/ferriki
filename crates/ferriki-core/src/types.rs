use crate::render::*;
use ferroni::scanner::Scanner;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

#[derive(Clone, Copy)]
pub(crate) enum LangMode {
    Plaintext,
    Json,
    Grammar,
}

pub(crate) struct JsonToken {
    pub(crate) kind: &'static str,
    pub(crate) start_utf16: usize,
    pub(crate) end_utf16: usize,
    pub(crate) content: String,
}

#[derive(Clone)]
pub(crate) struct StyledJsonToken {
    pub(crate) content: String,
    pub(crate) content_utf16_len: usize,
    pub(crate) offset_utf16: usize,
    pub(crate) color: Arc<str>,
    pub(crate) font_style: u8,
    pub(crate) dark_color: Option<Arc<str>>,
}

pub(crate) struct JsonThemeProfile {
    pub(crate) pre_class: String,
    pub(crate) pre_style: Option<String>,
    pub(crate) theme_name: String,
    pub(crate) fg: Option<String>,
    pub(crate) bg: Option<String>,
}

pub(crate) struct HtmlThemeProfile {
    pub(crate) pre_class: String,
    pub(crate) pre_style: Option<String>,
    pub(crate) theme_name: String,
    pub(crate) dark_theme_name: Option<String>,
    pub(crate) fg: Option<String>,
    pub(crate) bg: Option<String>,
    pub(crate) dark_fg: Option<String>,
    pub(crate) dark_bg: Option<String>,
    pub(crate) disable_token_coloring: bool,
}

pub(crate) struct ThemeRule {
    pub(crate) scopes: Vec<String>,
    /// Pre-split selector parts for each scope (avoids repeated split_whitespace)
    pub(crate) scope_parts: Vec<Vec<String>>,
    pub(crate) foreground: Option<Arc<str>>,
    pub(crate) font_style: u8,
}

impl ThemeRule {
    pub(crate) fn new(scopes: Vec<String>, foreground: Option<String>, font_style: u8) -> Self {
        let scope_parts = scopes
            .iter()
            .map(|s| s.split_whitespace().map(str::to_owned).collect())
            .collect();
        // Pre-normalize foreground color at registration time
        let foreground = foreground
            .map(|c| normalize_hex_color(&c))
            .map(Arc::<str>::from);
        Self {
            scopes,
            scope_parts,
            foreground,
            font_style,
        }
    }
}

pub(crate) struct ThemeData {
    pub(crate) name: String,
    pub(crate) fg: String,
    pub(crate) fg_normalized: Arc<str>,
    pub(crate) bg: String,
    pub(crate) settings: Vec<ThemeRule>,
}

pub(crate) struct GrammarRegistration {
    pub(crate) scope_name: String,
    pub(crate) grammar: Value,
    pub(crate) aliases: Vec<String>,
    pub(crate) has_explicit_grammar: bool,
    pub(crate) inject_to: Vec<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// New RuleId-based architecture (port of vscode-textmate)
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) type RuleId = i32;
pub(crate) const END_RULE_ID: RuleId = -1;
pub(crate) static NEXT_ONIG_STR_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub(crate) struct GrammarCapture {
    pub(crate) index: usize,
    pub(crate) name: Option<String>,
}

pub(crate) struct RuleRegistry {
    pub(crate) rules: Vec<Option<Rule>>,
    pub(crate) next_id: RuleId,
}

impl RuleRegistry {
    pub(crate) fn new() -> Self {
        RuleRegistry {
            rules: vec![None], // index 0 is unused (root sentinel)
            next_id: 1,
        }
    }

    pub(crate) fn alloc_id(&mut self) -> RuleId {
        let id = self.next_id;
        self.next_id += 1;
        // Ensure vec is large enough
        while self.rules.len() <= id as usize {
            self.rules.push(None);
        }
        id
    }

    pub(crate) fn store(&mut self, id: RuleId, rule: Rule) {
        self.rules[id as usize] = Some(rule);
    }

    pub(crate) fn get(&self, id: RuleId) -> Option<&Rule> {
        if id < 0 || id as usize >= self.rules.len() {
            return None;
        }
        self.rules[id as usize].as_ref()
    }
}

pub(crate) enum Rule {
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

pub(crate) struct CompiledScanner {
    pub(crate) scanner: Scanner,
    pub(crate) rule_ids: Vec<RuleId>, // match index → RuleId
    pub(crate) regexes: Vec<String>,
    pub(crate) single_scanners: Vec<Option<Scanner>>,
}

pub(crate) struct StateFrame {
    pub(crate) rule_id: RuleId,
    pub(crate) _enter_pos: i32,
    pub(crate) _anchor_pos: i32,
    pub(crate) end_rule: Option<String>,
    pub(crate) name_scopes: Vec<String>,
    pub(crate) content_scopes: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum InjectionPriority {
    Left,
    Default,
    Right,
}

pub(crate) struct CompiledSelector {
    pub(crate) clauses: Vec<CompiledSelectorClause>,
}

pub(crate) struct CompiledSelectorClause {
    pub(crate) disjuncts: Vec<CompiledSelectorDisjunct>,
}

pub(crate) struct CompiledSelectorDisjunct {
    pub(crate) terms: Vec<CompiledSelectorTerm>,
}

pub(crate) struct CompiledSelectorTerm {
    pub(crate) negate: bool,
    pub(crate) expr: CompiledSelectorExpr,
}

pub(crate) enum CompiledSelectorExpr {
    Token(String),
    AnyOf(Vec<CompiledSelectorDisjunct>),
}

pub(crate) struct Injection {
    pub(crate) compiled_selector: CompiledSelector,
    pub(crate) rule_id: RuleId,
    pub(crate) priority: InjectionPriority,
}

pub(crate) struct CompiledGrammar {
    pub(crate) registry: RuleRegistry,
    pub(crate) root_rule_id: RuleId,
    pub(crate) injections: Vec<Injection>,
    pub(crate) scanner_cache: HashMap<(RuleId, Option<String>), CompiledScanner>,
    pub(crate) injection_scanner_cache: HashMap<RuleId, CompiledScanner>,
    /// Cache for single-pattern while-condition scanners, keyed by regex string
    pub(crate) while_scanner_cache: HashMap<String, Scanner>,
}

pub(crate) const COLOR_DEFAULT_FG: &str = "#DBD7CAEE";
pub(crate) const COLOR_DEFAULT_BG: &str = "#121212";
pub(crate) const COLOR_INHERIT: &str = "inherit";
