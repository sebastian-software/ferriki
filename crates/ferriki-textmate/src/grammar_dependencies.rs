/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Discovery of external grammars referenced by TextMate include rules.

use std::collections::{BTreeSet, HashSet};
use std::error::Error;
use std::fmt;
use std::sync::Arc;

use crate::include_reference::{parse_include, IncludeReference};
use crate::raw_grammar::{RawGrammar, RawRepository, RawRule};
use crate::rule_factory::GrammarProvider;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AbsoluteRuleReference {
    TopLevel {
        scope_name: String,
    },
    Repository {
        scope_name: String,
        rule_name: String,
    },
}

impl AbsoluteRuleReference {
    #[must_use]
    pub fn top_level(scope_name: impl Into<String>) -> Self {
        Self::TopLevel {
            scope_name: scope_name.into(),
        }
    }

    #[must_use]
    pub fn repository(scope_name: impl Into<String>, rule_name: impl Into<String>) -> Self {
        Self::Repository {
            scope_name: scope_name.into(),
            rule_name: rule_name.into(),
        }
    }

    #[must_use]
    pub fn scope_name(&self) -> &str {
        match self {
            Self::TopLevel { scope_name } | Self::Repository { scope_name, .. } => scope_name,
        }
    }

    #[must_use]
    pub fn key(&self) -> String {
        match self {
            Self::TopLevel { scope_name } => scope_name.clone(),
            Self::Repository {
                scope_name,
                rule_name,
            } => format!("{scope_name}#{rule_name}"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GrammarDependencyError {
    scope_name: String,
}

impl GrammarDependencyError {
    fn missing(scope_name: impl Into<String>) -> Self {
        Self {
            scope_name: scope_name.into(),
        }
    }
}

impl fmt::Display for GrammarDependencyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "no grammar provided for <{}>", self.scope_name)
    }
}

impl Error for GrammarDependencyError {}

pub struct ScopeDependencyProcessor<'a> {
    repository: &'a dyn GrammarProvider,
    initial_scope_name: String,
    seen_full_scope_requests: BTreeSet<String>,
    seen_partial_scope_requests: BTreeSet<String>,
    queue: Vec<AbsoluteRuleReference>,
}

impl<'a> ScopeDependencyProcessor<'a> {
    #[must_use]
    pub fn new(repository: &'a dyn GrammarProvider, initial_scope_name: impl Into<String>) -> Self {
        let initial_scope_name = initial_scope_name.into();
        Self {
            repository,
            seen_full_scope_requests: BTreeSet::from([initial_scope_name.clone()]),
            seen_partial_scope_requests: BTreeSet::new(),
            queue: vec![AbsoluteRuleReference::top_level(initial_scope_name.clone())],
            initial_scope_name,
        }
    }

    #[must_use]
    pub fn queue(&self) -> &[AbsoluteRuleReference] {
        &self.queue
    }

    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn process_queue(&mut self) -> Result<(), GrammarDependencyError> {
        let queue = std::mem::take(&mut self.queue);
        let mut references = ExternalReferenceCollector::default();

        for reference in &queue {
            collect_references_of_reference(
                reference,
                &self.initial_scope_name,
                self.repository,
                &mut references,
            )?;
        }

        for reference in references.references {
            match &reference {
                AbsoluteRuleReference::TopLevel { scope_name } => {
                    if !self.seen_full_scope_requests.insert(scope_name.clone()) {
                        continue;
                    }
                    self.queue.push(reference);
                }
                AbsoluteRuleReference::Repository { scope_name, .. } => {
                    if self.seen_full_scope_requests.contains(scope_name)
                        || !self.seen_partial_scope_requests.insert(reference.key())
                    {
                        continue;
                    }
                    self.queue.push(reference);
                }
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct ExternalReferenceCollector {
    references: Vec<AbsoluteRuleReference>,
    seen_reference_keys: BTreeSet<String>,
    visited_rules: HashSet<usize>,
}

impl ExternalReferenceCollector {
    fn add(&mut self, reference: AbsoluteRuleReference) {
        if self.seen_reference_keys.insert(reference.key()) {
            self.references.push(reference);
        }
    }

    fn visit(&mut self, rule: &Arc<RawRule>) -> bool {
        self.visited_rules.insert(Arc::as_ptr(rule) as usize)
    }
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

#[derive(Clone)]
struct Context {
    base_grammar: Arc<RawGrammar>,
    self_grammar: Arc<RawGrammar>,
    repository: RepositoryContext,
}

fn collect_references_of_reference(
    reference: &AbsoluteRuleReference,
    base_grammar_scope_name: &str,
    repository: &dyn GrammarProvider,
    result: &mut ExternalReferenceCollector,
) -> Result<(), GrammarDependencyError> {
    let Some(self_grammar) = repository.lookup(reference.scope_name()) else {
        if reference.scope_name() == base_grammar_scope_name {
            return Err(GrammarDependencyError::missing(base_grammar_scope_name));
        }
        return Ok(());
    };
    let base_grammar = repository
        .lookup(base_grammar_scope_name)
        .ok_or_else(|| GrammarDependencyError::missing(base_grammar_scope_name))?;
    let context = Context {
        base_grammar,
        repository: RepositoryContext::new(&self_grammar.repository),
        self_grammar,
    };

    match reference {
        AbsoluteRuleReference::TopLevel { .. } => {
            collect_external_references_in_top_level_rule(&context, result);
        }
        AbsoluteRuleReference::Repository { rule_name, .. } => {
            collect_external_references_in_top_level_repository_rule(rule_name, &context, result);
        }
    }

    for injection in repository.injections(reference.scope_name()) {
        result.add(AbsoluteRuleReference::top_level(injection));
    }
    Ok(())
}

fn collect_external_references_in_top_level_repository_rule(
    rule_name: &str,
    context: &Context,
    result: &mut ExternalReferenceCollector,
) {
    if let Some(rule) = context.repository.get(rule_name) {
        collect_external_references_in_rules(&[rule], context, result);
    }
}

fn collect_external_references_in_top_level_rule(
    context: &Context,
    result: &mut ExternalReferenceCollector,
) {
    let context = Context {
        repository: RepositoryContext::new(&context.self_grammar.repository),
        ..context.clone()
    };
    collect_external_references_in_rules(&context.self_grammar.patterns, &context, result);
    let injections: Vec<_> = context.self_grammar.injections.values().cloned().collect();
    collect_external_references_in_rules(&injections, &context, result);
}

fn collect_external_references_in_rules(
    rules: &[Arc<RawRule>],
    context: &Context,
    result: &mut ExternalReferenceCollector,
) {
    for rule in rules {
        if !result.visit(rule) {
            continue;
        }

        let repository = rule.repository.as_ref().map_or_else(
            || context.repository.clone(),
            |local| context.repository.with_overlay(local),
        );
        if let Some(patterns) = rule.patterns.as_deref() {
            collect_external_references_in_rules(
                patterns,
                &Context {
                    repository: repository.clone(),
                    ..context.clone()
                },
                result,
            );
        }

        let Some(include) = rule.include.as_deref() else {
            continue;
        };
        match parse_include(include) {
            IncludeReference::Base => {
                let base_grammar = Arc::clone(&context.base_grammar);
                collect_external_references_in_top_level_rule(
                    &Context {
                        self_grammar: Arc::clone(&base_grammar),
                        repository: RepositoryContext::new(&base_grammar.repository),
                        ..context.clone()
                    },
                    result,
                );
            }
            IncludeReference::SelfReference => {
                collect_external_references_in_top_level_rule(context, result);
            }
            IncludeReference::RelativeReference { rule_name } => {
                collect_external_references_in_top_level_repository_rule(
                    rule_name,
                    &Context {
                        repository,
                        ..context.clone()
                    },
                    result,
                );
            }
            IncludeReference::TopLevelReference { scope_name }
            | IncludeReference::TopLevelRepositoryReference {
                scope_name,
                rule_name: _,
            } => {
                let known_grammar = if scope_name == context.self_grammar.scope_name {
                    Some(Arc::clone(&context.self_grammar))
                } else if scope_name == context.base_grammar.scope_name {
                    Some(Arc::clone(&context.base_grammar))
                } else {
                    None
                };
                if let Some(self_grammar) = known_grammar {
                    let nested = Context {
                        self_grammar,
                        repository,
                        ..context.clone()
                    };
                    if let IncludeReference::TopLevelRepositoryReference { rule_name, .. } =
                        parse_include(include)
                    {
                        collect_external_references_in_top_level_repository_rule(
                            rule_name, &nested, result,
                        );
                    } else {
                        collect_external_references_in_top_level_rule(&nested, result);
                    }
                } else {
                    match parse_include(include) {
                        IncludeReference::TopLevelReference { scope_name } => {
                            result.add(AbsoluteRuleReference::top_level(scope_name));
                        }
                        IncludeReference::TopLevelRepositoryReference {
                            scope_name,
                            rule_name,
                        } => {
                            result.add(AbsoluteRuleReference::repository(scope_name, rule_name));
                        }
                        _ => unreachable!("top-level include was already classified"),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AbsoluteRuleReference, ScopeDependencyProcessor};
    use crate::{GrammarStore, RawGrammar};

    fn grammar(source: &str) -> RawGrammar {
        serde_json::from_str(source).unwrap()
    }

    #[test]
    fn discovers_full_partial_and_injection_dependencies() {
        let root = grammar(
            r##"{
                "scopeName": "source.root",
                "patterns": [
                    { "include": "source.full" },
                    { "include": "source.partial#word" },
                    { "include": "source.partial#word" }
                ]
            }"##,
        );
        let full = grammar(
            r#"{
                "scopeName": "source.full",
                "patterns": [{ "include": "source.transitive" }]
            }"#,
        );
        let partial = grammar(
            r##"{
                "scopeName": "source.partial",
                "patterns": [{ "include": "source.unrequested" }],
                "repository": {
                    "word": { "include": "source.partial-dependency" }
                }
            }"##,
        );
        let mut store = GrammarStore::new();
        for grammar in [root, full, partial] {
            store.insert(grammar);
        }
        store.set_injections("source.root", vec!["source.injection".into()]);
        let mut processor = ScopeDependencyProcessor::new(&store, "source.root");

        processor.process_queue().unwrap();

        assert_eq!(
            processor.queue(),
            [
                AbsoluteRuleReference::top_level("source.full"),
                AbsoluteRuleReference::repository("source.partial", "word"),
                AbsoluteRuleReference::top_level("source.injection"),
            ]
        );

        processor.process_queue().unwrap();

        assert_eq!(
            processor.queue(),
            [
                AbsoluteRuleReference::top_level("source.transitive"),
                AbsoluteRuleReference::top_level("source.partial-dependency"),
            ]
        );
    }

    #[test]
    fn reports_a_missing_initial_grammar() {
        let store = GrammarStore::new();
        let mut processor = ScopeDependencyProcessor::new(&store, "source.missing");

        let error = processor.process_queue().unwrap_err();

        assert_eq!(
            error.to_string(),
            "no grammar provided for <source.missing>"
        );
    }
}
