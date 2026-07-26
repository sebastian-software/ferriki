/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use crate::include_reference::{parse_include, IncludeReference};
use crate::raw_grammar::{RawCaptures, RawGrammar, RawRepository, RawRule, RuleId};
use crate::rule::{
    BeginEndRule, BeginEndRuleOptions, BeginWhileRule, BeginWhileRuleOptions, CaptureRule,
    CompilePatternsResult, IncludeOnlyRule, MatchRule, Rule, RuleRegistry,
};

/// Supplies raw grammars referenced by top-level `include` expressions.
pub trait GrammarProvider {
    fn lookup(&self, scope_name: &str) -> Option<Arc<RawGrammar>>;
}

/// An in-memory grammar provider suitable for registries and tests.
#[derive(Default)]
pub struct GrammarStore {
    grammars: BTreeMap<String, Arc<RawGrammar>>,
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
}

impl GrammarProvider for GrammarStore {
    fn lookup(&self, scope_name: &str) -> Option<Arc<RawGrammar>> {
        self.grammars.get(scope_name).cloned()
    }
}

/// Add the synthetic `$self` and `$base` rules used by vscode-textmate.
#[must_use]
pub fn initialize_grammar(grammar: &RawGrammar, base: Option<Arc<RawRule>>) -> RawGrammar {
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

#[derive(Clone)]
struct RepositoryContext {
    layers: Vec<RawRepository>,
}

impl RepositoryContext {
    fn new(repository: &RawRepository) -> Self {
        Self {
            layers: vec![repository.clone()],
        }
    }

    fn with_overlay(&self, repository: &RawRepository) -> Self {
        let mut layers = self.layers.clone();
        layers.push(repository.clone());
        Self { layers }
    }

    fn get(&self, name: &str) -> Option<Arc<RawRule>> {
        self.layers
            .iter()
            .rev()
            .find_map(|repository| repository.get(name).cloned())
    }
}

/// Mechanical compiler for vscode-textmate raw rules.
pub struct RuleFactory<'a> {
    grammar_provider: &'a dyn GrammarProvider,
    root_grammar: Arc<RawGrammar>,
    included_grammars: BTreeMap<String, Arc<RawGrammar>>,
    compiled_rule_ids: HashMap<usize, RuleId>,
    registry: RuleRegistry,
}

impl<'a> RuleFactory<'a> {
    #[must_use]
    pub fn new(grammar: &RawGrammar, grammar_provider: &'a dyn GrammarProvider) -> Self {
        Self {
            grammar_provider,
            root_grammar: Arc::new(initialize_grammar(grammar, None)),
            included_grammars: BTreeMap::new(),
            compiled_rule_ids: HashMap::new(),
            registry: RuleRegistry::new(),
        }
    }

    pub fn compile_root(&mut self) -> RuleId {
        let grammar = Arc::clone(&self.root_grammar);
        let repository = RepositoryContext::new(&grammar.repository);
        let root = repository
            .get("$self")
            .expect("initialized grammar must define $self");
        self.get_compiled_rule_id(root, repository)
    }

    #[must_use]
    pub fn root_grammar(&self) -> &Arc<RawGrammar> {
        &self.root_grammar
    }

    #[must_use]
    pub fn registry(&self) -> &RuleRegistry {
        &self.registry
    }

    pub fn into_parts(self) -> (Arc<RawGrammar>, RuleRegistry) {
        (self.root_grammar, self.registry)
    }

    fn get_compiled_rule_id(
        &mut self,
        description: Arc<RawRule>,
        repository: RepositoryContext,
    ) -> RuleId {
        let identity = Arc::as_ptr(&description) as usize;
        if let Some(id) = self.compiled_rule_ids.get(&identity) {
            return *id;
        }

        let id = self.registry.reserve_rule();
        self.compiled_rule_ids.insert(identity, id);
        let rule = self.compile_rule(id, &description, repository);
        self.registry.set_rule(id, rule);
        id
    }

    fn compile_rule(
        &mut self,
        id: RuleId,
        description: &RawRule,
        repository: RepositoryContext,
    ) -> Rule {
        if let Some(match_pattern) = description.match_pattern.as_ref() {
            let captures = self.compile_captures(description.captures.as_ref(), repository);
            return Rule::Match(MatchRule::new(
                description.location.clone(),
                id,
                description.name.clone(),
                match_pattern,
                captures,
            ));
        }

        let Some(begin) = description.begin.as_ref() else {
            let repository = description.repository.as_ref().map_or_else(
                || repository.clone(),
                |local| repository.with_overlay(local),
            );
            let shorthand;
            let patterns = if let Some(patterns) = description.patterns.as_deref() {
                Some(patterns)
            } else if let Some(include) = description.include.as_ref() {
                shorthand = vec![Arc::new(RawRule {
                    include: Some(include.clone()),
                    ..RawRule::default()
                })];
                Some(shorthand.as_slice())
            } else {
                None
            };
            let patterns = self.compile_patterns(patterns, repository);
            return Rule::IncludeOnly(IncludeOnlyRule::new(
                description.location.clone(),
                id,
                description.name.clone(),
                description.content_name.clone(),
                patterns,
            ));
        };

        let begin_captures = self.compile_captures(
            description
                .begin_captures
                .as_ref()
                .or(description.captures.as_ref()),
            repository.clone(),
        );

        if let Some(while_pattern) = description.while_pattern.as_ref() {
            let while_captures = self.compile_captures(
                description
                    .while_captures
                    .as_ref()
                    .or(description.captures.as_ref()),
                repository.clone(),
            );
            let patterns = self.compile_patterns(description.patterns.as_deref(), repository);
            return Rule::BeginWhile(BeginWhileRule::new(BeginWhileRuleOptions {
                location: description.location.clone(),
                id,
                name: description.name.clone(),
                content_name: description.content_name.clone(),
                begin: begin.clone(),
                begin_captures,
                while_pattern: while_pattern.clone(),
                while_captures,
                patterns,
            }));
        }

        let end_captures = self.compile_captures(
            description
                .end_captures
                .as_ref()
                .or(description.captures.as_ref()),
            repository.clone(),
        );
        let patterns = self.compile_patterns(description.patterns.as_deref(), repository);
        Rule::BeginEnd(BeginEndRule::new(BeginEndRuleOptions {
            location: description.location.clone(),
            id,
            name: description.name.clone(),
            content_name: description.content_name.clone(),
            begin: begin.clone(),
            begin_captures,
            end: description.end.clone(),
            end_captures,
            apply_end_pattern_last: description.apply_end_pattern_last,
            patterns,
        }))
    }

    fn compile_captures(
        &mut self,
        captures: Option<&RawCaptures>,
        repository: RepositoryContext,
    ) -> Vec<Option<Arc<CaptureRule>>> {
        let Some(captures) = captures else {
            return Vec::new();
        };

        let maximum_capture_id = captures
            .keys()
            .filter(|capture_id| capture_id.as_str() != "$vscodeTextmateLocation")
            .filter_map(|capture_id| parse_capture_id(capture_id))
            .max()
            .unwrap_or(0);
        let mut compiled = vec![None; maximum_capture_id + 1];

        for (capture_id, capture) in captures {
            if capture_id == "$vscodeTextmateLocation" {
                continue;
            }
            let Some(capture_id) = parse_capture_id(capture_id) else {
                continue;
            };
            let retokenize_captured_with_rule_id = capture
                .patterns
                .as_ref()
                .map(|_| self.get_compiled_rule_id(Arc::clone(capture), repository.clone()));
            compiled[capture_id] = Some(self.create_capture_rule(
                capture.location.clone(),
                capture.name.clone(),
                capture.content_name.clone(),
                retokenize_captured_with_rule_id,
            ));
        }
        compiled
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

    fn compile_patterns(
        &mut self,
        patterns: Option<&[Arc<RawRule>]>,
        repository: RepositoryContext,
    ) -> CompilePatternsResult {
        let mut compiled = Vec::new();

        for pattern in patterns.unwrap_or_default() {
            let rule_id = if let Some(include) = pattern.include.as_ref() {
                self.compile_include(include, repository.clone())
            } else {
                Some(self.get_compiled_rule_id(Arc::clone(pattern), repository.clone()))
            };
            let Some(rule_id) = rule_id else {
                continue;
            };

            if self
                .registry
                .try_get_rule(rule_id)
                .is_some_and(rule_has_only_missing_patterns)
            {
                continue;
            }
            compiled.push(rule_id);
        }

        CompilePatternsResult {
            has_missing_patterns: patterns.map_or(0, <[Arc<RawRule>]>::len) != compiled.len(),
            patterns: compiled,
        }
    }

    fn compile_include(&mut self, include: &str, repository: RepositoryContext) -> Option<RuleId> {
        match parse_include(include) {
            IncludeReference::Base | IncludeReference::SelfReference => repository
                .get(include)
                .map(|rule| self.get_compiled_rule_id(rule, repository)),
            IncludeReference::RelativeReference { rule_name } => repository
                .get(rule_name)
                .map(|rule| self.get_compiled_rule_id(rule, repository)),
            IncludeReference::TopLevelReference { scope_name } => {
                let grammar = self.get_external_grammar(scope_name, &repository)?;
                let repository = RepositoryContext::new(&grammar.repository);
                let rule = repository.get("$self")?;
                Some(self.get_compiled_rule_id(rule, repository))
            }
            IncludeReference::TopLevelRepositoryReference {
                scope_name,
                rule_name,
            } => {
                let grammar = self.get_external_grammar(scope_name, &repository)?;
                let repository = RepositoryContext::new(&grammar.repository);
                let rule = repository.get(rule_name)?;
                Some(self.get_compiled_rule_id(rule, repository))
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
        .then(|| value[..digits].parse().ok())
        .flatten()
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

        assert_eq!(match_rule.captures.len(), 4);
        assert!(match_rule.captures[0].is_none());
        assert!(match_rule.captures[2].is_none());
        assert!(match_rule.captures[1].is_some());
        assert!(match_rule.captures[3]
            .as_ref()
            .unwrap()
            .retokenize_captured_with_rule_id
            .is_some());
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
        assert!(compiled
            .find_next_match(&OnigString::new("external"), 0, ScannerFindOptions::NONE,)
            .is_some());
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
}
