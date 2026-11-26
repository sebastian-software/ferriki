/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use crate::grammar_fingerprint::GrammarFingerprint;
use crate::include_reference::{IncludeReference, parse_include};
use crate::raw_grammar::{RawCaptures, RawGrammar, RawRule, RuleId};
use crate::regexp::ScannerPatternCache;
use crate::rule::{
    BeginEndRule, BeginEndRuleOptions, BeginWhileRule, BeginWhileRuleOptions, CaptureRule,
    CompilePatternsResult, IncludeOnlyRule, MatchRule, Rule, RuleRegistry,
};

/// Supplies raw grammars referenced by top-level `include` expressions.
pub trait GrammarProvider {
    fn lookup(&self, scope_name: &str) -> Option<Arc<RawGrammar>>;

    fn injections(&self, _scope_name: &str) -> Vec<String> {
        Vec::new()
    }
}

/// An in-memory grammar provider suitable for registries and tests.
#[derive(Default)]
pub struct GrammarStore {
    grammars: BTreeMap<String, Arc<RawGrammar>>,
    injections: BTreeMap<String, Vec<String>>,
}

impl GrammarStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, grammar: RawGrammar) -> Option<Arc<RawGrammar>> {
        self.grammars
            .insert(grammar.scope_name.clone(), Arc::new(grammar))
    }

    pub fn insert_shared(&mut self, grammar: Arc<RawGrammar>) -> Option<Arc<RawGrammar>> {
        self.grammars.insert(grammar.scope_name.clone(), grammar)
    }

    pub fn set_injections(
        &mut self,
        scope_name: impl Into<String>,
        injections: Vec<String>,
    ) -> Option<Vec<String>> {
        self.injections.insert(scope_name.into(), injections)
    }

    pub fn clear(&mut self) {
        self.grammars.clear();
        self.injections.clear();
    }
}

impl GrammarProvider for GrammarStore {
    fn lookup(&self, scope_name: &str) -> Option<Arc<RawGrammar>> {
        self.grammars.get(scope_name).cloned()
    }

    fn injections(&self, scope_name: &str) -> Vec<String> {
        self.injections.get(scope_name).cloned().unwrap_or_default()
    }
}

/// Add the synthetic `$self` and `$base` rules used by vscode-textmate.
#[must_use]
pub(crate) fn initialize_grammar(grammar: &RawGrammar, base: Option<Arc<RawRule>>) -> RawGrammar {
    let mut grammar = grammar.clone();
    let self_rule = Arc::new(RawRule {
        name: Some(grammar.scope_name.clone()),
        patterns: Some(grammar.patterns.clone()),
        location: grammar.location.clone(),
        ..RawRule::default()
    });
    grammar
        .repository
        .insert("$self".into(), Arc::clone(&self_rule));
    grammar
        .repository
        .insert("$base".into(), base.unwrap_or(self_rule));
    grammar
}

/// The repository chain visible to a rule: its grammar's repository plus the
/// local `repository` objects of enclosing rules, innermost last.
///
/// vscode-textmate passes the repository object by reference and only builds
/// a merged copy where a rule declares a local repository. This shares the
/// grammar and each overlay rule instead, so cloning a context costs two
/// reference-count increments rather than a copy of every repository map.
#[derive(Clone)]
struct RepositoryContext {
    grammar: Arc<RawGrammar>,
    overlay: Option<Arc<RepositoryOverlay>>,
}

struct RepositoryOverlay {
    rule: Arc<RawRule>,
    parent: Option<Arc<RepositoryOverlay>>,
}

impl Drop for RepositoryOverlay {
    fn drop(&mut self) {
        let mut parent = self.parent.take();
        while let Some(node) = parent {
            parent = Arc::try_unwrap(node)
                .ok()
                .and_then(|mut owned| owned.parent.take());
        }
    }
}

impl RepositoryContext {
    fn new(grammar: &Arc<RawGrammar>) -> Self {
        Self {
            grammar: Arc::clone(grammar),
            overlay: None,
        }
    }

    /// Layers `rule.repository` over this context; `rule` must have one.
    fn with_overlay(&self, rule: &Arc<RawRule>) -> Self {
        debug_assert!(rule.repository.is_some());
        Self {
            grammar: Arc::clone(&self.grammar),
            overlay: Some(Arc::new(RepositoryOverlay {
                rule: Arc::clone(rule),
                parent: self.overlay.clone(),
            })),
        }
    }

    fn scope_name(&self) -> &str {
        &self.grammar.scope_name
    }

    fn get(&self, name: &str) -> Option<Arc<RawRule>> {
        let mut overlay = self.overlay.as_deref();
        while let Some(layer) = overlay {
            if let Some(rule) = layer
                .rule
                .repository
                .as_ref()
                .and_then(|repository| repository.get(name))
            {
                return Some(Arc::clone(rule));
            }
            overlay = layer.parent.as_deref();
        }
        self.grammar.repository.get(name).cloned()
    }
}

/// Mechanical compiler for vscode-textmate raw rules.
pub(crate) struct RuleFactory<'a> {
    grammar_provider: &'a dyn GrammarProvider,
    root_grammar: Arc<RawGrammar>,
    included_grammars: BTreeMap<String, Arc<RawGrammar>>,
    compiled_rule_ids: HashMap<usize, RuleId>,
    registry: RuleRegistry,
    // Ferriki: the raw sources behind `root_grammar` and `included_grammars`,
    // kept for `grammar_fingerprint`.
    raw_root_grammar: Arc<RawGrammar>,
    included_raw_grammars: BTreeMap<String, Arc<RawGrammar>>,
}

impl<'a> RuleFactory<'a> {
    #[must_use]
    pub(crate) fn new(grammar: &RawGrammar, grammar_provider: &'a dyn GrammarProvider) -> Self {
        Self::with_registry(
            Arc::new(grammar.clone()),
            grammar_provider,
            RuleRegistry::new(),
        )
    }

    pub(crate) fn with_pattern_cache(
        grammar: Arc<RawGrammar>,
        grammar_provider: &'a dyn GrammarProvider,
        scanner_pattern_cache: ScannerPatternCache,
    ) -> Self {
        Self::with_registry(
            grammar,
            grammar_provider,
            RuleRegistry::with_pattern_cache(scanner_pattern_cache),
        )
    }

    fn with_registry(
        grammar: Arc<RawGrammar>,
        grammar_provider: &'a dyn GrammarProvider,
        registry: RuleRegistry,
    ) -> Self {
        Self {
            grammar_provider,
            root_grammar: Arc::new(initialize_grammar(&grammar, None)),
            included_grammars: BTreeMap::new(),
            compiled_rule_ids: HashMap::new(),
            registry,
            raw_root_grammar: grammar,
            included_raw_grammars: BTreeMap::new(),
        }
    }

    pub(crate) fn compile_root(&mut self) -> RuleId {
        let repository = RepositoryContext::new(&self.root_grammar);
        let root = repository
            .get("$self")
            .expect("initialized grammar must define $self");
        self.get_compiled_rule_id(root, repository)
    }

    /// Compiles `rule` against the root grammar's repository.
    pub(crate) fn compile_raw_rule(&mut self, rule: Arc<RawRule>) -> RuleId {
        let repository = RepositoryContext::new(&self.root_grammar);
        self.get_compiled_rule_id(rule, repository)
    }

    pub(crate) fn compile_external_grammar(
        &mut self,
        scope_name: &str,
    ) -> Option<(Arc<RawGrammar>, RuleId)> {
        let root_repository = RepositoryContext::new(&self.root_grammar);
        let grammar = self.get_external_grammar(scope_name, &root_repository)?;
        let repository = RepositoryContext::new(&grammar);
        let rule = repository.get("$self")?;
        let rule_id = self.get_compiled_rule_id(rule, repository);
        Some((grammar, rule_id))
    }

    #[must_use]
    pub(crate) fn root_grammar(&self) -> &Arc<RawGrammar> {
        &self.root_grammar
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "ported from vscode-textmate; no caller outside the port"
    )]
    pub(crate) fn registry(&self) -> &RuleRegistry {
        &self.registry
    }

    pub(crate) fn into_parts(self) -> (Arc<RawGrammar>, RuleRegistry) {
        (self.root_grammar, self.registry)
    }

    pub(crate) fn grammar_fingerprint(
        &self,
        external_injection_scopes: Vec<String>,
    ) -> GrammarFingerprint {
        GrammarFingerprint::new(
            Arc::clone(&self.raw_root_grammar),
            self.included_raw_grammars.clone(),
            external_injection_scopes,
        )
    }

    fn get_compiled_rule_id(
        &mut self,
        description: Arc<RawRule>,
        repository: RepositoryContext,
    ) -> RuleId {
        let root_identity = Arc::as_ptr(&description) as usize;
        if let Some(&id) = self.compiled_rule_ids.get(&root_identity) {
            return id;
        }

        let root_id = self.registry.reserve_rule();
        self.compiled_rule_ids.insert(root_identity, root_id);

        let mut frames = Vec::new();
        Self::push_rule_frame(root_id, description, repository, &mut frames);

        while let Some(frame) = frames.last_mut() {
            if let Some(pending) = frame.pending.take() {
                match pending {
                    PendingChild::Capture {
                        slot,
                        capture_id,
                        capture,
                        retokenize_rule_id,
                    } => {
                        let rule = self.create_capture_rule(
                            capture.location.clone(),
                            capture.name.clone(),
                            capture.content_name.clone(),
                            Some(retokenize_rule_id),
                        );
                        frame.insert_capture(slot, capture_id, rule);
                    }
                    PendingChild::Pattern { rule_id } => {
                        if !self
                            .registry
                            .try_get_rule(rule_id)
                            .is_some_and(rule_has_only_missing_patterns)
                        {
                            frame.push_pattern(rule_id);
                        }
                    }
                }
                continue;
            }

            let Some(step) = frame.next_step() else {
                let frame = frames.pop().expect("active rule frame must exist");
                let id = frame.id;
                let rule = frame.into_rule();
                self.registry.set_rule(id, rule);
                continue;
            };

            match step {
                ChildStep::Capture {
                    slot,
                    capture_id,
                    capture,
                } => {
                    if capture.patterns.is_some() {
                        let identity = Arc::as_ptr(&capture) as usize;
                        if let Some(&existing_id) = self.compiled_rule_ids.get(&identity) {
                            let rule = self.create_capture_rule(
                                capture.location.clone(),
                                capture.name.clone(),
                                capture.content_name.clone(),
                                Some(existing_id),
                            );
                            frame.insert_capture(slot, capture_id, rule);
                        } else {
                            let retok_id = self.registry.reserve_rule();
                            self.compiled_rule_ids.insert(identity, retok_id);
                            let child_repository = frame.repository.clone();
                            frame.pending = Some(PendingChild::Capture {
                                slot,
                                capture_id,
                                capture: Arc::clone(&capture),
                                retokenize_rule_id: retok_id,
                            });
                            Self::push_rule_frame(retok_id, capture, child_repository, &mut frames);
                        }
                    } else {
                        let rule = self.create_capture_rule(
                            capture.location.clone(),
                            capture.name.clone(),
                            capture.content_name.clone(),
                            None,
                        );
                        frame.insert_capture(slot, capture_id, rule);
                    }
                }
                ChildStep::Pattern { pattern } => {
                    let resolved = if let Some(include) = pattern.include.as_ref() {
                        let repo = frame.repository.clone();
                        self.resolve_include(include, repo)
                    } else {
                        Some((pattern, frame.repository.clone()))
                    };
                    let Some((target, target_repository)) = resolved else {
                        continue;
                    };
                    let identity = Arc::as_ptr(&target) as usize;
                    if let Some(&existing_id) = self.compiled_rule_ids.get(&identity) {
                        if !self
                            .registry
                            .try_get_rule(existing_id)
                            .is_some_and(rule_has_only_missing_patterns)
                        {
                            frame.push_pattern(existing_id);
                        }
                    } else {
                        let child_id = self.registry.reserve_rule();
                        self.compiled_rule_ids.insert(identity, child_id);
                        frame.pending = Some(PendingChild::Pattern { rule_id: child_id });
                        Self::push_rule_frame(child_id, target, target_repository, &mut frames);
                    }
                }
            }
        }

        root_id
    }

    fn push_rule_frame(
        id: RuleId,
        description: Arc<RawRule>,
        repository: RepositoryContext,
        frames: &mut Vec<RuleFrame>,
    ) {
        let scope_name = repository.scope_name().to_owned();

        // vscode-textmate selects match and while rules with JavaScript truthiness.
        if description
            .match_pattern
            .as_deref()
            .is_some_and(|pattern| !pattern.is_empty())
        {
            frames.push(RuleFrame {
                id,
                scope_name,
                description,
                repository,
                cursor: FrameCursor::Match {
                    last_capture_key: None,
                },
                pending: None,
                kind: BuildRuleKind::Match {
                    captures: BTreeMap::new(),
                },
            });
            return;
        }

        if description.begin.is_none() {
            let repository = if description.repository.is_some() {
                repository.with_overlay(&description)
            } else {
                repository
            };
            let shorthand_include = if description.patterns.is_none() {
                description.include.as_ref().map(|include| {
                    Arc::new(RawRule {
                        include: Some(include.clone()),
                        ..RawRule::default()
                    })
                })
            } else {
                None
            };
            let raw_pattern_count = description.patterns.as_deref().map_or(
                usize::from(shorthand_include.is_some()),
                <[Arc<RawRule>]>::len,
            );
            frames.push(RuleFrame {
                id,
                scope_name,
                description,
                repository,
                cursor: FrameCursor::IncludeOnly {
                    shorthand_include,
                    next_pattern: 0,
                },
                pending: None,
                kind: BuildRuleKind::IncludeOnly {
                    raw_pattern_count,
                    compiled_patterns: Vec::new(),
                },
            });
            return;
        }

        let raw_pattern_count = description
            .patterns
            .as_deref()
            .map_or(0, <[Arc<RawRule>]>::len);

        if description
            .while_pattern
            .as_deref()
            .is_some_and(|pattern| !pattern.is_empty())
        {
            frames.push(RuleFrame {
                id,
                scope_name,
                description,
                repository,
                cursor: FrameCursor::BeginWhile {
                    phase: BeginWhilePhase::BeginCaptures,
                    last_capture_key: None,
                    next_pattern: 0,
                },
                pending: None,
                kind: BuildRuleKind::BeginWhile {
                    begin_captures: BTreeMap::new(),
                    while_captures: BTreeMap::new(),
                    raw_pattern_count,
                    compiled_patterns: Vec::new(),
                },
            });
            return;
        }

        frames.push(RuleFrame {
            id,
            scope_name,
            description,
            repository,
            cursor: FrameCursor::BeginEnd {
                phase: BeginEndPhase::BeginCaptures,
                last_capture_key: None,
                next_pattern: 0,
            },
            pending: None,
            kind: BuildRuleKind::BeginEnd {
                begin_captures: BTreeMap::new(),
                end_captures: BTreeMap::new(),
                raw_pattern_count,
                compiled_patterns: Vec::new(),
            },
        });
    }

    fn create_capture_rule(
        &mut self,
        location: Option<crate::Location>,
        name: Option<String>,
        content_name: Option<String>,
        retokenize_captured_with_rule_id: Option<RuleId>,
    ) -> Arc<CaptureRule> {
        let id = self.registry.reserve_rule();
        let capture = Arc::new(CaptureRule::new(
            location,
            id,
            name,
            content_name,
            retokenize_captured_with_rule_id,
        ));
        self.registry
            .set_rule(id, Rule::Capture(Arc::clone(&capture)));
        capture
    }

    fn resolve_include(
        &mut self,
        include: &str,
        repository: RepositoryContext,
    ) -> Option<(Arc<RawRule>, RepositoryContext)> {
        match parse_include(include) {
            IncludeReference::Base | IncludeReference::SelfReference => {
                repository.get(include).map(|rule| (rule, repository))
            }
            IncludeReference::RelativeReference { rule_name } => {
                repository.get(rule_name).map(|rule| (rule, repository))
            }
            IncludeReference::TopLevelReference { scope_name } => {
                let grammar = self.get_external_grammar(scope_name, &repository)?;
                let repository = RepositoryContext::new(&grammar);
                let rule = repository.get("$self")?;
                Some((rule, repository))
            }
            IncludeReference::TopLevelRepositoryReference {
                scope_name,
                rule_name,
            } => {
                let grammar = self.get_external_grammar(scope_name, &repository)?;
                let repository = RepositoryContext::new(&grammar);
                let rule = repository.get(rule_name)?;
                Some((rule, repository))
            }
        }
    }

    fn get_external_grammar(
        &mut self,
        scope_name: &str,
        repository: &RepositoryContext,
    ) -> Option<Arc<RawGrammar>> {
        if let Some(grammar) = self.included_grammars.get(scope_name) {
            return Some(Arc::clone(grammar));
        }
        let raw_grammar = self.grammar_provider.lookup(scope_name)?;
        let grammar = Arc::new(initialize_grammar(
            raw_grammar.as_ref(),
            repository.get("$base"),
        ));
        self.included_grammars
            .insert(scope_name.to_owned(), Arc::clone(&grammar));
        self.included_raw_grammars
            .insert(scope_name.to_owned(), raw_grammar);
        Some(grammar)
    }
}

fn parse_capture_id(value: &str) -> Option<usize> {
    let digits = value
        .as_bytes()
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    (digits != 0)
        .then(|| value[..digits].parse::<usize>().ok())
        .flatten()
}

#[derive(Clone, Copy)]
enum CaptureSlot {
    Match,
    Begin,
    While,
    End,
}

#[derive(Clone, Copy)]
enum BeginWhilePhase {
    BeginCaptures,
    WhileCaptures,
    Patterns,
}

#[derive(Clone, Copy)]
enum BeginEndPhase {
    BeginCaptures,
    EndCaptures,
    Patterns,
}

enum FrameCursor {
    Match {
        last_capture_key: Option<String>,
    },
    IncludeOnly {
        shorthand_include: Option<Arc<RawRule>>,
        next_pattern: usize,
    },
    BeginWhile {
        phase: BeginWhilePhase,
        last_capture_key: Option<String>,
        next_pattern: usize,
    },
    BeginEnd {
        phase: BeginEndPhase,
        last_capture_key: Option<String>,
        next_pattern: usize,
    },
}

enum PendingChild {
    Capture {
        slot: CaptureSlot,
        capture_id: usize,
        capture: Arc<RawRule>,
        retokenize_rule_id: RuleId,
    },
    Pattern {
        rule_id: RuleId,
    },
}

enum ChildStep {
    Capture {
        slot: CaptureSlot,
        capture_id: usize,
        capture: Arc<RawRule>,
    },
    Pattern {
        pattern: Arc<RawRule>,
    },
}

fn next_capture_entry(
    captures: Option<&RawCaptures>,
    last_key: &mut Option<String>,
) -> Option<(usize, Arc<RawRule>)> {
    let captures = captures?;
    loop {
        let next = match last_key.as_deref() {
            None => captures.iter().next(),
            Some(prev) => captures
                .range::<str, _>((std::ops::Bound::Excluded(prev), std::ops::Bound::Unbounded))
                .next(),
        };
        let (key, capture) = next?;
        *last_key = Some(key.clone());
        if key == "$vscodeTextmateLocation" {
            continue;
        }
        let Some(capture_id) = parse_capture_id(key) else {
            continue;
        };
        return Some((capture_id, Arc::clone(capture)));
    }
}

fn next_pattern_entry(
    patterns: Option<&[Arc<RawRule>]>,
    shorthand: Option<&Arc<RawRule>>,
    next_pattern: &mut usize,
) -> Option<Arc<RawRule>> {
    if let Some(patterns) = patterns {
        let item = patterns.get(*next_pattern)?;
        *next_pattern += 1;
        return Some(Arc::clone(item));
    }
    if *next_pattern == 0
        && let Some(item) = shorthand
    {
        *next_pattern = 1;
        return Some(Arc::clone(item));
    }
    None
}

enum BuildRuleKind {
    Match {
        captures: BTreeMap<usize, Arc<CaptureRule>>,
    },
    IncludeOnly {
        raw_pattern_count: usize,
        compiled_patterns: Vec<RuleId>,
    },
    BeginWhile {
        begin_captures: BTreeMap<usize, Arc<CaptureRule>>,
        while_captures: BTreeMap<usize, Arc<CaptureRule>>,
        raw_pattern_count: usize,
        compiled_patterns: Vec<RuleId>,
    },
    BeginEnd {
        begin_captures: BTreeMap<usize, Arc<CaptureRule>>,
        end_captures: BTreeMap<usize, Arc<CaptureRule>>,
        raw_pattern_count: usize,
        compiled_patterns: Vec<RuleId>,
    },
}

struct RuleFrame {
    id: RuleId,
    scope_name: String,
    description: Arc<RawRule>,
    repository: RepositoryContext,
    cursor: FrameCursor,
    pending: Option<PendingChild>,
    kind: BuildRuleKind,
}

impl RuleFrame {
    fn next_step(&mut self) -> Option<ChildStep> {
        match &mut self.cursor {
            FrameCursor::Match { last_capture_key } => {
                let (capture_id, capture) =
                    next_capture_entry(self.description.captures.as_ref(), last_capture_key)?;
                Some(ChildStep::Capture {
                    slot: CaptureSlot::Match,
                    capture_id,
                    capture,
                })
            }
            FrameCursor::IncludeOnly {
                shorthand_include,
                next_pattern,
            } => {
                let pattern = next_pattern_entry(
                    self.description.patterns.as_deref(),
                    shorthand_include.as_ref(),
                    next_pattern,
                )?;
                Some(ChildStep::Pattern { pattern })
            }
            FrameCursor::BeginWhile {
                phase,
                last_capture_key,
                next_pattern,
            } => loop {
                match *phase {
                    BeginWhilePhase::BeginCaptures => {
                        let captures = self
                            .description
                            .begin_captures
                            .as_ref()
                            .or(self.description.captures.as_ref());
                        if let Some((capture_id, capture)) =
                            next_capture_entry(captures, last_capture_key)
                        {
                            return Some(ChildStep::Capture {
                                slot: CaptureSlot::Begin,
                                capture_id,
                                capture,
                            });
                        }
                        *phase = BeginWhilePhase::WhileCaptures;
                        *last_capture_key = None;
                    }
                    BeginWhilePhase::WhileCaptures => {
                        let captures = self
                            .description
                            .while_captures
                            .as_ref()
                            .or(self.description.captures.as_ref());
                        if let Some((capture_id, capture)) =
                            next_capture_entry(captures, last_capture_key)
                        {
                            return Some(ChildStep::Capture {
                                slot: CaptureSlot::While,
                                capture_id,
                                capture,
                            });
                        }
                        *phase = BeginWhilePhase::Patterns;
                    }
                    BeginWhilePhase::Patterns => {
                        let pattern = next_pattern_entry(
                            self.description.patterns.as_deref(),
                            None,
                            next_pattern,
                        )?;
                        return Some(ChildStep::Pattern { pattern });
                    }
                }
            },
            FrameCursor::BeginEnd {
                phase,
                last_capture_key,
                next_pattern,
            } => loop {
                match *phase {
                    BeginEndPhase::BeginCaptures => {
                        let captures = self
                            .description
                            .begin_captures
                            .as_ref()
                            .or(self.description.captures.as_ref());
                        if let Some((capture_id, capture)) =
                            next_capture_entry(captures, last_capture_key)
                        {
                            return Some(ChildStep::Capture {
                                slot: CaptureSlot::Begin,
                                capture_id,
                                capture,
                            });
                        }
                        *phase = BeginEndPhase::EndCaptures;
                        *last_capture_key = None;
                    }
                    BeginEndPhase::EndCaptures => {
                        let captures = self
                            .description
                            .end_captures
                            .as_ref()
                            .or(self.description.captures.as_ref());
                        if let Some((capture_id, capture)) =
                            next_capture_entry(captures, last_capture_key)
                        {
                            return Some(ChildStep::Capture {
                                slot: CaptureSlot::End,
                                capture_id,
                                capture,
                            });
                        }
                        *phase = BeginEndPhase::Patterns;
                    }
                    BeginEndPhase::Patterns => {
                        let pattern = next_pattern_entry(
                            self.description.patterns.as_deref(),
                            None,
                            next_pattern,
                        )?;
                        return Some(ChildStep::Pattern { pattern });
                    }
                }
            },
        }
    }
    fn insert_capture(&mut self, slot: CaptureSlot, capture_id: usize, rule: Arc<CaptureRule>) {
        match (&mut self.kind, slot) {
            (BuildRuleKind::Match { captures, .. }, CaptureSlot::Match)
            | (
                BuildRuleKind::BeginWhile {
                    begin_captures: captures,
                    ..
                },
                CaptureSlot::Begin,
            )
            | (
                BuildRuleKind::BeginWhile {
                    while_captures: captures,
                    ..
                },
                CaptureSlot::While,
            )
            | (
                BuildRuleKind::BeginEnd {
                    begin_captures: captures,
                    ..
                },
                CaptureSlot::Begin,
            )
            | (
                BuildRuleKind::BeginEnd {
                    end_captures: captures,
                    ..
                },
                CaptureSlot::End,
            ) => {
                captures.insert(capture_id, rule);
            }
            _ => unreachable!("capture slot must match active rule frame"),
        }
    }

    fn push_pattern(&mut self, rule_id: RuleId) {
        match &mut self.kind {
            BuildRuleKind::IncludeOnly {
                compiled_patterns, ..
            }
            | BuildRuleKind::BeginWhile {
                compiled_patterns, ..
            }
            | BuildRuleKind::BeginEnd {
                compiled_patterns, ..
            } => compiled_patterns.push(rule_id),
            BuildRuleKind::Match { .. } => unreachable!("match rules do not compile patterns"),
        }
    }

    fn into_rule(self) -> Rule {
        let mut rule = match self.kind {
            BuildRuleKind::Match { captures } => Rule::Match(MatchRule::new(
                self.description.location.clone(),
                self.id,
                self.description.name.clone(),
                self.description
                    .match_pattern
                    .as_deref()
                    .expect("match rule must have a match pattern"),
                captures.into_iter().collect(),
            )),
            BuildRuleKind::IncludeOnly {
                raw_pattern_count,
                compiled_patterns,
            } => Rule::IncludeOnly(IncludeOnlyRule::new(
                self.description.location.clone(),
                self.id,
                self.description.name.clone(),
                self.description.content_name.clone(),
                CompilePatternsResult {
                    has_missing_patterns: raw_pattern_count != compiled_patterns.len(),
                    patterns: compiled_patterns,
                },
            )),
            BuildRuleKind::BeginWhile {
                begin_captures,
                while_captures,
                raw_pattern_count,
                compiled_patterns,
            } => Rule::BeginWhile(BeginWhileRule::new(BeginWhileRuleOptions {
                location: self.description.location.clone(),
                id: self.id,
                name: self.description.name.clone(),
                content_name: self.description.content_name.clone(),
                begin: self
                    .description
                    .begin
                    .as_deref()
                    .expect("begin/while rule must have a begin pattern"),
                begin_captures: begin_captures.into_iter().collect(),
                while_pattern: self
                    .description
                    .while_pattern
                    .as_deref()
                    .expect("begin/while rule must have a while pattern"),
                while_captures: while_captures.into_iter().collect(),
                patterns: CompilePatternsResult {
                    has_missing_patterns: raw_pattern_count != compiled_patterns.len(),
                    patterns: compiled_patterns,
                },
            })),
            BuildRuleKind::BeginEnd {
                begin_captures,
                end_captures,
                raw_pattern_count,
                compiled_patterns,
            } => Rule::BeginEnd(BeginEndRule::new(BeginEndRuleOptions {
                location: self.description.location.clone(),
                id: self.id,
                name: self.description.name.clone(),
                content_name: self.description.content_name.clone(),
                begin: self
                    .description
                    .begin
                    .as_deref()
                    .expect("begin/end rule must have a begin pattern"),
                begin_captures: begin_captures.into_iter().collect(),
                end: self.description.end.as_deref(),
                end_captures: end_captures.into_iter().collect(),
                apply_end_pattern_last: self.description.apply_end_pattern_last,
                patterns: CompilePatternsResult {
                    has_missing_patterns: raw_pattern_count != compiled_patterns.len(),
                    patterns: compiled_patterns,
                },
            })),
        };
        rule.set_source_scope_name(self.scope_name);
        rule
    }
}

fn rule_has_only_missing_patterns(rule: &Rule) -> bool {
    if let Some(rule) = rule.as_include_only() {
        rule.has_missing_patterns && rule.patterns.is_empty()
    } else if let Some(rule) = rule.as_begin_end() {
        rule.has_missing_patterns && rule.patterns.is_empty()
    } else if let Some(rule) = rule.as_begin_while() {
        rule.has_missing_patterns && rule.patterns.is_empty()
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use ferroni::scanner::{OnigString, ScannerFindOptions};

    use super::{GrammarStore, RuleFactory};
    use crate::{RawGrammar, RuleScannerId};

    fn grammar(source: &str) -> RawGrammar {
        serde_json::from_str(source).expect("test grammar should deserialize")
    }

    #[test]
    fn compiles_local_includes_and_include_shorthand() {
        let root_grammar = grammar(
            r##"{
                "scopeName": "source.test",
                "patterns": [{ "include": "#wrapper" }],
                "repository": {
                    "wrapper": { "include": "#word" },
                    "word": { "match": "[a-z]+", "name": "word.test" }
                }
            }"##,
        );
        let store = GrammarStore::new();
        let mut factory = RuleFactory::new(&root_grammar, &store);
        let root = factory.compile_root();
        let compiled = factory
            .registry()
            .get_rule(root)
            .compile(factory.registry(), None)
            .unwrap();
        let result = compiled
            .find_next_match(&OnigString::new("word"), 0, ScannerFindOptions::NONE)
            .unwrap();

        assert!(matches!(result.rule_id, RuleScannerId::Rule(_)));
        assert_eq!(
            factory
                .registry()
                .get_rule(root)
                .get_name(None, None)
                .as_deref(),
            Some("source.test")
        );
    }

    #[test]
    fn preserves_sparse_captures_and_retokenization_rules() {
        let grammar = grammar(
            r##"{
                "scopeName": "source.test",
                "patterns": [{
                    "match": "(a)(b)(c)",
                    "captures": {
                        "1": { "name": "first.test" },
                        "3": {
                            "name": "third.test",
                            "patterns": [{ "match": "c" }]
                        }
                    }
                }]
            }"##,
        );
        let store = GrammarStore::new();
        let mut factory = RuleFactory::new(&grammar, &store);
        let root = factory.compile_root();
        let root_rule = factory.registry().get_rule(root).as_include_only().unwrap();
        let match_rule = factory
            .registry()
            .get_rule(root_rule.patterns[0])
            .as_match()
            .unwrap();

        assert_eq!(match_rule.captures.len(), 2);
        assert_eq!(match_rule.captures[0].0, 1);
        assert_eq!(match_rule.captures[1].0, 3);
        assert!(
            match_rule.captures[1]
                .1
                .retokenize_captured_with_rule_id
                .is_some()
        );
    }

    #[test]
    fn skips_rules_whose_only_patterns_are_missing() {
        let grammar = grammar(
            r##"{
                "scopeName": "source.test",
                "patterns": [{ "include": "#wrapper" }],
                "repository": {
                    "wrapper": {
                        "patterns": [{ "include": "#missing" }]
                    }
                }
            }"##,
        );
        let store = GrammarStore::new();
        let mut factory = RuleFactory::new(&grammar, &store);
        let root = factory.compile_root();
        let root = factory.registry().get_rule(root).as_include_only().unwrap();

        assert!(root.patterns.is_empty());
        assert!(root.has_missing_patterns);
    }

    #[test]
    fn explicit_empty_patterns_suppress_include_shorthand() {
        let grammar = grammar(
            r##"{
                "scopeName": "source.test",
                "patterns": [{ "include": "#wrapper" }],
                "repository": {
                    "wrapper": {
                        "include": "#word",
                        "patterns": []
                    },
                    "word": { "match": "word" }
                }
            }"##,
        );
        let store = GrammarStore::new();
        let mut factory = RuleFactory::new(&grammar, &store);
        let root = factory.compile_root();
        let root = factory.registry().get_rule(root).as_include_only().unwrap();
        let wrapper = factory
            .registry()
            .get_rule(root.patterns[0])
            .as_include_only()
            .unwrap();

        assert!(wrapper.patterns.is_empty());
        assert!(!wrapper.has_missing_patterns);
    }

    #[test]
    fn local_repositories_shadow_outer_rules() {
        let grammar = grammar(
            r##"{
                "scopeName": "source.test",
                "patterns": [{
                    "repository": {
                        "word": { "match": "local" }
                    },
                    "patterns": [{ "include": "#word" }]
                }],
                "repository": {
                    "word": { "match": "outer" }
                }
            }"##,
        );
        let store = GrammarStore::new();
        let mut factory = RuleFactory::new(&grammar, &store);
        let root = factory.compile_root();
        let root = factory.registry().get_rule(root).as_include_only().unwrap();
        let nested = factory
            .registry()
            .get_rule(root.patterns[0])
            .as_include_only()
            .unwrap();
        let word = factory
            .registry()
            .get_rule(nested.patterns[0])
            .as_match()
            .unwrap();

        assert_eq!(word.debug_match_reg_exp(), "local");
    }

    #[test]
    fn compiles_external_grammar_and_repository_references() {
        let root_grammar = grammar(
            r##"{
                "scopeName": "source.test",
                "patterns": [
                    { "include": "source.external#word" },
                    { "include": "source.external" }
                ]
            }"##,
        );
        let external = grammar(
            r##"{
                "scopeName": "source.external",
                "patterns": [{ "include": "#word" }],
                "repository": {
                    "word": { "match": "external" }
                }
            }"##,
        );
        let mut store = GrammarStore::new();
        store.insert(external);
        let mut factory = RuleFactory::new(&root_grammar, &store);
        let root = factory.compile_root();
        let root_rule = factory.registry().get_rule(root).as_include_only().unwrap();

        assert_eq!(root_rule.patterns.len(), 2);
        let compiled = factory
            .registry()
            .get_rule(root)
            .compile(factory.registry(), None)
            .unwrap();
        assert!(
            compiled
                .find_next_match(&OnigString::new("external"), 0, ScannerFindOptions::NONE,)
                .is_some()
        );
    }

    #[test]
    fn reserves_ids_before_following_recursive_includes() {
        let grammar = grammar(
            r##"{
                "scopeName": "source.test",
                "patterns": [{ "include": "#a" }],
                "repository": {
                    "a": { "patterns": [{ "include": "#b" }] },
                    "b": { "patterns": [{ "include": "#a" }] }
                }
            }"##,
        );
        let store = GrammarStore::new();
        let mut factory = RuleFactory::new(&grammar, &store);

        let root = factory.compile_root();

        assert_eq!(root.get(), 1);
        assert_eq!(factory.registry().len(), 3);
    }

    #[test]
    fn stores_sparse_captures_without_oom_or_truncation() {
        let source = format!(
            r##"{{
                "scopeName": "source.test",
                "patterns": [
                    {{
                        "match": "(a)",
                        "captures": {{
                            "1": {{ "name": "valid.test" }},
                            "1000000000": {{ "name": "huge.test" }},
                            "{usize_max}": {{ "name": "max.test" }},
                            "99999999999999999999999": {{ "name": "overflow.test" }}
                        }}
                    }},
                    {{
                        "match": "(b)",
                        "captures": {{
                            "99999999999999999999999": {{}}
                        }}
                    }},
                    {{
                        "match": "(c)",
                        "captures": {{
                            "1024": {{ "name": "boundary.test" }},
                            "1025": {{ "name": "over.test" }}
                        }}
                    }}
                ]
            }}"##,
            usize_max = usize::MAX
        );
        let grammar = grammar(&source);
        let store = GrammarStore::new();
        let mut factory = RuleFactory::new(&grammar, &store);
        let root = factory.compile_root();
        let root_rule = factory.registry().get_rule(root).as_include_only().unwrap();

        let first = factory
            .registry()
            .get_rule(root_rule.patterns[0])
            .as_match()
            .unwrap();
        assert_eq!(first.captures.len(), 3);
        assert_eq!(first.captures[0].0, 1);
        assert_eq!(
            first.captures[0].1.get_name(None, None).as_deref(),
            Some("valid.test")
        );
        assert_eq!(first.captures[1].0, 1_000_000_000);
        assert_eq!(first.captures[2].0, usize::MAX);

        let second = factory
            .registry()
            .get_rule(root_rule.patterns[1])
            .as_match()
            .unwrap();
        assert!(second.captures.is_empty());

        let third = factory
            .registry()
            .get_rule(root_rule.patterns[2])
            .as_match()
            .unwrap();
        assert_eq!(third.captures.len(), 2);
        assert_eq!(third.captures[0].0, 1_024);
        assert_eq!(
            third.captures[0].1.get_name(None, None).as_deref(),
            Some("boundary.test")
        );
        assert_eq!(third.captures[1].0, 1_025);
        assert_eq!(
            third.captures[1].1.get_name(None, None).as_deref(),
            Some("over.test")
        );
    }

    #[test]
    fn drops_deep_repository_overlay_chain_iteratively() {
        use std::collections::BTreeMap;
        use std::sync::Arc;

        let raw = Arc::new(grammar(
            r##"{ "scopeName": "source.overlay", "patterns": [] }"##,
        ));
        let overlay_rule = Arc::new(crate::raw_grammar::RawRule {
            repository: Some(BTreeMap::new()),
            ..crate::raw_grammar::RawRule::default()
        });
        let mut context = super::RepositoryContext::new(&raw);
        for _ in 0..50_000 {
            context = context.with_overlay(&overlay_rule);
        }
        drop(context);
    }
}
