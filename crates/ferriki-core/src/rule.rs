use crate::grammar::*;
use crate::types::*;
use serde_json::{json, Value};
use std::collections::HashMap;

// ─────────────────────────────────────────────────────────────────────────────
// Rule compilation (port of vscode-textmate getCompiledRuleId/_compilePatterns)
// ─────────────────────────────────────────────────────────────────────────────

/// Port of vscode-textmate initGrammar(): creates synthetic $self and $base
/// entries in the repository.
/// If `base_grammar` is provided, $base points to the base grammar's $self.
/// Otherwise, $base = $self (the grammar itself).
pub(crate) fn init_grammar(grammar: &Value, base_grammar: Option<&Value>) -> Value {
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
pub(crate) fn has_back_references(pattern: &str) -> bool {
    let mut chars = pattern.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some(next) if next.is_ascii_digit() && next != '0' => return true,
                Some(_) => {}
                None => break,
            }
        }
    }
    false
}

/// Compile a grammar descriptor into the rule registry, returning its RuleId.
/// Port of vscode-textmate RuleFactory.getCompiledRuleId().
pub(crate) fn compile_rule(
    desc: &Value,
    registry: &mut RuleRegistry,
    compiled_map: &mut HashMap<String, RuleId>,
    repository: &serde_json::Map<String, Value>,
    grammar_pool: &HashMap<String, Value>,
    desc_key: &str,
    host_grammar: Option<&Value>,
) -> Option<RuleId> {
    compile_rule_inner(
        desc,
        registry,
        compiled_map,
        repository,
        grammar_pool,
        desc_key,
        host_grammar,
        0,
    )
}

pub(crate) const MAX_COMPILE_DEPTH: usize = 64;

#[allow(clippy::too_many_arguments)]
pub(crate) fn compile_rule_inner(
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
    let content_name = obj
        .get("contentName")
        .and_then(Value::as_str)
        .map(str::to_owned);

    if let Some(match_re) = obj.get("match").and_then(Value::as_str) {
        // MatchRule
        let captures = parse_grammar_captures(obj.get("captures"));
        registry.store(
            id,
            Rule::Match {
                _id: id,
                name,
                match_re: match_re.to_owned(),
                captures,
            },
        );
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
            registry.store(
                id,
                Rule::BeginWhile {
                    _id: id,
                    name,
                    content_name,
                    begin_re: begin_re.to_owned(),
                    while_re: while_re_str.to_owned(),
                    while_has_back_references: has_back_references(while_re_str),
                    begin_captures,
                    while_captures,
                    patterns,
                },
            );
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
        registry.store(
            id,
            Rule::BeginEnd {
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
            },
        );
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

    registry.store(
        id,
        Rule::IncludeOnly {
            _id: id,
            _name: name,
            _content_name: content_name,
            patterns: nested_patterns,
        },
    );
    Some(id)
}

/// Stable identifier for a repository, using the pointer address of the Map.
/// This ensures that the same repo key name in different grammars gets a distinct cache key.
pub(crate) fn repo_id(repository: &serde_json::Map<String, Value>) -> usize {
    repository as *const _ as usize
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn compile_patterns_inner(
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
                    if let Some(rule_id) = compile_rule_inner(
                        target,
                        registry,
                        compiled_map,
                        repository,
                        grammar_pool,
                        &desc_key,
                        host_grammar,
                        depth + 1,
                    ) {
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
                    if let Some(rule_id) = compile_rule_inner(
                        target,
                        registry,
                        compiled_map,
                        repository,
                        grammar_pool,
                        &desc_key,
                        host_grammar,
                        depth + 1,
                    ) {
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
                            if let Some(target_repo) =
                                target_obj.get("repository").and_then(Value::as_object)
                            {
                                if let Some(target_rule) = target_repo.get(key) {
                                    let desc_key = format!("cross:{scope}#{key}");
                                    if let Some(rule_id) = compile_rule_inner(
                                        target_rule,
                                        registry,
                                        compiled_map,
                                        target_repo,
                                        grammar_pool,
                                        &desc_key,
                                        host_grammar,
                                        depth + 1,
                                    ) {
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
                    if let Some(target_repo) =
                        target_obj.get("repository").and_then(Value::as_object)
                    {
                        if let Some(self_entry) = target_repo.get("$self") {
                            let desc_key = format!("scope:{include}/$self");
                            if let Some(rule_id) = compile_rule_inner(
                                self_entry,
                                registry,
                                compiled_map,
                                target_repo,
                                grammar_pool,
                                &desc_key,
                                host_grammar,
                                depth + 1,
                            ) {
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
        if let Some(rule_id) = compile_rule_inner(
            item,
            registry,
            compiled_map,
            repository,
            grammar_pool,
            &desc_key,
            host_grammar,
            depth + 1,
        ) {
            out.push(rule_id);
        }
    }

    out
}
