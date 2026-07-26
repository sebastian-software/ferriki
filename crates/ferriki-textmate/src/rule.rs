/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::path::Path;
use std::sync::{Arc, Mutex};

use ferroni::error::RegexError;

use crate::raw_grammar::{Location, RuleId};
use crate::regexp::{
    has_captures, replace_captures, CaptureIndex, CompiledRule, RegExpSource, RegExpSourceList,
};

/// The scanner identity for a compiled grammar pattern.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuleScannerId {
    Rule(RuleId),
    End,
    While,
}

#[derive(Clone, Debug)]
struct RuleData {
    location: Option<Location>,
    id: RuleId,
    name: Option<String>,
    name_is_capturing: bool,
    content_name: Option<String>,
    content_name_is_capturing: bool,
}

impl RuleData {
    fn new(
        location: Option<Location>,
        id: RuleId,
        name: Option<String>,
        content_name: Option<String>,
    ) -> Self {
        let name_is_capturing = has_captures(name.as_deref());
        let content_name_is_capturing = has_captures(content_name.as_deref());
        Self {
            location,
            id,
            name,
            name_is_capturing,
            content_name,
            content_name_is_capturing,
        }
    }

    fn debug_name(&self, rule_name: &str) -> String {
        let location = self.location.as_ref().map_or_else(
            || "unknown".to_owned(),
            |location| {
                let filename = Path::new(&location.filename)
                    .file_name()
                    .and_then(|filename| filename.to_str())
                    .unwrap_or(&location.filename);
                format!("{filename}:{}", location.line)
            },
        );
        format!("{rule_name}#{} @ {location}", self.id.get())
    }

    fn get_name(
        &self,
        line_text: Option<&str>,
        capture_indices: Option<&[CaptureIndex]>,
    ) -> Option<String> {
        let name = self.name.as_ref()?;
        if !self.name_is_capturing {
            return Some(name.clone());
        }
        let (Some(line_text), Some(capture_indices)) = (line_text, capture_indices) else {
            return Some(name.clone());
        };
        Some(replace_captures(name, line_text, capture_indices))
    }

    fn get_content_name(
        &self,
        line_text: &str,
        capture_indices: &[CaptureIndex],
    ) -> Option<String> {
        let content_name = self.content_name.as_ref()?;
        if !self.content_name_is_capturing {
            return Some(content_name.clone());
        }
        Some(replace_captures(content_name, line_text, capture_indices))
    }
}

pub struct CaptureRule {
    data: RuleData,
    pub retokenize_captured_with_rule_id: Option<RuleId>,
}

impl CaptureRule {
    #[must_use]
    pub fn new(
        location: Option<Location>,
        id: RuleId,
        name: Option<String>,
        content_name: Option<String>,
        retokenize_captured_with_rule_id: Option<RuleId>,
    ) -> Self {
        Self {
            data: RuleData::new(location, id, name, content_name),
            retokenize_captured_with_rule_id,
        }
    }
}

pub struct MatchRule {
    data: RuleData,
    match_source: RegExpSource<RuleScannerId>,
    pub captures: Vec<Option<Arc<CaptureRule>>>,
    cached_compiled_patterns: Mutex<Option<RegExpSourceList<RuleScannerId>>>,
}

impl MatchRule {
    #[must_use]
    pub fn new(
        location: Option<Location>,
        id: RuleId,
        name: Option<String>,
        match_pattern: impl Into<String>,
        captures: Vec<Option<Arc<CaptureRule>>>,
    ) -> Self {
        Self {
            data: RuleData::new(location, id, name, None),
            match_source: RegExpSource::new(match_pattern, RuleScannerId::Rule(id)),
            captures,
            cached_compiled_patterns: Mutex::new(None),
        }
    }

    #[must_use]
    pub fn debug_match_reg_exp(&self) -> &str {
        &self.match_source.source
    }
}

pub struct IncludeOnlyRule {
    data: RuleData,
    pub has_missing_patterns: bool,
    pub patterns: Vec<RuleId>,
    cached_compiled_patterns: Mutex<Option<RegExpSourceList<RuleScannerId>>>,
}

impl IncludeOnlyRule {
    #[must_use]
    pub fn new(
        location: Option<Location>,
        id: RuleId,
        name: Option<String>,
        content_name: Option<String>,
        patterns: CompilePatternsResult,
    ) -> Self {
        Self {
            data: RuleData::new(location, id, name, content_name),
            has_missing_patterns: patterns.has_missing_patterns,
            patterns: patterns.patterns,
            cached_compiled_patterns: Mutex::new(None),
        }
    }
}

pub struct BeginEndRule {
    data: RuleData,
    begin: RegExpSource<RuleScannerId>,
    pub begin_captures: Vec<Option<Arc<CaptureRule>>>,
    end: RegExpSource<RuleScannerId>,
    pub end_has_back_references: bool,
    pub end_captures: Vec<Option<Arc<CaptureRule>>>,
    pub apply_end_pattern_last: bool,
    pub has_missing_patterns: bool,
    pub patterns: Vec<RuleId>,
    cached_compiled_patterns: Mutex<Option<RegExpSourceList<RuleScannerId>>>,
}

pub struct BeginEndRuleOptions {
    pub location: Option<Location>,
    pub id: RuleId,
    pub name: Option<String>,
    pub content_name: Option<String>,
    pub begin: String,
    pub begin_captures: Vec<Option<Arc<CaptureRule>>>,
    pub end: Option<String>,
    pub end_captures: Vec<Option<Arc<CaptureRule>>>,
    pub apply_end_pattern_last: bool,
    pub patterns: CompilePatternsResult,
}

impl BeginEndRule {
    #[must_use]
    pub fn new(options: BeginEndRuleOptions) -> Self {
        let end = RegExpSource::new(
            options.end.unwrap_or_else(|| "\u{ffff}".to_owned()),
            RuleScannerId::End,
        );
        let end_has_back_references = end.has_back_references;
        Self {
            data: RuleData::new(
                options.location,
                options.id,
                options.name,
                options.content_name,
            ),
            begin: RegExpSource::new(options.begin, RuleScannerId::Rule(options.id)),
            begin_captures: options.begin_captures,
            end,
            end_has_back_references,
            end_captures: options.end_captures,
            apply_end_pattern_last: options.apply_end_pattern_last,
            has_missing_patterns: options.patterns.has_missing_patterns,
            patterns: options.patterns.patterns,
            cached_compiled_patterns: Mutex::new(None),
        }
    }

    #[must_use]
    pub fn debug_begin_reg_exp(&self) -> &str {
        &self.begin.source
    }

    #[must_use]
    pub fn debug_end_reg_exp(&self) -> &str {
        &self.end.source
    }

    #[must_use]
    pub fn get_end_with_resolved_back_references(
        &self,
        line_text: &str,
        capture_indices: &[CaptureIndex],
    ) -> String {
        self.end.resolve_back_references(line_text, capture_indices)
    }
}

pub struct BeginWhileRule {
    data: RuleData,
    begin: RegExpSource<RuleScannerId>,
    pub begin_captures: Vec<Option<Arc<CaptureRule>>>,
    pub while_captures: Vec<Option<Arc<CaptureRule>>>,
    while_source: RegExpSource<RuleScannerId>,
    pub while_has_back_references: bool,
    pub has_missing_patterns: bool,
    pub patterns: Vec<RuleId>,
    cached_compiled_patterns: Mutex<Option<RegExpSourceList<RuleScannerId>>>,
    cached_compiled_while_patterns: Mutex<Option<RegExpSourceList<RuleScannerId>>>,
}

pub struct BeginWhileRuleOptions {
    pub location: Option<Location>,
    pub id: RuleId,
    pub name: Option<String>,
    pub content_name: Option<String>,
    pub begin: String,
    pub begin_captures: Vec<Option<Arc<CaptureRule>>>,
    pub while_pattern: String,
    pub while_captures: Vec<Option<Arc<CaptureRule>>>,
    pub patterns: CompilePatternsResult,
}

impl BeginWhileRule {
    #[must_use]
    pub fn new(options: BeginWhileRuleOptions) -> Self {
        let while_source = RegExpSource::new(options.while_pattern, RuleScannerId::While);
        let while_has_back_references = while_source.has_back_references;
        Self {
            data: RuleData::new(
                options.location,
                options.id,
                options.name,
                options.content_name,
            ),
            begin: RegExpSource::new(options.begin, RuleScannerId::Rule(options.id)),
            begin_captures: options.begin_captures,
            while_captures: options.while_captures,
            while_source,
            while_has_back_references,
            has_missing_patterns: options.patterns.has_missing_patterns,
            patterns: options.patterns.patterns,
            cached_compiled_patterns: Mutex::new(None),
            cached_compiled_while_patterns: Mutex::new(None),
        }
    }

    #[must_use]
    pub fn debug_begin_reg_exp(&self) -> &str {
        &self.begin.source
    }

    #[must_use]
    pub fn debug_while_reg_exp(&self) -> &str {
        &self.while_source.source
    }

    #[must_use]
    pub fn get_while_with_resolved_back_references(
        &self,
        line_text: &str,
        capture_indices: &[CaptureIndex],
    ) -> String {
        self.while_source
            .resolve_back_references(line_text, capture_indices)
    }

    pub fn compile_while(
        &self,
        end_regex_source: Option<&str>,
    ) -> Result<Arc<CompiledRule<RuleScannerId>>, RegexError> {
        self.compile_while_ag(end_regex_source, true, true)
    }

    pub fn compile_while_ag(
        &self,
        end_regex_source: Option<&str>,
        allow_a: bool,
        allow_g: bool,
    ) -> Result<Arc<CompiledRule<RuleScannerId>>, RegexError> {
        let mut cached = self
            .cached_compiled_while_patterns
            .lock()
            .expect("compiled while-pattern cache lock poisoned");
        let sources = cached.get_or_insert_with(|| {
            let mut sources = RegExpSourceList::new();
            sources.push(self.while_source.clone());
            sources
        });
        if self.while_has_back_references {
            sources.set_source(0, end_regex_source.unwrap_or("\u{ffff}"));
        }
        sources.compile_ag(allow_a, allow_g)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CompilePatternsResult {
    pub patterns: Vec<RuleId>,
    pub has_missing_patterns: bool,
}

pub enum Rule {
    Capture(Arc<CaptureRule>),
    Match(MatchRule),
    IncludeOnly(IncludeOnlyRule),
    BeginEnd(BeginEndRule),
    BeginWhile(BeginWhileRule),
}

impl Rule {
    #[must_use]
    pub fn id(&self) -> RuleId {
        self.data().id
    }

    #[must_use]
    pub fn location(&self) -> Option<&Location> {
        self.data().location.as_ref()
    }

    #[must_use]
    pub fn debug_name(&self) -> String {
        self.data().debug_name(match self {
            Self::Capture(_) => "CaptureRule",
            Self::Match(_) => "MatchRule",
            Self::IncludeOnly(_) => "IncludeOnlyRule",
            Self::BeginEnd(_) => "BeginEndRule",
            Self::BeginWhile(_) => "BeginWhileRule",
        })
    }

    #[must_use]
    pub fn get_name(
        &self,
        line_text: Option<&str>,
        capture_indices: Option<&[CaptureIndex]>,
    ) -> Option<String> {
        self.data().get_name(line_text, capture_indices)
    }

    #[must_use]
    pub fn get_content_name(
        &self,
        line_text: &str,
        capture_indices: &[CaptureIndex],
    ) -> Option<String> {
        self.data().get_content_name(line_text, capture_indices)
    }

    pub fn dispose(&self) {
        match self {
            Self::Capture(_) => {}
            Self::Match(rule) => clear_cache(&rule.cached_compiled_patterns),
            Self::IncludeOnly(rule) => clear_cache(&rule.cached_compiled_patterns),
            Self::BeginEnd(rule) => clear_cache(&rule.cached_compiled_patterns),
            Self::BeginWhile(rule) => {
                clear_cache(&rule.cached_compiled_patterns);
                clear_cache(&rule.cached_compiled_while_patterns);
            }
        }
    }

    pub fn collect_patterns(
        &self,
        registry: &RuleRegistry,
        output: &mut RegExpSourceList<RuleScannerId>,
    ) {
        match self {
            Self::Capture(_) => panic!("capture rules cannot collect scanner patterns"),
            Self::Match(rule) => output.push(rule.match_source.clone()),
            Self::IncludeOnly(rule) => {
                collect_pattern_ids(registry, &rule.patterns, output);
            }
            Self::BeginEnd(rule) => output.push(rule.begin.clone()),
            Self::BeginWhile(rule) => output.push(rule.begin.clone()),
        }
    }

    pub fn compile(
        &self,
        registry: &RuleRegistry,
        end_regex_source: Option<&str>,
    ) -> Result<Arc<CompiledRule<RuleScannerId>>, RegexError> {
        self.compile_ag(registry, end_regex_source, true, true)
    }

    pub fn compile_ag(
        &self,
        registry: &RuleRegistry,
        end_regex_source: Option<&str>,
        allow_a: bool,
        allow_g: bool,
    ) -> Result<Arc<CompiledRule<RuleScannerId>>, RegexError> {
        match self {
            Self::Capture(_) => panic!("capture rules cannot compile scanner patterns"),
            Self::Match(rule) => {
                let mut cached = rule
                    .cached_compiled_patterns
                    .lock()
                    .expect("compiled pattern cache lock poisoned");
                let sources = cached.get_or_insert_with(|| {
                    let mut sources = RegExpSourceList::new();
                    sources.push(rule.match_source.clone());
                    sources
                });
                sources.compile_ag(allow_a, allow_g)
            }
            Self::IncludeOnly(rule) => compile_patterns(
                &rule.cached_compiled_patterns,
                registry,
                Some(&rule.patterns),
                allow_a,
                allow_g,
            ),
            Self::BeginEnd(rule) => {
                let mut cached = rule
                    .cached_compiled_patterns
                    .lock()
                    .expect("compiled pattern cache lock poisoned");
                let sources = cached.get_or_insert_with(|| {
                    let mut sources = RegExpSourceList::new();
                    collect_pattern_ids(registry, &rule.patterns, &mut sources);
                    if rule.apply_end_pattern_last {
                        sources.push(rule.end.clone());
                    } else {
                        sources.unshift(rule.end.clone());
                    }
                    sources
                });
                if rule.end_has_back_references {
                    let end_index = if rule.apply_end_pattern_last {
                        sources.len() - 1
                    } else {
                        0
                    };
                    sources.set_source(end_index, end_regex_source.unwrap_or("\u{ffff}"));
                }
                sources.compile_ag(allow_a, allow_g)
            }
            Self::BeginWhile(rule) => compile_patterns(
                &rule.cached_compiled_patterns,
                registry,
                Some(&rule.patterns),
                allow_a,
                allow_g,
            ),
        }
    }

    #[must_use]
    pub fn as_capture(&self) -> Option<&Arc<CaptureRule>> {
        match self {
            Self::Capture(rule) => Some(rule),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_match(&self) -> Option<&MatchRule> {
        match self {
            Self::Match(rule) => Some(rule),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_include_only(&self) -> Option<&IncludeOnlyRule> {
        match self {
            Self::IncludeOnly(rule) => Some(rule),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_begin_end(&self) -> Option<&BeginEndRule> {
        match self {
            Self::BeginEnd(rule) => Some(rule),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_begin_while(&self) -> Option<&BeginWhileRule> {
        match self {
            Self::BeginWhile(rule) => Some(rule),
            _ => None,
        }
    }

    fn data(&self) -> &RuleData {
        match self {
            Self::Capture(rule) => &rule.data,
            Self::Match(rule) => &rule.data,
            Self::IncludeOnly(rule) => &rule.data,
            Self::BeginEnd(rule) => &rule.data,
            Self::BeginWhile(rule) => &rule.data,
        }
    }
}

#[derive(Default)]
pub struct RuleRegistry {
    rules: Vec<Option<Rule>>,
}

impl RuleRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_rule(&mut self, factory: impl FnOnce(RuleId) -> Rule) -> RuleId {
        let id = self.reserve_rule();
        self.set_rule(id, factory(id));
        id
    }

    pub fn reserve_rule(&mut self) -> RuleId {
        let id = RuleId::new(
            u32::try_from(self.rules.len() + 1)
                .expect("TextMate rule registry exceeded u32 identity space"),
        );
        self.rules.push(None);
        id
    }

    pub fn set_rule(&mut self, id: RuleId, rule: Rule) {
        assert_eq!(
            id,
            rule.id(),
            "registered rule identity must match its slot"
        );
        let slot = self
            .rules
            .get_mut(rule_index(id))
            .expect("registered rule identity must have been reserved");
        assert!(slot.is_none(), "registered rule identity must be vacant");
        *slot = Some(rule);
    }

    #[must_use]
    pub fn get_rule(&self, id: RuleId) -> &Rule {
        self.rules
            .get(rule_index(id))
            .and_then(Option::as_ref)
            .expect("registered rule identity must be initialized")
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.rules.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }
}

fn rule_index(id: RuleId) -> usize {
    usize::try_from(id.get() - 1).expect("u32 must fit usize")
}

fn collect_pattern_ids(
    registry: &RuleRegistry,
    patterns: &[RuleId],
    output: &mut RegExpSourceList<RuleScannerId>,
) {
    for pattern in patterns {
        registry
            .get_rule(*pattern)
            .collect_patterns(registry, output);
    }
}

fn compile_patterns(
    cache: &Mutex<Option<RegExpSourceList<RuleScannerId>>>,
    registry: &RuleRegistry,
    patterns: Option<&[RuleId]>,
    allow_a: bool,
    allow_g: bool,
) -> Result<Arc<CompiledRule<RuleScannerId>>, RegexError> {
    let mut cached = cache.lock().expect("compiled pattern cache lock poisoned");
    let sources = cached.get_or_insert_with(|| {
        let mut sources = RegExpSourceList::new();
        if let Some(patterns) = patterns {
            collect_pattern_ids(registry, patterns, &mut sources);
        }
        sources
    });
    sources.compile_ag(allow_a, allow_g)
}

fn clear_cache(cache: &Mutex<Option<RegExpSourceList<RuleScannerId>>>) {
    *cache.lock().expect("compiled pattern cache lock poisoned") = None;
}

#[cfg(test)]
mod tests {
    use ferroni::scanner::{CaptureIndex, OnigString, ScannerFindOptions};

    use super::{
        BeginEndRule, BeginEndRuleOptions, BeginWhileRule, BeginWhileRuleOptions,
        CompilePatternsResult, IncludeOnlyRule, MatchRule, Rule, RuleRegistry, RuleScannerId,
    };

    fn match_rule(registry: &mut RuleRegistry, pattern: &str) -> crate::RuleId {
        registry
            .register_rule(|id| Rule::Match(MatchRule::new(None, id, None, pattern, Vec::new())))
    }

    #[test]
    fn resolves_capturing_rule_names_and_debug_locations() {
        let mut registry = RuleRegistry::new();
        let id = registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                Some(crate::Location {
                    filename: "/grammars/test.tmLanguage.json".into(),
                    line: 17,
                    character: 3,
                }),
                id,
                Some("entity.$1".into()),
                "x",
                Vec::new(),
            ))
        });
        let whole_match = CaptureIndex {
            start: 0,
            end: 1,
            length: 1,
        };
        let capture = whole_match.clone();
        let rule = registry.get_rule(id);

        assert_eq!(rule.debug_name(), "MatchRule#1 @ test.tmLanguage.json:17");
        assert_eq!(
            rule.get_name(Some("x"), Some(&[whole_match, capture])),
            Some("entity.x".into())
        );
    }

    #[test]
    fn include_only_rules_flatten_registered_patterns() {
        let mut registry = RuleRegistry::new();
        let x = match_rule(&mut registry, "x");
        let y = match_rule(&mut registry, "y");
        let include = registry.register_rule(|id| {
            Rule::IncludeOnly(IncludeOnlyRule::new(
                None,
                id,
                None,
                None,
                CompilePatternsResult {
                    patterns: vec![x, y],
                    has_missing_patterns: false,
                },
            ))
        });

        let compiled = registry.get_rule(include).compile(&registry, None).unwrap();
        let result = compiled
            .find_next_match(&OnigString::new("yx"), 0, ScannerFindOptions::NONE)
            .unwrap();
        assert_eq!(result.rule_id, RuleScannerId::Rule(y));
    }

    #[test]
    fn match_rules_compile_their_own_pattern() {
        let mut registry = RuleRegistry::new();
        let matched = match_rule(&mut registry, "x");
        let compiled = registry.get_rule(matched).compile(&registry, None).unwrap();

        assert_eq!(
            compiled
                .find_next_match(&OnigString::new("x"), 0, ScannerFindOptions::NONE,)
                .unwrap()
                .rule_id,
            RuleScannerId::Rule(matched)
        );
    }

    #[test]
    fn begin_end_rules_resolve_back_references_and_end_priority() {
        let mut registry = RuleRegistry::new();
        let content = match_rule(&mut registry, "x");
        let begin_end = registry.register_rule(|id| {
            Rule::BeginEnd(BeginEndRule::new(BeginEndRuleOptions {
                location: None,
                id,
                name: None,
                content_name: None,
                begin: "(['\"])".into(),
                begin_captures: Vec::new(),
                end: Some(r"\1".into()),
                end_captures: Vec::new(),
                apply_end_pattern_last: false,
                patterns: CompilePatternsResult {
                    patterns: vec![content],
                    has_missing_patterns: false,
                },
            }))
        });

        let rule = registry.get_rule(begin_end);
        let capture = CaptureIndex {
            start: 0,
            end: 1,
            length: 1,
        };
        let end = rule
            .as_begin_end()
            .unwrap()
            .get_end_with_resolved_back_references("\"", &[capture]);
        let compiled = rule.compile(&registry, Some(&end)).unwrap();
        let result = compiled
            .find_next_match(&OnigString::new("\"x"), 0, ScannerFindOptions::NONE)
            .unwrap();

        assert_eq!(result.rule_id, RuleScannerId::End);
    }

    #[test]
    fn begin_while_rules_compile_resolved_while_patterns() {
        let mut registry = RuleRegistry::new();
        let begin_while = registry.register_rule(|id| {
            Rule::BeginWhile(BeginWhileRule::new(BeginWhileRuleOptions {
                location: None,
                id,
                name: None,
                content_name: None,
                begin: r"(\w+)".into(),
                begin_captures: Vec::new(),
                while_pattern: r"\1".into(),
                while_captures: Vec::new(),
                patterns: CompilePatternsResult::default(),
            }))
        });
        let rule = registry.get_rule(begin_while).as_begin_while().unwrap();
        let capture = CaptureIndex {
            start: 0,
            end: 3,
            length: 3,
        };
        let resolved = rule.get_while_with_resolved_back_references("tag", &[capture]);
        let compiled = rule.compile_while(Some(&resolved)).unwrap();

        assert_eq!(
            compiled
                .find_next_match(&OnigString::new("tag"), 0, ScannerFindOptions::NONE,)
                .unwrap()
                .rule_id,
            RuleScannerId::While
        );
    }
}
