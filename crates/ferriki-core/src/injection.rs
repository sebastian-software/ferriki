use crate::rule::*;
use crate::types::*;
use serde_json::Value;
use std::collections::HashMap;

// ─────────────────────────────────────────────────────────────────────────────
// Injection selector parsing (unchanged from old code)
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn parse_injection_clause_priority(clause: &str) -> (InjectionPriority, &str) {
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

pub(crate) fn scope_token_matches_scope(token: &str, scope: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    if token == "*" || token == "$self" || token == scope {
        return true;
    }
    if scope
        .strip_prefix(token)
        .map(|rest| rest.is_empty() || rest.starts_with('.'))
        .unwrap_or(false)
    {
        return true;
    }
    false
}

pub(crate) fn scope_token_matches_stack(token: &str, scope_stack: &[String]) -> bool {
    scope_stack
        .iter()
        .any(|scope| scope_token_matches_scope(token, scope))
}

pub(crate) fn parse_injection_term(term: &str) -> (bool, &str) {
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

pub(crate) fn split_top_level<'a>(input: &'a str, separators: &[char]) -> Vec<&'a str> {
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

pub(crate) fn split_selector_terms(disjunct: &str) -> Vec<&str> {
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

pub(crate) fn compile_selector_disjunct(disjunct: &str) -> Option<CompiledSelectorDisjunct> {
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

pub(crate) fn compile_selector(selector: &str) -> CompiledSelector {
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

pub(crate) fn selector_disjunct_matches_compiled(
    disjunct: &CompiledSelectorDisjunct,
    scope_stack: &[String],
) -> bool {
    let mut has_term = false;
    for term in &disjunct.terms {
        has_term = true;
        let matches = match &term.expr {
            CompiledSelectorExpr::Token(token) => scope_token_matches_stack(token, scope_stack),
            CompiledSelectorExpr::AnyOf(branches) => branches
                .iter()
                .any(|branch| selector_disjunct_matches_compiled(branch, scope_stack)),
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

pub(crate) fn selector_matches_compiled(
    selector: &CompiledSelector,
    scope_stack: &[String],
) -> bool {
    selector.clauses.iter().any(|clause| {
        clause
            .disjuncts
            .iter()
            .any(|disjunct| selector_disjunct_matches_compiled(disjunct, scope_stack))
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Injection compilation
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn collect_injections(
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
        if let Some(rule_id) = compile_rule(
            injection_value,
            registry,
            compiled_map,
            repository,
            grammar_pool,
            &desc_key,
            None,
        ) {
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
pub(crate) fn collect_external_injection(
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

    let ext_scope = ext_obj
        .get("scopeName")
        .and_then(Value::as_str)
        .unwrap_or("");
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

    if let Some(rule_id) = compile_rule(
        self_entry,
        registry,
        compiled_map,
        ext_repo,
        grammar_pool,
        &desc_key,
        Some(ext_grammar),
    ) {
        injections.push(Injection {
            compiled_selector,
            rule_id,
            priority,
        });
    }
}
