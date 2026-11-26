/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use ferroni::backtrack_lint::BacktrackRisk as FerroniBacktrackRisk;

use crate::BacktrackingRisk;
use crate::BacktrackingWarning;
use crate::RegexError;

use crate::raw_grammar::{Location, RuleId};
use crate::regexp::{
    CaptureIndex, CompiledRule, RegExpSource, RegExpSourceList, ScannerPatternCache, has_captures,
    replace_captures,
};

/// The scanner identity for a compiled grammar pattern.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuleScannerId {
    Rule(RuleId),
    End,
    While,
}

#[derive(Clone, Debug)]
struct RuleData {
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    location: Option<Location>,
    source_scope_name: String,
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
            source_scope_name: String::new(),
            id,
            name,
            name_is_capturing,
            content_name,
            content_name_is_capturing,
        }
    }

    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
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

    fn backtracking_rule_name(&self) -> String {
        self.name
            .as_ref()
            .filter(|name| !name.is_empty())
            .cloned()
            .unwrap_or_else(|| format!("rule #{}", self.id.get()))
    }

    fn backtracking_rule_location(&self) -> Option<String> {
        self.location.as_ref().map(|location| {
            format!(
                "{}:{}:{}",
                location.filename, location.line, location.character
            )
        })
    }
}

pub(crate) struct CaptureRule {
    data: RuleData,
    pub retokenize_captured_with_rule_id: Option<RuleId>,
}

impl CaptureRule {
    #[must_use]
    pub(crate) fn new(
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

    #[must_use]
    pub(crate) fn get_name(
        &self,
        line_text: Option<&str>,
        capture_indices: Option<&[CaptureIndex]>,
    ) -> Option<String> {
        self.data.get_name(line_text, capture_indices)
    }

    #[must_use]
    pub(crate) fn get_content_name(
        &self,
        line_text: &str,
        capture_indices: &[CaptureIndex],
    ) -> Option<String> {
        self.data.get_content_name(line_text, capture_indices)
    }
}

/// Sparse capture definitions ordered by capture group index.
pub(crate) type CaptureRules = Vec<(usize, Arc<CaptureRule>)>;

pub(crate) struct MatchRule {
    data: RuleData,
    match_source: RegExpSource<RuleScannerId>,
    pub captures: CaptureRules,
    cached_compiled_patterns: Mutex<Option<RegExpSourceList<RuleScannerId>>>,
}

impl MatchRule {
    #[must_use]
    pub(crate) fn new(
        location: Option<Location>,
        id: RuleId,
        name: Option<String>,
        match_pattern: impl Into<String>,
        captures: CaptureRules,
    ) -> Self {
        Self {
            data: RuleData::new(location, id, name, None),
            match_source: RegExpSource::new(match_pattern, RuleScannerId::Rule(id)),
            captures,
            cached_compiled_patterns: Mutex::new(None),
        }
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn debug_match_reg_exp(&self) -> &str {
        &self.match_source.source
    }
}

pub(crate) struct IncludeOnlyRule {
    data: RuleData,
    pub has_missing_patterns: bool,
    pub patterns: Vec<RuleId>,
    cached_compiled_patterns: Mutex<Option<RegExpSourceList<RuleScannerId>>>,
}

impl IncludeOnlyRule {
    #[must_use]
    pub(crate) fn new(
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

pub(crate) struct BeginEndRule {
    data: RuleData,
    begin: RegExpSource<RuleScannerId>,
    pub begin_captures: CaptureRules,
    end: RegExpSource<RuleScannerId>,
    pub end_has_back_references: bool,
    pub end_captures: CaptureRules,
    pub apply_end_pattern_last: bool,
    pub has_missing_patterns: bool,
    pub patterns: Vec<RuleId>,
    cached_compiled_patterns: Mutex<Option<RegExpSourceList<RuleScannerId>>>,
}

pub(crate) struct BeginEndRuleOptions {
    pub location: Option<Location>,
    pub id: RuleId,
    pub name: Option<String>,
    pub content_name: Option<String>,
    pub begin: String,
    pub begin_captures: CaptureRules,
    pub end: Option<String>,
    pub end_captures: CaptureRules,
    pub apply_end_pattern_last: bool,
    pub patterns: CompilePatternsResult,
}

impl BeginEndRule {
    #[must_use]
    pub(crate) fn new(options: BeginEndRuleOptions) -> Self {
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
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn debug_begin_reg_exp(&self) -> &str {
        &self.begin.source
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn debug_end_reg_exp(&self) -> &str {
        &self.end.source
    }

    #[must_use]
    pub(crate) fn get_end_with_resolved_back_references(
        &self,
        line_text: &str,
        capture_indices: &[CaptureIndex],
    ) -> String {
        self.end.resolve_back_references(line_text, capture_indices)
    }

    pub(crate) fn has_valid_resolved_end_pattern(&self, pattern: &str, work: &mut usize) -> bool {
        self.end.is_valid_back_reference_expansion(pattern, work)
    }
}

pub(crate) struct BeginWhileRule {
    data: RuleData,
    begin: RegExpSource<RuleScannerId>,
    pub begin_captures: CaptureRules,
    pub while_captures: CaptureRules,
    while_source: RegExpSource<RuleScannerId>,
    pub while_has_back_references: bool,
    pub has_missing_patterns: bool,
    pub patterns: Vec<RuleId>,
    cached_compiled_patterns: Mutex<Option<RegExpSourceList<RuleScannerId>>>,
    cached_compiled_while_patterns: Mutex<Option<RegExpSourceList<RuleScannerId>>>,
}

pub(crate) struct BeginWhileRuleOptions {
    pub location: Option<Location>,
    pub id: RuleId,
    pub name: Option<String>,
    pub content_name: Option<String>,
    pub begin: String,
    pub begin_captures: CaptureRules,
    pub while_pattern: String,
    pub while_captures: CaptureRules,
    pub patterns: CompilePatternsResult,
}

impl BeginWhileRule {
    #[must_use]
    pub(crate) fn new(options: BeginWhileRuleOptions) -> Self {
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
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn debug_begin_reg_exp(&self) -> &str {
        &self.begin.source
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn debug_while_reg_exp(&self) -> &str {
        &self.while_source.source
    }

    #[must_use]
    pub(crate) fn get_while_with_resolved_back_references(
        &self,
        line_text: &str,
        capture_indices: &[CaptureIndex],
    ) -> String {
        self.while_source
            .resolve_back_references(line_text, capture_indices)
    }

    pub(crate) fn has_valid_resolved_while_pattern(&self, pattern: &str, work: &mut usize) -> bool {
        self.while_source
            .is_valid_back_reference_expansion(pattern, work)
    }

    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn compile_while(
        &self,
        registry: &RuleRegistry,
        end_regex_source: Option<&str>,
    ) -> Result<Arc<CompiledRule<RuleScannerId>>, RegexError> {
        self.compile_while_ag(registry, end_regex_source, true, true)
    }

    pub(crate) fn compile_while_ag(
        &self,
        registry: &RuleRegistry,
        end_regex_source: Option<&str>,
        allow_a: bool,
        allow_g: bool,
    ) -> Result<Arc<CompiledRule<RuleScannerId>>, RegexError> {
        let mut cached = self
            .cached_compiled_while_patterns
            .lock()
            .expect("compiled while-pattern cache lock poisoned");
        let sources = cached.get_or_insert_with(|| {
            let mut sources = RegExpSourceList::with_pattern_cache(
                registry.regex_prefilter,
                registry
                    .scanner_pattern_cache
                    .for_owner(&self.data.source_scope_name),
            );
            sources.push(self.while_source.clone());
            sources
        });
        if self.while_has_back_references {
            sources.set_source(0, end_regex_source.unwrap_or("\u{ffff}"));
        }
        sources.compile_ag(allow_a, allow_g)
    }

    pub(crate) fn compile_while_ag_and_record(
        &self,
        registry: &RuleRegistry,
        end_regex_source: Option<&str>,
        allow_a: bool,
        allow_g: bool,
    ) -> Result<Arc<CompiledRule<RuleScannerId>>, RegexError> {
        let compiled = self.compile_while_ag(registry, end_regex_source, allow_a, allow_g)?;
        registry.record_backtracking_warnings(self.data.id, &compiled);
        Ok(compiled)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct CompilePatternsResult {
    pub patterns: Vec<RuleId>,
    pub has_missing_patterns: bool,
}

pub(crate) enum Rule {
    Capture(Arc<CaptureRule>),
    Match(MatchRule),
    IncludeOnly(IncludeOnlyRule),
    BeginEnd(BeginEndRule),
    BeginWhile(BeginWhileRule),
}

impl Rule {
    pub(crate) fn prepare_static_scanners(
        &self,
        registry: &RuleRegistry,
    ) -> Result<(), RegexError> {
        // Reuse runtime list construction: order, duplicate patterns, end placement,
        // includes, and all anchor variants must have the same cache keys.
        for allow_a in [false, true] {
            for allow_g in [false, true] {
                if !matches!(
                    self,
                    Self::Capture(_)
                        | Self::BeginEnd(BeginEndRule {
                            end_has_back_references: true,
                            ..
                        })
                ) {
                    self.compile_ag(registry, None, allow_a, allow_g)?;
                }
                if let Self::BeginWhile(rule) = self
                    && !rule.while_has_back_references
                {
                    rule.compile_while_ag(registry, None, allow_a, allow_g)?;
                }
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn prefilter_stats(&self) -> Vec<ferroni::scanner::PrefilterStats> {
        let stats = |cache: &Mutex<Option<RegExpSourceList<RuleScannerId>>>| {
            cache
                .lock()
                .expect("compiled pattern cache lock poisoned")
                .as_ref()
                .map_or_else(Vec::new, RegExpSourceList::prefilter_stats)
        };
        match self {
            Self::Capture(_) => Vec::new(),
            Self::Match(rule) => stats(&rule.cached_compiled_patterns),
            Self::IncludeOnly(rule) => stats(&rule.cached_compiled_patterns),
            Self::BeginEnd(rule) => stats(&rule.cached_compiled_patterns),
            Self::BeginWhile(rule) => {
                let mut result = stats(&rule.cached_compiled_patterns);
                result.extend(stats(&rule.cached_compiled_while_patterns));
                result
            }
        }
    }

    #[must_use]
    pub(crate) fn id(&self) -> RuleId {
        self.data().id
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn location(&self) -> Option<&Location> {
        self.data().location.as_ref()
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn debug_name(&self) -> String {
        self.data().debug_name(match self {
            Self::Capture(_) => "CaptureRule",
            Self::Match(_) => "MatchRule",
            Self::IncludeOnly(_) => "IncludeOnlyRule",
            Self::BeginEnd(_) => "BeginEndRule",
            Self::BeginWhile(_) => "BeginWhileRule",
        })
    }

    #[must_use]
    pub(crate) fn get_name(
        &self,
        line_text: Option<&str>,
        capture_indices: Option<&[CaptureIndex]>,
    ) -> Option<String> {
        self.data().get_name(line_text, capture_indices)
    }

    #[must_use]
    pub(crate) fn get_content_name(
        &self,
        line_text: &str,
        capture_indices: &[CaptureIndex],
    ) -> Option<String> {
        self.data().get_content_name(line_text, capture_indices)
    }

    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn dispose(&self) {
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

    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn collect_patterns(
        &self,
        registry: &RuleRegistry,
        output: &mut RegExpSourceList<RuleScannerId>,
        active_path: &mut HashSet<RuleId>,
    ) -> Result<(), RegexError> {
        match self {
            Self::Capture(_) => panic!("capture rules cannot collect scanner patterns"),
            Self::Match(rule) => {
                output.push(rule.match_source.clone());
                Ok(())
            }
            Self::IncludeOnly(rule) => {
                if active_path.insert(rule.data.id) {
                    let result = collect_pattern_ids(registry, &rule.patterns, output, active_path);
                    active_path.remove(&rule.data.id);
                    result
                } else {
                    Ok(())
                }
            }
            Self::BeginEnd(rule) => {
                output.push(rule.begin.clone());
                Ok(())
            }
            Self::BeginWhile(rule) => {
                output.push(rule.begin.clone());
                Ok(())
            }
        }
    }

    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn compile(
        &self,
        registry: &RuleRegistry,
        end_regex_source: Option<&str>,
    ) -> Result<Arc<CompiledRule<RuleScannerId>>, RegexError> {
        self.compile_ag(registry, end_regex_source, true, true)
    }

    pub(crate) fn compile_ag(
        &self,
        registry: &RuleRegistry,
        end_regex_source: Option<&str>,
        allow_a: bool,
        allow_g: bool,
    ) -> Result<Arc<CompiledRule<RuleScannerId>>, RegexError> {
        let compiled = match self {
            Self::Capture(_) => panic!("capture rules cannot compile scanner patterns"),
            Self::Match(rule) => {
                let mut cached = rule
                    .cached_compiled_patterns
                    .lock()
                    .expect("compiled pattern cache lock poisoned");
                let sources = cached.get_or_insert_with(|| {
                    let mut sources = RegExpSourceList::with_pattern_cache(
                        registry.regex_prefilter,
                        registry
                            .scanner_pattern_cache
                            .for_owner(&rule.data.source_scope_name),
                    );
                    sources.push(rule.match_source.clone());
                    sources
                });
                sources.compile_ag(allow_a, allow_g)
            }
            Self::IncludeOnly(rule) => compile_patterns(
                &rule.cached_compiled_patterns,
                registry,
                Some(rule.data.id),
                Some(&rule.patterns),
                &rule.data.source_scope_name,
                allow_a,
                allow_g,
            ),
            Self::BeginEnd(rule) => {
                let mut cached = rule
                    .cached_compiled_patterns
                    .lock()
                    .expect("compiled pattern cache lock poisoned");
                if cached.is_none() {
                    let mut sources = RegExpSourceList::with_pattern_cache(
                        registry.regex_prefilter,
                        registry
                            .scanner_pattern_cache
                            .for_owner(&rule.data.source_scope_name),
                    );
                    let mut active_path = HashSet::new();
                    collect_pattern_ids(registry, &rule.patterns, &mut sources, &mut active_path)?;
                    if rule.apply_end_pattern_last {
                        sources.push(rule.end.clone());
                    } else {
                        sources.unshift(rule.end.clone());
                    }
                    *cached = Some(sources);
                }
                let sources = cached.as_mut().expect("cached sources must be populated");
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
                None,
                Some(&rule.patterns),
                &rule.data.source_scope_name,
                allow_a,
                allow_g,
            ),
        };
        if let Ok(compiled) = &compiled {
            registry.record_backtracking_warnings(self.id(), compiled);
        }
        compiled
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn as_capture(&self) -> Option<&Arc<CaptureRule>> {
        match self {
            Self::Capture(rule) => Some(rule),
            _ => None,
        }
    }

    #[must_use]
    pub(crate) fn as_match(&self) -> Option<&MatchRule> {
        match self {
            Self::Match(rule) => Some(rule),
            _ => None,
        }
    }

    #[must_use]
    pub(crate) fn as_include_only(&self) -> Option<&IncludeOnlyRule> {
        match self {
            Self::IncludeOnly(rule) => Some(rule),
            _ => None,
        }
    }

    #[must_use]
    pub(crate) fn as_begin_end(&self) -> Option<&BeginEndRule> {
        match self {
            Self::BeginEnd(rule) => Some(rule),
            _ => None,
        }
    }

    #[must_use]
    pub(crate) fn as_begin_while(&self) -> Option<&BeginWhileRule> {
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

    pub(crate) fn set_source_scope_name(&mut self, scope_name: String) {
        match self {
            Self::Capture(_) => {}
            Self::Match(rule) => rule.data.source_scope_name = scope_name,
            Self::IncludeOnly(rule) => rule.data.source_scope_name = scope_name,
            Self::BeginEnd(rule) => rule.data.source_scope_name = scope_name,
            Self::BeginWhile(rule) => rule.data.source_scope_name = scope_name,
        }
    }

    pub(crate) fn source_scope_name(&self) -> &str {
        &self.data().source_scope_name
    }
}

pub(crate) struct RuleRegistry {
    rules: Vec<Option<Rule>>,
    backtracking_warnings: Mutex<BTreeMap<BacktrackingWarningKey, BacktrackingWarning>>,
    pub(crate) regex_prefilter: bool,
    pub(crate) scanner_pattern_cache: ScannerPatternCache,
}

impl Default for RuleRegistry {
    fn default() -> Self {
        Self {
            rules: Vec::new(),
            backtracking_warnings: Mutex::default(),
            regex_prefilter: true,
            scanner_pattern_cache: ScannerPatternCache::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct BacktrackingWarningKey {
    rule_id: RuleId,
    pattern: String,
    risk: BacktrackingRisk,
    message: String,
}

impl RuleRegistry {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn with_pattern_cache(scanner_pattern_cache: ScannerPatternCache) -> Self {
        Self {
            scanner_pattern_cache,
            ..Self::default()
        }
    }

    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn register_rule(&mut self, factory: impl FnOnce(RuleId) -> Rule) -> RuleId {
        let id = self.reserve_rule();
        self.set_rule(id, factory(id));
        id
    }

    pub(crate) fn reserve_rule(&mut self) -> RuleId {
        let id = RuleId::new(
            u32::try_from(self.rules.len() + 1)
                .expect("TextMate rule registry exceeded u32 identity space"),
        );
        self.rules.push(None);
        id
    }

    pub(crate) fn set_rule(&mut self, id: RuleId, rule: Rule) {
        assert_eq!(
            id,
            rule.id(),
            "registered rule identity must match its slot"
        );
        let slot = rule_index(id)
            .and_then(|index| self.rules.get_mut(index))
            .expect("registered rule identity must have been reserved");
        assert!(slot.is_none(), "registered rule identity must be vacant");
        *slot = Some(rule);
    }

    pub(crate) fn rules(&self) -> impl Iterator<Item = &Rule> {
        self.rules.iter().flatten()
    }

    #[must_use]
    pub(crate) fn get_rule(&self, id: RuleId) -> &Rule {
        self.try_get_rule(id)
            .expect("registered rule identity must be initialized")
    }

    #[must_use]
    pub(crate) fn try_get_rule(&self, id: RuleId) -> Option<&Rule> {
        self.rules.get(rule_index(id)?).and_then(Option::as_ref)
    }

    pub(crate) fn backtracking_warnings(&self) -> Vec<BacktrackingWarning> {
        self.backtracking_warnings
            .lock()
            .expect("backtracking warning lock poisoned")
            .values()
            .cloned()
            .collect()
    }

    fn record_backtracking_warnings(
        &self,
        owner_rule_id: RuleId,
        compiled: &CompiledRule<RuleScannerId>,
    ) {
        let mut findings = Vec::new();
        compiled.record_backtracking_warnings_once(|scanner_rule_id, pattern, ferroni_warning| {
            let source_rule_id = match scanner_rule_id {
                RuleScannerId::Rule(rule_id) => rule_id,
                RuleScannerId::End | RuleScannerId::While => owner_rule_id,
            };
            let data = self.get_rule(source_rule_id).data();
            let risk = match ferroni_warning.risk {
                FerroniBacktrackRisk::NestedQuantifier => BacktrackingRisk::NestedQuantifier,
                FerroniBacktrackRisk::OverlappingAlternation => {
                    BacktrackingRisk::OverlappingAlternation
                }
            };
            let warning = BacktrackingWarning::new(
                data.source_scope_name.clone(),
                data.backtracking_rule_name(),
                data.backtracking_rule_location(),
                pattern.to_owned(),
                risk,
                ferroni_warning.message.clone(),
            );
            let key = BacktrackingWarningKey {
                rule_id: source_rule_id,
                pattern: warning.pattern.clone(),
                risk: warning.risk,
                message: warning.message.clone(),
            };
            findings.push((key, warning));
        });
        if findings.is_empty() {
            return;
        }
        let mut recorded = self
            .backtracking_warnings
            .lock()
            .expect("backtracking warning lock poisoned");
        for (key, warning) in findings {
            recorded.entry(key).or_insert(warning);
        }
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn len(&self) -> usize {
        self.rules.len()
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "part of the vscode-textmate port, kept for upstream parity"
    )]
    pub(crate) fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }
}

fn rule_index(id: RuleId) -> Option<usize> {
    id.get()
        .checked_sub(1)
        .and_then(|index| usize::try_from(index).ok())
}

/// Maximum number of rule visits allowed while expanding `IncludeOnly` patterns
/// for a single scanner. Prevents exponential blowup on adversarial branching
/// include graphs while preserving repeated sibling includes in normal grammars.
const MAX_SCANNER_INCLUDE_VISITS: usize = 65_536;
/// Maximum cumulative expanded regex pattern bytes allowed for a single scanner
/// before cloning `RegExpSource`s. Prevents memory exhaustion from branching
/// includes sharing long patterns.
const MAX_SCANNER_PATTERN_BYTES: usize = 16 * 1024 * 1024;

fn collect_pattern_ids(
    registry: &RuleRegistry,
    patterns: &[RuleId],
    output: &mut RegExpSourceList<RuleScannerId>,
    active_path: &mut HashSet<RuleId>,
) -> Result<(), RegexError> {
    let mut visits = 0usize;
    let mut total_pattern_bytes = 0usize;
    let mut leaf_ids = Vec::new();
    let mut frames: Vec<(Option<RuleId>, std::slice::Iter<'_, RuleId>)> =
        vec![(None, patterns.iter())];
    while let Some((owner_id, iter)) = frames.last_mut() {
        let Some(&pattern_id) = iter.next() else {
            let exiting = *owner_id;
            frames.pop();
            if let Some(id) = exiting {
                active_path.remove(&id);
            }
            continue;
        };
        visits += 1;
        if visits > MAX_SCANNER_INCLUDE_VISITS {
            return Err(RegexError::depth_limit(
                "rule pattern expansion limit exceeded",
            ));
        }
        match registry.get_rule(pattern_id) {
            Rule::Capture(_) => panic!("capture rules cannot collect scanner patterns"),
            Rule::Match(rule) => {
                total_pattern_bytes =
                    total_pattern_bytes.saturating_add(rule.match_source.source.len());
                if total_pattern_bytes > MAX_SCANNER_PATTERN_BYTES {
                    return Err(RegexError::depth_limit(
                        "rule pattern expansion size limit exceeded",
                    ));
                }
                leaf_ids.push(pattern_id);
            }
            Rule::IncludeOnly(rule) => {
                if active_path.insert(rule.data.id) {
                    frames.push((Some(rule.data.id), rule.patterns.iter()));
                }
            }
            Rule::BeginEnd(rule) => {
                total_pattern_bytes = total_pattern_bytes.saturating_add(rule.begin.source.len());
                if total_pattern_bytes > MAX_SCANNER_PATTERN_BYTES {
                    return Err(RegexError::depth_limit(
                        "rule pattern expansion size limit exceeded",
                    ));
                }
                leaf_ids.push(pattern_id);
            }
            Rule::BeginWhile(rule) => {
                total_pattern_bytes = total_pattern_bytes.saturating_add(rule.begin.source.len());
                if total_pattern_bytes > MAX_SCANNER_PATTERN_BYTES {
                    return Err(RegexError::depth_limit(
                        "rule pattern expansion size limit exceeded",
                    ));
                }
                leaf_ids.push(pattern_id);
            }
        }
    }

    for pattern_id in leaf_ids {
        match registry.get_rule(pattern_id) {
            Rule::Match(rule) => output.push(rule.match_source.clone()),
            Rule::BeginEnd(rule) => output.push(rule.begin.clone()),
            Rule::BeginWhile(rule) => output.push(rule.begin.clone()),
            Rule::Capture(_) | Rule::IncludeOnly(_) => {
                unreachable!("only leaf pattern rules are queued for materialization")
            }
        }
    }
    Ok(())
}

fn compile_patterns(
    cache: &Mutex<Option<RegExpSourceList<RuleScannerId>>>,
    registry: &RuleRegistry,
    owner_include_only: Option<RuleId>,
    patterns: Option<&[RuleId]>,
    owner_scope: &str,
    allow_a: bool,
    allow_g: bool,
) -> Result<Arc<CompiledRule<RuleScannerId>>, RegexError> {
    let mut cached = cache.lock().expect("compiled pattern cache lock poisoned");
    if cached.is_none() {
        let mut sources = RegExpSourceList::with_pattern_cache(
            registry.regex_prefilter,
            registry.scanner_pattern_cache.for_owner(owner_scope),
        );
        if let Some(patterns) = patterns {
            let mut active_path = HashSet::new();
            if let Some(owner_id) = owner_include_only {
                active_path.insert(owner_id);
            }
            collect_pattern_ids(registry, patterns, &mut sources, &mut active_path)?;
        }
        *cached = Some(sources);
    }
    let sources = cached.as_mut().expect("cached sources must be populated");
    sources.compile_ag(allow_a, allow_g)
}

#[allow(
    dead_code,
    reason = "part of the vscode-textmate port, kept for upstream parity"
)]
fn clear_cache(cache: &Mutex<Option<RegExpSourceList<RuleScannerId>>>) {
    *cache.lock().expect("compiled pattern cache lock poisoned") = None;
}

#[cfg(test)]
mod tests {
    use crate::regexp::CaptureIndex;
    use ferroni::scanner::{OnigString, ScannerFindOptions};

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
        let compiled = rule.compile_while(&registry, Some(&resolved)).unwrap();

        assert_eq!(
            compiled
                .find_next_match(&OnigString::new("tag"), 0, ScannerFindOptions::NONE,)
                .unwrap()
                .rule_id,
            RuleScannerId::While
        );
    }

    #[test]
    fn try_get_rule_returns_none_for_zero_rule_id() {
        let mut registry = RuleRegistry::new();
        let _ = match_rule(&mut registry, "x");
        assert!(registry.try_get_rule(crate::RuleId::new(0)).is_none());
    }

    #[test]
    fn cyclic_include_only_patterns_terminate_without_stack_overflow() {
        let mut registry = RuleRegistry::new();
        let matched = match_rule(&mut registry, "hit");
        let a = registry.reserve_rule();
        let b = registry.reserve_rule();
        registry.set_rule(
            a,
            Rule::IncludeOnly(IncludeOnlyRule::new(
                None,
                a,
                None,
                None,
                CompilePatternsResult {
                    patterns: vec![b, a],
                    has_missing_patterns: false,
                },
            )),
        );
        registry.set_rule(
            b,
            Rule::IncludeOnly(IncludeOnlyRule::new(
                None,
                b,
                None,
                None,
                CompilePatternsResult {
                    patterns: vec![a, matched],
                    has_missing_patterns: false,
                },
            )),
        );

        let compiled = registry.get_rule(a).compile(&registry, None).unwrap();
        let result = compiled
            .find_next_match(&OnigString::new("hit"), 0, ScannerFindOptions::NONE)
            .unwrap();
        assert_eq!(result.rule_id, RuleScannerId::Rule(matched));
    }

    #[test]
    fn repeated_sibling_includes_preserve_pattern_order() {
        let mut registry = RuleRegistry::new();
        let shared_match = match_rule(&mut registry, "shared");
        let between_match = match_rule(&mut registry, "between");
        let shared = registry.reserve_rule();
        let branch = registry.reserve_rule();
        let root = registry.reserve_rule();

        registry.set_rule(
            shared,
            Rule::IncludeOnly(IncludeOnlyRule::new(
                None,
                shared,
                None,
                None,
                CompilePatternsResult {
                    patterns: vec![shared_match],
                    has_missing_patterns: false,
                },
            )),
        );
        registry.set_rule(
            branch,
            Rule::IncludeOnly(IncludeOnlyRule::new(
                None,
                branch,
                None,
                None,
                CompilePatternsResult {
                    patterns: vec![between_match, shared],
                    has_missing_patterns: false,
                },
            )),
        );
        registry.set_rule(
            root,
            Rule::IncludeOnly(IncludeOnlyRule::new(
                None,
                root,
                None,
                None,
                CompilePatternsResult {
                    patterns: vec![shared, branch],
                    has_missing_patterns: false,
                },
            )),
        );

        let compiled = registry.get_rule(root).compile(&registry, None).unwrap();
        assert_eq!(
            compiled.debug_reg_exps(),
            vec!["shared", "between", "shared"]
        );
        assert_eq!(
            compiled.debug_rules(),
            &[
                RuleScannerId::Rule(shared_match),
                RuleScannerId::Rule(between_match),
                RuleScannerId::Rule(shared_match),
            ]
        );
    }

    #[test]
    fn exponential_include_dag_fails_with_expansion_limit_error() {
        let mut registry = RuleRegistry::new();
        let leaf = match_rule(&mut registry, "x");
        let mut current = leaf;
        for _ in 0..24 {
            let node = registry.reserve_rule();
            registry.set_rule(
                node,
                Rule::IncludeOnly(IncludeOnlyRule::new(
                    None,
                    node,
                    None,
                    None,
                    CompilePatternsResult {
                        patterns: vec![current, current],
                        has_missing_patterns: false,
                    },
                )),
            );
            current = node;
        }

        let err = registry
            .get_rule(current)
            .compile(&registry, None)
            .err()
            .expect("exponential include graph must return a recoverable error");
        assert!(err.to_string().contains("expansion limit"));
    }

    #[test]
    fn large_repeated_pattern_expansion_fails_before_cloning_sources() {
        let mut registry = RuleRegistry::new();
        let big_pattern = "a".repeat(32 * 1024);
        let leaf = match_rule(&mut registry, &big_pattern);
        let mut current = leaf;
        // 10 levels -> 1,024 leaf copies * 32 KiB = 32 MiB (> 16 MiB cap),
        // well below the 65,536 visit cap.
        for _ in 0..10 {
            let node = registry.reserve_rule();
            registry.set_rule(
                node,
                Rule::IncludeOnly(IncludeOnlyRule::new(
                    None,
                    node,
                    None,
                    None,
                    CompilePatternsResult {
                        patterns: vec![current, current],
                        has_missing_patterns: false,
                    },
                )),
            );
            current = node;
        }

        let err = registry
            .get_rule(current)
            .compile(&registry, None)
            .err()
            .expect("oversized repeated pattern expansion must fail before cloning");
        assert!(err.to_string().contains("size limit"));
    }
}
