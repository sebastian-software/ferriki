/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::RegexError;

use crate::attributed_scope_stack::{AttributedScopeStack, ScopeAttributesProvider};
use crate::line_output::{LineFonts, LineTokens};
use crate::matcher::{Matcher, MatcherError, MatcherPriority, create_matchers};
use crate::regexp::{CaptureIndex, FindNextMatchResult, OnigString, ScannerFindOptions};
use crate::rule::{CaptureRule, RuleRegistry, RuleScannerId};
use crate::state_stack::StateStack;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Injection {
    pub debug_selector: String,
    pub matcher: Matcher,
    pub priority: MatcherPriority,
    pub rule_id: crate::RuleId,
}

impl Injection {
    pub(crate) fn from_selector(
        selector: &str,
        rule_id: crate::RuleId,
    ) -> Result<Vec<Self>, MatcherError> {
        Ok(create_matchers(selector)?
            .into_iter()
            .map(|matcher| Self {
                debug_selector: selector.to_owned(),
                matcher: matcher.matcher,
                priority: matcher.priority,
                rule_id,
            })
            .collect())
    }
}

pub(crate) trait TokenizerGrammar: ScopeAttributesProvider {
    fn rule_registry(&self) -> &RuleRegistry;
    fn injections(&self) -> &[Injection];
    fn theme_id(&self) -> u64 {
        0
    }
}

pub(crate) struct TokenizeStringResult {
    pub stack: Arc<StateStack>,
    pub stopped_early: bool,
}

/// Upper bound on persistent `StateStack` depth during tokenization.
const MAX_STATE_STACK_DEPTH: usize = 4_096;

/// Upper bound on nested capture retokenization recursion on the call stack.
const MAX_CAPTURE_RETOKENIZE_DEPTH: usize = 64;

#[allow(clippy::too_many_arguments)]
pub(crate) fn tokenize_string<G: TokenizerGrammar>(
    grammar: &G,
    line_text: &OnigString,
    is_first_line: bool,
    line_pos: usize,
    stack: Arc<StateStack>,
    line_tokens: &mut LineTokens,
    line_fonts: &mut LineFonts,
    check_while_conditions: bool,
    time_limit_millis: u64,
) -> Result<TokenizeStringResult, RegexError> {
    let deadline = (time_limit_millis != 0)
        .then(|| Instant::now().checked_add(Duration::from_millis(time_limit_millis)))
        .flatten();
    tokenize_string_inner(
        grammar,
        line_text,
        is_first_line,
        line_pos,
        stack,
        line_tokens,
        line_fonts,
        check_while_conditions,
        deadline,
        0,
    )
}

#[allow(clippy::too_many_arguments)]
fn tokenize_string_inner<G: TokenizerGrammar>(
    grammar: &G,
    line_text: &OnigString,
    mut is_first_line: bool,
    mut line_pos: usize,
    mut stack: Arc<StateStack>,
    line_tokens: &mut LineTokens,
    line_fonts: &mut LineFonts,
    check_while_conditions: bool,
    deadline: Option<Instant>,
    capture_depth: usize,
) -> Result<TokenizeStringResult, RegexError> {
    let line_length = line_text.utf16_len();
    let mut anchor_position = -1;

    if check_while_conditions {
        let result = check_while_conditions_impl(
            grammar,
            line_text,
            is_first_line,
            line_pos,
            stack,
            line_tokens,
            line_fonts,
            capture_depth,
            deadline,
        )?;
        stack = result.stack;
        line_pos = result.line_pos;
        is_first_line = result.is_first_line;
        anchor_position = result.anchor_position;

        if result.stopped_early || deadline_exceeded(deadline) {
            return Ok(TokenizeStringResult {
                stack,
                stopped_early: true,
            });
        }
    }

    loop {
        if deadline_exceeded(deadline) {
            return Ok(TokenizeStringResult {
                stack,
                stopped_early: true,
            });
        }

        let matched = match_rule_or_injections(
            grammar,
            line_text,
            is_first_line,
            line_pos,
            &stack,
            anchor_position,
            deadline,
        )?;

        // Ferroni's synchronous Scanner API cannot accept a per-search
        // deadline. Detect an overrun as soon as the current search returns.
        if deadline_exceeded(deadline) {
            return Ok(TokenizeStringResult {
                stack,
                stopped_early: true,
            });
        }

        let Some(matched) = matched else {
            produce(&stack, line_length, line_tokens, line_fonts);
            return Ok(TokenizeStringResult {
                stack,
                stopped_early: false,
            });
        };
        let capture_indices = matched.capture_indices;
        let Some(full_match) = capture_indices.first() else {
            produce(&stack, line_length, line_tokens, line_fonts);
            return Ok(TokenizeStringResult {
                stack,
                stopped_early: false,
            });
        };
        let has_advanced = full_match.end > line_pos;

        match matched.matched_rule_id {
            RuleScannerId::End => {
                let popped_rule = stack
                    .rule(grammar.rule_registry())
                    .as_begin_end()
                    .expect("end scanner identity requires a BeginEndRule");
                produce(&stack, full_match.start, line_tokens, line_fonts);
                let name_scopes = stack
                    .name_scopes_list
                    .clone()
                    .expect("grammar state must have name scopes");
                stack = stack.with_content_name_scopes_list(name_scopes);
                let capture_stopped_early = handle_captures(
                    grammar,
                    line_text,
                    is_first_line,
                    &stack,
                    line_tokens,
                    line_fonts,
                    &popped_rule.end_captures,
                    &capture_indices,
                    capture_depth,
                    deadline,
                )?;
                if !capture_stopped_early {
                    produce(&stack, full_match.end, line_tokens, line_fonts);
                }

                let popped = Arc::clone(&stack);
                stack = stack
                    .parent
                    .clone()
                    .expect("BeginEndRule state must have a parent");
                anchor_position = popped.anchor_pos();

                if !has_advanced && popped.enter_pos() == line_pos as isize {
                    stack = popped;
                    if !capture_stopped_early {
                        produce(&stack, line_length, line_tokens, line_fonts);
                    }
                    return Ok(TokenizeStringResult {
                        stack,
                        stopped_early: capture_stopped_early,
                    });
                }
                if capture_stopped_early {
                    return Ok(TokenizeStringResult {
                        stack,
                        stopped_early: true,
                    });
                }
            }
            RuleScannerId::Rule(matched_rule_id) => {
                let matched_rule = grammar.rule_registry().get_rule(matched_rule_id);
                if (matched_rule.as_begin_end().is_some()
                    || matched_rule.as_begin_while().is_some())
                    && stack.depth >= MAX_STATE_STACK_DEPTH
                {
                    return Err(RegexError::depth_limit(
                        "grammar state stack depth limit exceeded",
                    ));
                }
                produce(&stack, full_match.start, line_tokens, line_fonts);

                let before_push = Arc::clone(&stack);
                let scope_name =
                    matched_rule.get_name(Some(line_text.content()), Some(&capture_indices));
                let name_scopes_list = stack
                    .content_name_scopes_list
                    .as_ref()
                    .expect("grammar state must have content-name scopes")
                    .push_attributed(scope_name.as_deref(), grammar);
                stack = stack.push_with_theme_id(
                    matched_rule_id,
                    grammar.theme_id(),
                    line_pos as isize,
                    anchor_position,
                    full_match.end == line_length,
                    None,
                    Some(Arc::clone(&name_scopes_list)),
                    Some(Arc::clone(&name_scopes_list)),
                );

                if let Some(pushed_rule) = matched_rule.as_begin_end() {
                    let capture_stopped_early = handle_captures(
                        grammar,
                        line_text,
                        is_first_line,
                        &stack,
                        line_tokens,
                        line_fonts,
                        &pushed_rule.begin_captures,
                        &capture_indices,
                        capture_depth,
                        deadline,
                    )?;
                    if !capture_stopped_early {
                        produce(&stack, full_match.end, line_tokens, line_fonts);
                    }
                    anchor_position = full_match.end as isize;
                    let content_name =
                        matched_rule.get_content_name(line_text.content(), &capture_indices);
                    let content_name_scopes_list =
                        name_scopes_list.push_attributed(content_name.as_deref(), grammar);
                    stack = stack.with_content_name_scopes_list_with_theme_id(
                        content_name_scopes_list,
                        grammar.theme_id(),
                    );
                    if pushed_rule.end_has_back_references {
                        let resolved = pushed_rule.get_end_with_resolved_back_references(
                            line_text.content(),
                            &capture_indices,
                        )?;
                        stack = stack.with_end_rule(resolved);
                    }
                    if !has_advanced && before_push.has_same_rule_as(&stack) {
                        stack = stack.pop().expect("newly pushed state must have a parent");
                        if !capture_stopped_early {
                            produce(&stack, line_length, line_tokens, line_fonts);
                        }
                        return Ok(TokenizeStringResult {
                            stack,
                            stopped_early: capture_stopped_early,
                        });
                    }
                    if capture_stopped_early {
                        return Ok(TokenizeStringResult {
                            stack,
                            stopped_early: true,
                        });
                    }
                } else if let Some(pushed_rule) = matched_rule.as_begin_while() {
                    let capture_stopped_early = handle_captures(
                        grammar,
                        line_text,
                        is_first_line,
                        &stack,
                        line_tokens,
                        line_fonts,
                        &pushed_rule.begin_captures,
                        &capture_indices,
                        capture_depth,
                        deadline,
                    )?;
                    if !capture_stopped_early {
                        produce(&stack, full_match.end, line_tokens, line_fonts);
                    }
                    anchor_position = full_match.end as isize;
                    let content_name =
                        matched_rule.get_content_name(line_text.content(), &capture_indices);
                    let content_name_scopes_list =
                        name_scopes_list.push_attributed(content_name.as_deref(), grammar);
                    stack = stack.with_content_name_scopes_list_with_theme_id(
                        content_name_scopes_list,
                        grammar.theme_id(),
                    );
                    if pushed_rule.while_has_back_references {
                        let resolved = pushed_rule.get_while_with_resolved_back_references(
                            line_text.content(),
                            &capture_indices,
                        )?;
                        stack = stack.with_end_rule(resolved);
                    }
                    if !has_advanced && before_push.has_same_rule_as(&stack) {
                        stack = stack.pop().expect("newly pushed state must have a parent");
                        if !capture_stopped_early {
                            produce(&stack, line_length, line_tokens, line_fonts);
                        }
                        return Ok(TokenizeStringResult {
                            stack,
                            stopped_early: capture_stopped_early,
                        });
                    }
                    if capture_stopped_early {
                        return Ok(TokenizeStringResult {
                            stack,
                            stopped_early: true,
                        });
                    }
                } else if let Some(matching_rule) = matched_rule.as_match() {
                    let capture_stopped_early = handle_captures(
                        grammar,
                        line_text,
                        is_first_line,
                        &stack,
                        line_tokens,
                        line_fonts,
                        &matching_rule.captures,
                        &capture_indices,
                        capture_depth,
                        deadline,
                    )?;
                    if !capture_stopped_early {
                        produce(&stack, full_match.end, line_tokens, line_fonts);
                    }
                    stack = stack.pop().expect("MatchRule state must have a parent");
                    if !has_advanced {
                        stack = stack.safe_pop();
                        if !capture_stopped_early {
                            produce(&stack, line_length, line_tokens, line_fonts);
                        }
                        return Ok(TokenizeStringResult {
                            stack,
                            stopped_early: capture_stopped_early,
                        });
                    }
                    if capture_stopped_early {
                        return Ok(TokenizeStringResult {
                            stack,
                            stopped_early: true,
                        });
                    }
                } else {
                    unreachable!("scanner must resolve to a matchable rule");
                }
            }
            RuleScannerId::While => {
                unreachable!("while scanner identity is only valid in while checks");
            }
        }

        if full_match.end > line_pos {
            line_pos = full_match.end;
            is_first_line = false;
        }
    }
}

#[cfg(test)]
thread_local! {
    /// Optional test-only scanner-call threshold that marks any active (`Some`)
    /// deadline as expired once `SCANNER_CALL_COUNT` reaches the threshold.
    static TEST_EXPIRE_AFTER_SCANNER_CALLS: std::cell::Cell<Option<usize>> =
        const { std::cell::Cell::new(None) };
    /// Optional test-only countdown of `deadline_exceeded` polls before an
    /// active (`Some`) deadline reports expiration.
    static TEST_EXPIRE_AFTER_DEADLINE_CHECKS: std::cell::Cell<Option<usize>> =
        const { std::cell::Cell::new(None) };
}

fn deadline_exceeded(deadline: Option<Instant>) -> bool {
    let Some(limit) = deadline else {
        return false;
    };
    #[cfg(test)]
    if let Some(threshold) = TEST_EXPIRE_AFTER_SCANNER_CALLS.with(std::cell::Cell::get)
        && crate::regexp::SCANNER_CALL_COUNT.with(std::cell::Cell::get) >= threshold
    {
        return true;
    }
    #[cfg(test)]
    if let Some(remaining) = TEST_EXPIRE_AFTER_DEADLINE_CHECKS.with(std::cell::Cell::get) {
        if remaining == 0 {
            return true;
        }
        let next = remaining - 1;
        TEST_EXPIRE_AFTER_DEADLINE_CHECKS.with(|cell| cell.set(Some(next)));
        if next == 0 {
            return true;
        }
    }
    Instant::now() > limit
}

struct WhileCheckResult {
    stack: Arc<StateStack>,
    line_pos: usize,
    anchor_position: isize,
    is_first_line: bool,
    stopped_early: bool,
}

#[allow(clippy::too_many_arguments)]
fn check_while_conditions_impl<G: TokenizerGrammar>(
    grammar: &G,
    line_text: &OnigString,
    mut is_first_line: bool,
    mut line_pos: usize,
    mut stack: Arc<StateStack>,
    line_tokens: &mut LineTokens,
    line_fonts: &mut LineFonts,
    capture_depth: usize,
    deadline: Option<Instant>,
) -> Result<WhileCheckResult, RegexError> {
    const STOP_CHECK_INTERVAL: usize = 64;
    let mut anchor_position = if stack.begin_rule_captured_eol { 0 } else { -1 };
    if deadline_exceeded(deadline) {
        return Ok(WhileCheckResult {
            stack,
            line_pos,
            anchor_position,
            is_first_line,
            stopped_early: true,
        });
    }
    let mut while_rules = Vec::new();
    let mut node = Some(Arc::clone(&stack));
    let mut steps: usize = 0;
    while let Some(current) = node {
        steps += 1;
        if steps & (STOP_CHECK_INTERVAL - 1) == 0 && deadline_exceeded(deadline) {
            return Ok(WhileCheckResult {
                stack,
                line_pos,
                anchor_position,
                is_first_line,
                stopped_early: true,
            });
        }
        if current
            .rule(grammar.rule_registry())
            .as_begin_while()
            .is_some()
        {
            while_rules.push(Arc::clone(&current));
        }
        node = current.pop();
    }

    while let Some(while_stack) = while_rules.pop() {
        if deadline_exceeded(deadline) {
            return Ok(WhileCheckResult {
                stack,
                line_pos,
                anchor_position,
                is_first_line,
                stopped_early: true,
            });
        }
        let while_rule = while_stack
            .rule(grammar.rule_registry())
            .as_begin_while()
            .expect("collected while state must reference BeginWhileRule");
        let scanner = while_rule.compile_while_ag_and_record(
            grammar.rule_registry(),
            while_stack.end_rule.as_deref(),
            is_first_line,
            line_pos as isize == anchor_position,
        )?;
        if deadline_exceeded(deadline) {
            return Ok(WhileCheckResult {
                stack,
                line_pos,
                anchor_position,
                is_first_line,
                stopped_early: true,
            });
        }
        let matched = scanner.find_next_match(line_text, line_pos, ScannerFindOptions::NONE);
        let Some(matched) = matched.filter(|matched| matched.rule_id == RuleScannerId::While)
        else {
            stack = while_stack
                .pop()
                .expect("BeginWhileRule state must have a parent");
            if deadline_exceeded(deadline) {
                return Ok(WhileCheckResult {
                    stack,
                    line_pos,
                    anchor_position,
                    is_first_line,
                    stopped_early: true,
                });
            }
            break;
        };
        if deadline_exceeded(deadline) {
            return Ok(WhileCheckResult {
                stack,
                line_pos,
                anchor_position,
                is_first_line,
                stopped_early: true,
            });
        }
        if let Some(full_match) = matched.capture_indices.first() {
            produce(&while_stack, full_match.start, line_tokens, line_fonts);
            if handle_captures(
                grammar,
                line_text,
                is_first_line,
                &while_stack,
                line_tokens,
                line_fonts,
                &while_rule.while_captures,
                &matched.capture_indices,
                capture_depth,
                deadline,
            )? {
                return Ok(WhileCheckResult {
                    stack,
                    line_pos,
                    anchor_position,
                    is_first_line,
                    stopped_early: true,
                });
            }
            produce(&while_stack, full_match.end, line_tokens, line_fonts);
            anchor_position = full_match.end as isize;
            if full_match.end > line_pos {
                line_pos = full_match.end;
                is_first_line = false;
            }
        }
    }

    Ok(WhileCheckResult {
        stack,
        line_pos,
        anchor_position,
        is_first_line,
        stopped_early: false,
    })
}

struct MatchResult {
    capture_indices: Vec<CaptureIndex>,
    matched_rule_id: RuleScannerId,
    priority_match: bool,
}

fn match_rule_or_injections<G: TokenizerGrammar>(
    grammar: &G,
    line_text: &OnigString,
    is_first_line: bool,
    line_pos: usize,
    stack: &Arc<StateStack>,
    anchor_position: isize,
    deadline: Option<Instant>,
) -> Result<Option<MatchResult>, RegexError> {
    let match_result = match_rule(
        grammar,
        line_text,
        is_first_line,
        line_pos,
        stack,
        anchor_position,
        deadline,
    )?;
    if grammar.injections().is_empty() || deadline_exceeded(deadline) {
        return Ok(match_result);
    }
    let injection_result = match_injections(
        grammar,
        line_text,
        is_first_line,
        line_pos,
        stack,
        anchor_position,
        deadline,
    )?;
    let Some(injection_result) = injection_result else {
        return Ok(match_result);
    };
    let Some(match_result) = match_result else {
        return Ok(Some(injection_result));
    };
    let match_score = match_result.capture_indices[0].start;
    let injection_score = injection_result.capture_indices[0].start;
    if injection_score < match_score
        || (injection_result.priority_match && injection_score == match_score)
    {
        Ok(Some(injection_result))
    } else {
        Ok(Some(match_result))
    }
}

fn match_rule<G: TokenizerGrammar>(
    grammar: &G,
    line_text: &OnigString,
    is_first_line: bool,
    line_pos: usize,
    stack: &Arc<StateStack>,
    anchor_position: isize,
    deadline: Option<Instant>,
) -> Result<Option<MatchResult>, RegexError> {
    let rule = stack.rule(grammar.rule_registry());
    let scanner = rule.compile_ag(
        grammar.rule_registry(),
        stack.end_rule.as_deref(),
        is_first_line,
        line_pos as isize == anchor_position,
    )?;
    if deadline_exceeded(deadline) {
        return Ok(None);
    }
    Ok(scanner
        .find_next_match(line_text, line_pos, ScannerFindOptions::NONE)
        .map(|matched| MatchResult {
            capture_indices: matched.capture_indices,
            matched_rule_id: matched.rule_id,
            priority_match: false,
        }))
}

fn match_injections<G: TokenizerGrammar>(
    grammar: &G,
    line_text: &OnigString,
    is_first_line: bool,
    line_pos: usize,
    stack: &Arc<StateStack>,
    anchor_position: isize,
    deadline: Option<Instant>,
) -> Result<Option<MatchResult>, RegexError> {
    if deadline_exceeded(deadline) {
        return Ok(None);
    }
    let scope_path = &stack
        .content_name_scopes_list
        .as_ref()
        .expect("grammar state must have content-name scopes")
        .scope_path;
    let Some(scopes) =
        collect_borrowed_segments_with_stop(scope_path, &mut || deadline_exceeded(deadline))
    else {
        return Ok(None);
    };
    let scope_slice = scopes.as_slice();
    let mut best: Option<(usize, FindNextMatchResult<RuleScannerId>, MatcherPriority)> = None;

    for injection in grammar.injections() {
        if deadline_exceeded(deadline) {
            return Ok(None);
        }
        let Some(selector_matched) = injection.matcher.matches_with_stop(
            &scope_slice,
            &mut |identifiers, scopes| {
                matches_scope_identifiers_with_stop(identifiers, scopes, &mut || {
                    deadline_exceeded(deadline)
                })
            },
            &mut || deadline_exceeded(deadline),
        ) else {
            return Ok(None);
        };
        if deadline_exceeded(deadline) {
            return Ok(None);
        }
        if !selector_matched {
            continue;
        }
        let rule = grammar.rule_registry().get_rule(injection.rule_id);
        let scanner = rule.compile_ag(
            grammar.rule_registry(),
            None,
            is_first_line,
            line_pos as isize == anchor_position,
        )?;
        if deadline_exceeded(deadline) {
            return Ok(None);
        }
        let Some(matched) = scanner.find_next_match(line_text, line_pos, ScannerFindOptions::NONE)
        else {
            continue;
        };
        let rating = matched.capture_indices[0].start;
        if best
            .as_ref()
            .is_some_and(|(best_rating, _, _)| rating >= *best_rating)
        {
            continue;
        }
        best = Some((rating, matched, injection.priority));
        if rating == line_pos {
            break;
        }
    }

    Ok(best.map(|(_, matched, priority)| MatchResult {
        capture_indices: matched.capture_indices,
        matched_rule_id: matched.rule_id,
        priority_match: priority == MatcherPriority::Left,
    }))
}

#[allow(clippy::too_many_arguments)]
fn handle_captures<G: TokenizerGrammar>(
    grammar: &G,
    line_text: &OnigString,
    is_first_line: bool,
    stack: &Arc<StateStack>,
    line_tokens: &mut LineTokens,
    line_fonts: &mut LineFonts,
    captures: &[(usize, Arc<CaptureRule>)],
    capture_indices: &[CaptureIndex],
    capture_depth: usize,
    deadline: Option<Instant>,
) -> Result<bool, RegexError> {
    if captures.is_empty() {
        return Ok(false);
    }
    let line_text_content = line_text.content();
    let mut local_stack: Vec<LocalStackElement> = Vec::new();
    let max_end = capture_indices[0].end;

    for &(index, ref capture_rule) in captures {
        if deadline_exceeded(deadline) {
            return Ok(true);
        }
        if index >= capture_indices.len() {
            break;
        }
        let capture_index = &capture_indices[index];
        if capture_index.length == 0 {
            continue;
        }
        if capture_index.start > max_end {
            break;
        }

        while local_stack
            .last()
            .is_some_and(|local| local.end_pos <= capture_index.start)
        {
            if deadline_exceeded(deadline) {
                return Ok(true);
            }
            let local = local_stack
                .pop()
                .expect("checked local capture stack must be nonempty");
            produce_from_scopes(Some(&local.scopes), local.end_pos, line_tokens, line_fonts);
        }
        if let Some(local) = local_stack.last() {
            produce_from_scopes(
                Some(&local.scopes),
                capture_index.start,
                line_tokens,
                line_fonts,
            );
        } else {
            produce(stack, capture_index.start, line_tokens, line_fonts);
        }

        if let Some(retokenize_rule_id) = capture_rule.retokenize_captured_with_rule_id {
            if capture_depth >= MAX_CAPTURE_RETOKENIZE_DEPTH {
                return Err(RegexError::depth_limit(
                    "capture retokenization depth limit exceeded",
                ));
            }
            let scope_name = capture_rule.get_name(Some(line_text_content), Some(capture_indices));
            let name_scopes_list = stack
                .content_name_scopes_list
                .as_ref()
                .expect("grammar state must have content-name scopes")
                .push_attributed(scope_name.as_deref(), grammar);
            let content_name = capture_rule.get_content_name(line_text_content, capture_indices);
            let content_name_scopes_list =
                name_scopes_list.push_attributed(content_name.as_deref(), grammar);
            let stack_clone = stack.push_with_theme_id(
                retokenize_rule_id,
                grammar.theme_id(),
                capture_index.start as isize,
                -1,
                false,
                None,
                Some(name_scopes_list),
                Some(content_name_scopes_list),
            );
            let prefix = utf16_prefix(line_text_content, capture_index.end);
            let substring = OnigString::new(prefix);
            let retokenized = tokenize_string_inner(
                grammar,
                &substring,
                is_first_line && capture_index.start == 0,
                capture_index.start,
                stack_clone,
                line_tokens,
                line_fonts,
                false,
                deadline,
                capture_depth + 1,
            )?;
            if retokenized.stopped_early || deadline_exceeded(deadline) {
                return Ok(true);
            }
            continue;
        }

        let capture_scope_name =
            capture_rule.get_name(Some(line_text_content), Some(capture_indices));
        if let Some(capture_scope_name) = capture_scope_name {
            let base = local_stack
                .last()
                .map(|local| &local.scopes)
                .or(stack.content_name_scopes_list.as_ref())
                .expect("capture must have a base scope stack");
            let capture_scopes = base.push_attributed(Some(&capture_scope_name), grammar);
            local_stack.push(LocalStackElement {
                scopes: capture_scopes,
                end_pos: capture_index.end,
            });
        }
    }

    while let Some(local) = local_stack.pop() {
        if deadline_exceeded(deadline) {
            return Ok(true);
        }
        produce_from_scopes(Some(&local.scopes), local.end_pos, line_tokens, line_fonts);
    }
    Ok(deadline_exceeded(deadline))
}

struct LocalStackElement {
    scopes: Arc<AttributedScopeStack>,
    end_pos: usize,
}

fn produce(
    stack: &StateStack,
    end_index: usize,
    line_tokens: &mut LineTokens,
    line_fonts: &mut LineFonts,
) {
    line_tokens.produce(stack, end_index);
    line_fonts.produce(stack, end_index);
}

fn produce_from_scopes(
    scopes: Option<&Arc<AttributedScopeStack>>,
    end_index: usize,
    line_tokens: &mut LineTokens,
    line_fonts: &mut LineFonts,
) {
    line_tokens.produce_from_scopes(scopes, end_index);
    line_fonts.produce_from_scopes(scopes, end_index);
}

fn collect_borrowed_segments_with_stop<'a>(
    scope_path: &'a crate::theme::ScopeStack,
    should_stop: &mut impl FnMut() -> bool,
) -> Option<Vec<&'a str>> {
    const STOP_CHECK_INTERVAL: usize = 64;
    let mut item = Some(scope_path);
    let mut result = Vec::new();
    let mut steps: usize = 0;
    while let Some(scope) = item {
        steps += 1;
        if steps & (STOP_CHECK_INTERVAL - 1) == 0 && should_stop() {
            return None;
        }
        result.push(scope.scope_name.as_str());
        item = scope.parent.as_deref();
    }
    result.reverse();
    Some(result)
}

fn matches_scope_identifiers_with_stop(
    identifiers: &[String],
    scopes: &&[&str],
    should_stop: &mut impl FnMut() -> bool,
) -> Option<bool> {
    const STOP_CHECK_INTERVAL: usize = 64;
    if scopes.len() < identifiers.len() {
        return Some(false);
    }
    let mut last_index = 0;
    let mut steps: usize = 0;
    for identifier in identifiers {
        let mut matched = false;
        for (index, scope) in scopes.iter().enumerate().skip(last_index) {
            steps += 1;
            if steps & (STOP_CHECK_INTERVAL - 1) == 0 && should_stop() {
                return None;
            }
            if *scope == identifier
                || scope
                    .strip_prefix(identifier)
                    .is_some_and(|remainder| remainder.starts_with('.'))
            {
                last_index = index + 1;
                matched = true;
                break;
            }
        }
        if !matched {
            return Some(false);
        }
    }
    Some(true)
}

fn utf16_prefix(value: &str, end: usize) -> &str {
    let mut utf16_position = 0;
    for (byte_position, character) in value.char_indices() {
        if utf16_position >= end {
            return &value[..byte_position];
        }
        utf16_position += character.len_utf16();
        if utf16_position > end {
            return &value[..byte_position + character.len_utf8()];
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::{Injection, TokenizeStringResult, TokenizerGrammar, tokenize_string};
    use crate::{
        AttributedScopeStack, BasicScopeAttributes, BasicScopeAttributesProvider,
        EncodedTokenAttributes, FontAttribute, FontStyle, GrammarStore, LineFonts, LineTokens,
        MatchRule, OptionalStandardTokenType, RawGrammar, Rule, RuleFactory, RuleId, RuleRegistry,
        ScopeAttributesProvider, ScopeStack, StateStack, Theme, Token,
    };

    struct TestGrammar {
        root_id: RuleId,
        registry: RuleRegistry,
        basic: BasicScopeAttributesProvider,
        theme: Theme,
        injections: Vec<Injection>,
    }

    impl TestGrammar {
        fn new(source: &str) -> Self {
            let raw: RawGrammar = serde_json::from_str(source).expect("grammar should deserialize");
            let store = GrammarStore::new();
            let mut factory = RuleFactory::new(&raw, &store);
            let root_id = factory.compile_root();
            let (_, registry) = factory.into_parts();
            Self {
                root_id,
                registry,
                basic: BasicScopeAttributesProvider::new(1, None),
                theme: Theme::create_from_raw_theme(None, None).unwrap(),
                injections: Vec::new(),
            }
        }

        fn initial_state(&self) -> Arc<StateStack> {
            let defaults = self.theme.get_defaults();
            let basic = self.basic.default_attributes();
            let metadata = EncodedTokenAttributes::default().set(
                basic.language_id,
                basic.token_type,
                None,
                defaults.font_style,
                defaults.foreground_id,
                defaults.background_id,
            );
            let font = FontAttribute::from(
                Some(defaults.font_family.clone()),
                Some(defaults.font_size),
                Some(defaults.line_height),
            );
            let root_name = self
                .registry
                .get_rule(self.root_id)
                .get_name(None, None)
                .unwrap_or_else(|| "unknown".into());
            let scopes = AttributedScopeStack::create_root_and_lookup_scope_name(
                root_name, metadata, font, self,
            );
            StateStack::new(
                None,
                self.root_id,
                -1,
                -1,
                false,
                None,
                Some(Arc::clone(&scopes)),
                Some(scopes),
            )
        }

        fn add_left_injection(&mut self, pattern: &str, name: &str) {
            let pattern = pattern.to_owned();
            let name = name.to_owned();
            let rule_id = self.registry.register_rule(|id| {
                Rule::Match(MatchRule::new(None, id, Some(name), pattern, Vec::new()))
            });
            self.injections = Injection::from_selector("L:source.test", rule_id).unwrap();
        }
    }

    impl ScopeAttributesProvider for TestGrammar {
        fn metadata_for_scope(&self, scope_name: &str) -> BasicScopeAttributes {
            self.basic.basic_scope_attributes(Some(scope_name))
        }

        fn theme_match(&self, scope_path: &ScopeStack) -> Option<crate::StyleAttributes> {
            self.theme.match_scope(Some(scope_path))
        }
    }

    impl TokenizerGrammar for TestGrammar {
        fn rule_registry(&self) -> &RuleRegistry {
            &self.registry
        }

        fn injections(&self) -> &[Injection] {
            &self.injections
        }
    }

    fn tokenize_line(
        grammar: &TestGrammar,
        line: &str,
        previous: Option<Arc<StateStack>>,
    ) -> (Vec<Token>, TokenizeStringResult) {
        let is_first_line = previous.is_none();
        let stack = previous.unwrap_or_else(|| grammar.initial_state());
        stack.reset();
        let line = format!("{line}\n");
        let onig = crate::OnigString::new(&line);
        let mut tokens = LineTokens::new(false, &line, Vec::new(), None);
        let mut fonts = LineFonts::new();
        let result = tokenize_string(
            grammar,
            &onig,
            is_first_line,
            0,
            stack,
            &mut tokens,
            &mut fonts,
            true,
            0,
        )
        .unwrap();
        let output = tokens.result(&result.stack, onig.utf16_len());
        (output, result)
    }

    #[test]
    fn tokenizes_match_rules_and_scopes() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "foo", "name": "keyword.test" }]
            }"#,
        );

        let (tokens, result) = tokenize_line(&grammar, "foo bar", None);

        assert!(!result.stopped_early);
        assert_eq!(result.stack.depth, 1);
        assert_eq!(tokens[0].start_index, 0);
        assert_eq!(tokens[0].scopes, ["source.test", "keyword.test"]);
    }

    #[test]
    fn carries_begin_end_rules_across_lines() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "\"",
                    "end": "\"",
                    "name": "string.quoted"
                }]
            }"#,
        );

        let (_, first) = tokenize_line(&grammar, "\"open", None);
        assert_eq!(first.stack.depth, 2);
        let (_, second) = tokenize_line(&grammar, "close\"", Some(first.stack));
        assert_eq!(second.stack.depth, 1);
    }

    #[test]
    fn checks_begin_while_rules_from_bottom_to_top() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "^>",
                    "while": "^>",
                    "name": "markup.quote",
                    "patterns": [{ "match": ".", "name": "quote.content" }]
                }]
            }"#,
        );

        let (_, first) = tokenize_line(&grammar, ">one", None);
        assert_eq!(first.stack.depth, 2);
        let (_, second) = tokenize_line(&grammar, ">two", Some(first.stack));
        assert_eq!(second.stack.depth, 2);
        let (_, third) = tokenize_line(&grammar, "plain", Some(second.stack));
        assert_eq!(third.stack.depth, 1);
    }

    #[test]
    fn retokenizes_capture_patterns_with_nested_scopes() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "match": "(x)",
                    "name": "outer.test",
                    "captures": {
                        "1": {
                            "name": "capture.test",
                            "patterns": [{
                                "match": "x",
                                "name": "inner.test"
                            }]
                        }
                    }
                }]
            }"#,
        );

        let (tokens, _) = tokenize_line(&grammar, "x", None);

        assert!(tokens.iter().any(|token| {
            token.scopes == ["source.test", "outer.test", "capture.test", "inner.test"]
        }));
    }

    #[test]
    fn left_priority_injections_win_equal_start_positions() {
        let mut grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "x", "name": "normal.test" }]
            }"#,
        );
        grammar.add_left_injection("x", "injected.test");

        let (tokens, _) = tokenize_line(&grammar, "x", None);

        assert_eq!(tokens[0].scopes, ["source.test", "injected.test"]);
    }

    #[test]
    fn preserves_default_metadata_during_tokenization() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": []
            }"#,
        );
        let state = grammar.initial_state();

        assert_eq!(
            state
                .content_name_scopes_list
                .as_ref()
                .unwrap()
                .token_attributes
                .language_id(),
            1
        );
        assert_eq!(
            state
                .content_name_scopes_list
                .as_ref()
                .unwrap()
                .token_attributes
                .token_type(),
            crate::StandardTokenType::Other
        );
        assert_eq!(
            state
                .content_name_scopes_list
                .as_ref()
                .unwrap()
                .token_attributes
                .font_style(),
            FontStyle::NONE
        );
        assert_eq!(OptionalStandardTokenType::NotSet as u8, 8);
    }

    #[test]
    fn reports_token_offsets_in_utf16_code_units() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "x", "name": "keyword.test" }]
            }"#,
        );

        let (tokens, result) = tokenize_line(&grammar, "💻x", None);
        let keyword = tokens
            .iter()
            .find(|token| token.scopes.last().map(String::as_str) == Some("keyword.test"))
            .unwrap();

        assert!(!result.stopped_early);
        assert_eq!(keyword.start_index, 2);
    }

    #[test]
    fn terminates_after_zero_length_matches() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "(?=x)", "name": "zero.test" }]
            }"#,
        );

        let (tokens, result) = tokenize_line(&grammar, "x", None);

        assert!(!result.stopped_early);
        assert_eq!(result.stack.depth, 1);
        assert!(!tokens.is_empty());
    }

    #[test]
    fn stops_after_a_single_regex_search_exceeds_the_time_limit() {
        const CHILD_TEST: &str = "tokenize_string::tests::single_regex_search_overrun_child";
        const CHILD_ENV: &str = "FERRIKI_REGEX_DEADLINE_CHILD";
        const CHILD_TIMEOUT: Duration = Duration::from_secs(10);

        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", CHILD_TEST, "--nocapture", "--test-threads=1"])
            .env(CHILD_ENV, "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("should start bounded regex deadline test child");

        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let output = child
                        .wait_with_output()
                        .expect("should collect regex deadline test child output");
                    assert!(
                        status.success(),
                        "regex deadline child failed\nstdout:\n{}\nstderr:\n{}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    );
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    assert!(
                        stdout.contains("single regex search baseline")
                            || stderr.contains("single regex search baseline"),
                        "regex deadline child did not report its measured search"
                    );
                    return;
                }
                Ok(None) if started.elapsed() < CHILD_TIMEOUT => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let output = child
                        .wait_with_output()
                        .expect("should reap timed out regex deadline test child");
                    panic!(
                        "regex deadline child exceeded {CHILD_TIMEOUT:?}\nstdout:\n{}\nstderr:\n{}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("could not wait for regex deadline child: {error}");
                }
            }
        }
    }

    #[test]
    fn single_regex_search_overrun_child() {
        if std::env::var_os("FERRIKI_REGEX_DEADLINE_CHILD").is_none() {
            return;
        }

        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "z", "name": "never.test" }]
            }"#,
        );

        // Calibrate the work against this machine, increasing the bounded line
        // until one unbounded search takes long enough for a clear margin.
        let mut size = 4 * 1024 * 1024;
        let max_size = 64 * 1024 * 1024;
        let (line, baseline, baseline_result) = loop {
            let line = "a".repeat(size);
            let (result, elapsed) = run_no_match_search(&grammar, &line, 0);
            assert!(!result.stopped_early);
            if elapsed >= Duration::from_millis(8) || size == max_size {
                break (line, elapsed, result);
            }
            size = (size * 2).min(max_size);
        };
        drop(baseline_result);

        // Millisecond granularity in the public option means a quarter of the
        // calibrated search time gives a robust overrun margin.
        let budget_millis = (baseline.as_millis() / 4).max(1) as u64;
        let (result, elapsed) = run_no_match_search(&grammar, &line, budget_millis);
        eprintln!(
            "single regex search baseline {:.3} ms; limited search {:.3} ms with a {budget_millis} ms tokenization budget",
            baseline.as_secs_f64() * 1_000.0,
            elapsed.as_secs_f64() * 1_000.0
        );
        assert!(result.stopped_early);
        assert!(
            elapsed > Duration::from_millis(budget_millis),
            "the calibrated scanner pass should exceed its {budget_millis} ms budget"
        );
    }

    fn run_no_match_search(
        grammar: &TestGrammar,
        line: &str,
        time_limit_millis: u64,
    ) -> (TokenizeStringResult, Duration) {
        let onig = crate::OnigString::new(line);
        let state = grammar.initial_state();
        let mut tokens = LineTokens::new(false, line, Vec::new(), None);
        let mut fonts = LineFonts::new();

        let started = Instant::now();
        let result = tokenize_string(
            grammar,
            &onig,
            true,
            0,
            state,
            &mut tokens,
            &mut fonts,
            false,
            time_limit_millis,
        )
        .unwrap();
        (result, started.elapsed())
    }

    #[test]
    fn caps_state_stack_depth_on_deeply_nested_begin_end_rules() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [
                    {
                        "begin": "\\(",
                        "end": "\\)",
                        "patterns": [{ "include": "$self" }]
                    },
                    {
                        "match": "top",
                        "name": "keyword.top"
                    }
                ]
            }"#,
        );
        let tokenize_binary = |line: &str, state: Option<Arc<StateStack>>| {
            let line_text = format!("{line}\n");
            let onig = crate::OnigString::new(&line_text);
            let is_first_line = state.is_none();
            let initial = state.unwrap_or_else(|| grammar.initial_state());
            let mut tokens = LineTokens::new(true, &line_text, Vec::new(), None);
            let mut fonts = LineFonts::new();
            tokenize_string(
                &grammar,
                &onig,
                is_first_line,
                0,
                initial,
                &mut tokens,
                &mut fonts,
                true,
                0,
            )
        };

        // Balanced nesting up to the limit succeeds and returns to top-level state.
        let max_nested = super::MAX_STATE_STACK_DEPTH - 1;
        let balanced = format!("{}{}", "(".repeat(max_nested), ")".repeat(max_nested));
        let balanced_result = tokenize_binary(&balanced, None).expect("within depth limit");
        assert!(!balanced_result.stopped_early);
        assert_eq!(balanced_result.stack.depth, 1);
        let (next_tokens, next_result) =
            tokenize_line(&grammar, "top", Some(balanced_result.stack));
        assert!(!next_result.stopped_early);
        assert_eq!(next_tokens[0].scopes, vec!["source.test", "keyword.top"]);

        // Exceeding the depth limit returns an explicit error instead of a truncated stack.
        let too_deep = format!(
            "{}{}",
            "(".repeat(super::MAX_STATE_STACK_DEPTH),
            ")".repeat(super::MAX_STATE_STACK_DEPTH)
        );
        let err = tokenize_binary(&too_deep, None)
            .err()
            .expect("exceeding state stack depth should return an error");
        assert!(err.to_string().contains("depth limit"));
    }

    #[test]
    fn caps_recursive_capture_retokenization_depth() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "match": "(a+)",
                    "captures": {
                        "1": {
                            "name": "meta.capture",
                            "patterns": [{ "include": "$self" }]
                        }
                    }
                }]
            }"#,
        );
        let line_text = "a\n";
        let onig = crate::OnigString::new(line_text);
        let state = grammar.initial_state();
        let mut tokens = LineTokens::new(true, line_text, Vec::new(), None);
        let mut fonts = LineFonts::new();
        let err = tokenize_string(
            &grammar,
            &onig,
            true,
            0,
            state,
            &mut tokens,
            &mut fonts,
            true,
            0,
        )
        .err()
        .expect("self-recursive capture retokenization should return an error");
        assert!(err.to_string().contains("depth limit"));
    }

    struct ExpireAfterScannerCalls;

    impl ExpireAfterScannerCalls {
        fn new(threshold: usize) -> Self {
            crate::regexp::SCANNER_CALL_COUNT.with(|count| count.set(0));
            super::TEST_EXPIRE_AFTER_SCANNER_CALLS.with(|cell| cell.set(Some(threshold)));
            Self
        }

        fn calls(&self) -> usize {
            crate::regexp::SCANNER_CALL_COUNT.with(std::cell::Cell::get)
        }
    }

    impl Drop for ExpireAfterScannerCalls {
        fn drop(&mut self) {
            super::TEST_EXPIRE_AFTER_SCANNER_CALLS.with(|cell| cell.set(None));
        }
    }

    struct ExpireAfterDeadlineChecks;

    impl ExpireAfterDeadlineChecks {
        fn new(checks: usize) -> Self {
            crate::regexp::SCANNER_CALL_COUNT.with(|count| count.set(0));
            super::TEST_EXPIRE_AFTER_DEADLINE_CHECKS.with(|cell| cell.set(Some(checks)));
            Self
        }

        fn calls(&self) -> usize {
            crate::regexp::SCANNER_CALL_COUNT.with(std::cell::Cell::get)
        }
    }

    impl Drop for ExpireAfterDeadlineChecks {
        fn drop(&mut self) {
            super::TEST_EXPIRE_AFTER_DEADLINE_CHECKS.with(|cell| cell.set(None));
        }
    }

    #[test]
    fn propagates_time_limit_into_capture_retokenization() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [
                    {
                        "begin": "(<)([^>]*)",
                        "beginCaptures": {
                            "1": { "name": "punctuation.open" },
                            "2": {
                                "name": "meta.capture",
                                "patterns": [{ "match": "a", "name": "entity.a" }]
                            }
                        },
                        "end": ">",
                        "name": "meta.tag",
                        "contentName": "meta.tag.body"
                    },
                    { "match": "ok", "name": "keyword.ok" }
                ]
            }"#,
        );

        const CAPTURE_TOKENS: usize = 10;
        let line_text = format!("<{}\n", "a".repeat(CAPTURE_TOKENS));
        let onig = crate::OnigString::new(&line_text);
        let initial = grammar.initial_state();
        let mut tokens = LineTokens::new(false, &line_text, Vec::new(), None);
        let mut fonts = LineFonts::new();

        // Expire any active deadline deterministically after 2 scanner calls:
        // call 1 = outer `begin` match, call 2 = first nested capture match.
        // If handle_captures dropped the deadline to None, the hook would not
        // fire and all CAPTURE_TOKENS inner matches would run.
        let guard = ExpireAfterScannerCalls::new(2);
        let result = tokenize_string(
            &grammar,
            &onig,
            true,
            0,
            Arc::clone(&initial),
            &mut tokens,
            &mut fonts,
            true,
            60_000,
        )
        .unwrap();
        let calls = guard.calls();
        drop(guard);

        assert!(
            result.stopped_early,
            "capture retokenization must honor the caller's tokenizeTimeLimit"
        );
        assert_eq!(
            calls, 2,
            "expected outer match + 1 nested capture match before stopping early"
        );
        // The begin delimiter already matched, so the continuation stack must
        // retain the pushed BeginEndRule with its contentName scopes.
        assert_eq!(result.stack.depth, initial.depth + 1);
        assert_eq!(
            result
                .stack
                .content_name_scopes_list
                .as_ref()
                .unwrap()
                .scope_names(),
            ["source.test", "meta.tag", "meta.tag.body"]
        );
        // The next line closes the begun rule cleanly back to depth 1.
        let (close_tokens, close_result) = tokenize_line(&grammar, ">ok", Some(result.stack));
        assert!(!close_result.stopped_early);
        assert_eq!(close_result.stack.depth, 1);
        assert!(
            close_tokens
                .iter()
                .any(|token| token.scopes == ["source.test", "keyword.ok"])
        );
    }

    #[test]
    fn preserves_popped_stack_when_end_captures_time_out() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [
                    {
                        "begin": "<",
                        "end": "(>)(.*)",
                        "endCaptures": {
                            "1": { "name": "punctuation.close" },
                            "2": {
                                "name": "meta.end.capture",
                                "patterns": [{ "match": "a", "name": "entity.a" }]
                            }
                        },
                        "name": "meta.tag"
                    },
                    { "match": "after", "name": "keyword.after" }
                ]
            }"#,
        );

        let (_, opened) = tokenize_line(&grammar, "<open", None);
        assert_eq!(opened.stack.depth, 2);

        // Expire after call 1 (end delimiter match) + call 2 (first endCaptures match).
        let line_text = ">aaaaaaaaaa\n";
        let onig = crate::OnigString::new(line_text);
        let mut tokens = LineTokens::new(false, line_text, Vec::new(), None);
        let mut fonts = LineFonts::new();
        let guard = ExpireAfterScannerCalls::new(2);
        let result = tokenize_string(
            &grammar,
            &onig,
            false,
            0,
            Arc::clone(&opened.stack),
            &mut tokens,
            &mut fonts,
            true,
            60_000,
        )
        .unwrap();
        let calls = guard.calls();
        drop(guard);

        assert!(result.stopped_early);
        assert_eq!(calls, 2);
        // The end delimiter already matched, so the continuation stack must pop
        // the closed BeginEndRule instead of leaving it open for the next line.
        assert_eq!(result.stack.depth, 1);
        let (next_tokens, next_result) = tokenize_line(&grammar, "after", Some(result.stack));
        assert!(!next_result.stopped_early);
        assert_eq!(next_result.stack.depth, 1);
        assert_eq!(next_tokens[0].scopes, ["source.test", "keyword.after"]);
    }

    #[test]
    fn applies_zero_width_safe_pop_when_lookahead_capture_times_out() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "<",
                    "end": ">",
                    "name": "meta.block",
                    "patterns": [{
                        "match": "(?=(a+))",
                        "captures": {
                            "1": {
                                "name": "meta.lookahead",
                                "patterns": [{ "match": "a", "name": "entity.a" }]
                            }
                        }
                    }]
                }]
            }"#,
        );

        let (_, opened) = tokenize_line(&grammar, "<", None);
        assert_eq!(opened.stack.depth, 2);

        // Zero-width lookahead match (call 1) enters capture retokenization for
        // group 1 (`aaaa`), which expires after call 2. Zero-width recovery
        // must still run safe_pop() before returning stopped_early: true.
        let line_text = "aaaa\n";
        let onig = crate::OnigString::new(line_text);
        let mut tokens = LineTokens::new(false, line_text, Vec::new(), None);
        let mut fonts = LineFonts::new();
        let guard = ExpireAfterScannerCalls::new(2);
        let result = tokenize_string(
            &grammar,
            &onig,
            false,
            0,
            Arc::clone(&opened.stack),
            &mut tokens,
            &mut fonts,
            true,
            60_000,
        )
        .unwrap();
        let calls = guard.calls();
        drop(guard);

        assert!(result.stopped_early);
        assert_eq!(calls, 2);
        assert_eq!(
            result.stack.depth, 1,
            "zero-width match capture timeout must still apply safe_pop()"
        );
    }

    #[test]
    fn stops_early_during_wide_injection_selector_evaluation() {
        let mut grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "x", "name": "keyword.x" }]
            }"#,
        );
        // Place a matching branch (`source.test`) as the last alternative so
        // evaluating the full selector without early interruption would match
        // and invoke the injection scanner (producing 2 scanner calls instead of 1).
        let wide_selector = format!(
            "L:({} | source.test)",
            (0..999)
                .map(|i| format!("scope.miss{i}"))
                .collect::<Vec<_>>()
                .join(" | ")
        );
        let rule_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("injected.test".to_owned()),
                "x",
                Vec::new(),
            ))
        });
        grammar.injections = Injection::from_selector(&wide_selector, rule_id).unwrap();

        let line_text = "x\n";
        let onig = crate::OnigString::new(line_text);
        let state = grammar.initial_state();
        let mut tokens = LineTokens::new(false, line_text, Vec::new(), None);
        let mut fonts = LineFonts::new();

        // Use a poll threshold strictly above the outer poll count (~6) so that
        // without periodic inner polls inside `matches_with_stop` the full
        // selector would reach `source.test` and run the injection scanner
        // (`calls == 2`). With inner polls every 64 nodes (15 polls across 1,000
        // branches), poll 10 fires mid-selector and aborts with `calls == 1`.
        let guard = ExpireAfterDeadlineChecks::new(10);
        let result = tokenize_string(
            &grammar,
            &onig,
            true,
            0,
            state,
            &mut tokens,
            &mut fonts,
            false,
            60_000,
        )
        .unwrap();
        let calls = guard.calls();
        drop(guard);

        assert!(result.stopped_early);
        // Only the main rule scanner ran; the wide selector aborted before running the injection scanner.
        assert_eq!(calls, 1);
    }

    #[test]
    fn reports_stopped_early_when_deadline_expires_flushing_capture_scopes() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "<",
                    "end": ">",
                    "name": "meta.block",
                    "patterns": [{
                        "match": "(?=(a))",
                        "captures": {
                            "1": { "name": "entity.lookahead" }
                        }
                    }]
                }]
            }"#,
        );
        let (_, opened) = tokenize_line(&grammar, "<", None);
        assert_eq!(opened.stack.depth, 2);

        let line_text = "a\n";
        let onig = crate::OnigString::new(line_text);
        let mut tokens = LineTokens::new(false, line_text, Vec::new(), None);
        let mut fonts = LineFonts::new();

        // Checks before flushing local_stack in handle_captures:
        // 1: loop start, 2: match_rule after compile, 3: after match_rule_or_injections,
        // 4: handle_captures loop start for capture 1, 5: local_stack flush check.
        let guard = ExpireAfterDeadlineChecks::new(5);
        let result = tokenize_string(
            &grammar,
            &onig,
            false,
            0,
            Arc::clone(&opened.stack),
            &mut tokens,
            &mut fonts,
            false,
            60_000,
        )
        .unwrap();
        drop(guard);

        assert!(
            result.stopped_early,
            "deadline expiring while flushing capture scopes must report stopped_early: true"
        );
        assert_eq!(result.stack.depth, 1);
        let output = tokens.result(&result.stack, onig.utf16_len());
        assert!(
            !output
                .iter()
                .any(|token| token.scopes.iter().any(|scope| scope == "entity.lookahead")),
            "capture scope must not be emitted after deadline expiry during flush"
        );
    }

    #[test]
    fn stops_early_during_long_ancestor_selector_scope_walk() {
        let mut grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "x", "name": "keyword.x" }]
            }"#,
        );
        let rule_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("injected.test".to_owned()),
                "x",
                Vec::new(),
            ))
        });
        // Single Matcher::Name ancestor selector matching near the end of a long scope stack.
        grammar.injections =
            Injection::from_selector("L:meta.level195 meta.level199", rule_id).unwrap();

        let initial = grammar.initial_state();
        let mut scopes = Arc::clone(initial.content_name_scopes_list.as_ref().unwrap());
        for i in 0..200 {
            scopes = scopes.push_attributed(Some(&format!("meta.level{i}")), &grammar);
        }
        let deep_stack = initial.push(
            grammar.root_id,
            0,
            -1,
            false,
            None,
            Some(Arc::clone(&scopes)),
            Some(scopes),
        );

        let line_text = "x\n";
        let onig = crate::OnigString::new(line_text);
        let mut tokens = LineTokens::new(false, line_text, Vec::new(), None);
        let mut fonts = LineFonts::new();

        // Checks before periodic poll inside matches_scope_identifiers_with_stop:
        // 1: loop start, 2: match_rule after compile, 3: match_rule_or_injections,
        // 4: match_injections entry, 5..7: 3 periodic polls collecting 201 scopes,
        // 8: match_injections loop start, 9: first periodic poll at step 64.
        let guard = ExpireAfterDeadlineChecks::new(9);
        let result = tokenize_string(
            &grammar,
            &onig,
            true,
            0,
            deep_stack,
            &mut tokens,
            &mut fonts,
            false,
            60_000,
        )
        .unwrap();
        let calls = guard.calls();
        drop(guard);

        assert!(result.stopped_early);
        assert_eq!(calls, 1);
        let output = tokens.result(&result.stack, line_text.len());
        assert!(
            !output
                .iter()
                .any(|token| token.scopes.iter().any(|scope| scope == "injected.test")),
            "injection rule must not run when deadline expires during ancestor scope walk"
        );
    }

    #[test]
    fn reports_stopped_early_when_deadline_expires_draining_sibling_captures() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "match": "(a)(b)",
                    "captures": {
                        "1": { "name": "entity.first" },
                        "2": { "name": "entity.second" }
                    }
                }]
            }"#,
        );
        let line_text = "ab\n";
        let onig = crate::OnigString::new(line_text);
        let state = grammar.initial_state();
        let mut tokens = LineTokens::new(false, line_text, Vec::new(), None);
        let mut fonts = LineFonts::new();

        // Checks before sibling local_stack drain when handling capture 2:
        // 1: loop start, 2: match_rule after compile, 3: after match_rule_or_injections,
        // 4: handle_captures loop start for capture 1,
        // 5: handle_captures loop start for capture 2,
        // 6: earlier local_stack drain popping capture 1 before capture 2.
        let guard = ExpireAfterDeadlineChecks::new(6);
        let result = tokenize_string(
            &grammar,
            &onig,
            true,
            0,
            state,
            &mut tokens,
            &mut fonts,
            false,
            60_000,
        )
        .unwrap();
        drop(guard);

        assert!(
            result.stopped_early,
            "deadline expiring while draining sibling captures must report stopped_early: true"
        );
        let output = tokens.result(&result.stack, onig.utf16_len());
        assert!(
            !output.iter().any(|token| {
                token
                    .scopes
                    .iter()
                    .any(|scope| scope == "entity.first" || scope == "entity.second")
            }),
            "sibling capture scopes must not be emitted after deadline expiry during drain"
        );
    }

    #[test]
    fn collect_borrowed_segments_with_stop_aborts_mid_walk() {
        let mut scope = ScopeStack::from(["source.test"]).unwrap();
        for i in 0..200 {
            scope = scope.push_scope(format!("meta.level{i}"));
        }
        let mut polls = 0_usize;
        let stopped = super::collect_borrowed_segments_with_stop(&scope, &mut || {
            polls += 1;
            true
        });
        assert_eq!(stopped, None);
        assert_eq!(polls, 1);

        let full = super::collect_borrowed_segments_with_stop(&scope, &mut || false).unwrap();
        assert_eq!(full.len(), 201);
        assert_eq!(full[0], "source.test");
        assert_eq!(full[200], "meta.level199");
    }

    #[test]
    fn matches_scope_identifiers_with_stop_returns_none_on_expiry() {
        let owned: Vec<String> = (0..200).map(|i| format!("meta.level{i}")).collect();
        let borrowed: Vec<&str> = owned.iter().map(String::as_str).collect();
        let slice = borrowed.as_slice();
        let identifiers = vec!["scope.miss0".to_owned(), "scope.miss1".to_owned()];

        let mut polls = 0_usize;
        let result = super::matches_scope_identifiers_with_stop(&identifiers, &slice, &mut || {
            polls += 1;
            true
        });
        assert_eq!(result, None);
        assert_eq!(polls, 1);

        let no_match =
            super::matches_scope_identifiers_with_stop(&identifiers, &slice, &mut || false);
        assert_eq!(no_match, Some(false));
    }

    #[test]
    fn propagates_expired_deadline_through_handle_captures_directly() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "match": "(a+)",
                    "captures": {
                        "1": {
                            "name": "meta.capture",
                            "patterns": [{ "match": "a", "name": "entity.a" }]
                        }
                    }
                }]
            }"#,
        );
        let line_text = "aaaa\n";
        let onig = crate::OnigString::new(line_text);
        let stack = grammar.initial_state();
        let rule = grammar
            .registry
            .get_rule(grammar.root_id)
            .compile_ag(&grammar.registry, None, true, false)
            .unwrap();
        let matched = rule
            .find_next_match(&onig, 0, crate::regexp::ScannerFindOptions::NONE)
            .unwrap();
        let crate::rule::RuleScannerId::Rule(rule_id) = matched.rule_id else {
            panic!("expected match rule");
        };
        let match_rule = grammar.registry.get_rule(rule_id).as_match().unwrap();
        let mut tokens = LineTokens::new(false, line_text, Vec::new(), None);
        let mut fonts = LineFonts::new();
        let expired = Instant::now().checked_sub(Duration::from_secs(1));

        let stopped = super::handle_captures(
            &grammar,
            &onig,
            true,
            &stack,
            &mut tokens,
            &mut fonts,
            &match_rule.captures,
            &matched.capture_indices,
            0,
            expired,
        )
        .unwrap();

        assert!(stopped);
    }

    #[test]
    fn propagates_time_limit_into_while_condition_checks() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [
                    {
                        "begin": "^>",
                        "while": "^(>)(.*)",
                        "whileCaptures": {
                            "1": { "name": "punctuation.quote" },
                            "2": {
                                "name": "meta.while.capture",
                                "patterns": [{ "match": "a", "name": "entity.a" }]
                            }
                        },
                        "name": "markup.quote",
                        "patterns": [{ "include": "$self" }]
                    },
                    { "match": "plain", "name": "keyword.plain" }
                ]
            }"#,
        );

        let (_, first) = tokenize_line(&grammar, ">seed", None);
        assert_eq!(first.stack.depth, 2);
        // Warm up the while and whileCaptures scanners.
        let _ = tokenize_line(&grammar, ">a", Some(Arc::clone(&first.stack)));

        // Deterministic pre-expired deadline check stops before scanning while rules
        // and preserves a valid state stack.
        let line_text = ">next\n";
        let onig = crate::OnigString::new(line_text);
        let mut tokens = LineTokens::new(false, line_text, Vec::new(), None);
        let mut fonts = LineFonts::new();
        let expired = Instant::now().checked_sub(Duration::from_secs(1));
        let early = super::tokenize_string_inner(
            &grammar,
            &onig,
            false,
            0,
            Arc::clone(&first.stack),
            &mut tokens,
            &mut fonts,
            true,
            expired,
            0,
        )
        .unwrap();
        assert!(early.stopped_early);
        assert_eq!(early.stack.depth, first.stack.depth);

        // Active budget is honored mid-way inside whileCaptures retokenization:
        // call 1 = while regex, call 2 = first nested whileCaptures match.
        const CAPTURE_TOKENS: usize = 10;
        let heavy_line = format!(">{}\n", "a".repeat(CAPTURE_TOKENS));
        let heavy_onig = crate::OnigString::new(&heavy_line);
        let mut heavy_tokens = LineTokens::new(false, &heavy_line, Vec::new(), None);
        let mut heavy_fonts = LineFonts::new();
        let guard = ExpireAfterScannerCalls::new(2);
        let heavy_result = tokenize_string(
            &grammar,
            &heavy_onig,
            false,
            0,
            Arc::clone(&first.stack),
            &mut heavy_tokens,
            &mut heavy_fonts,
            true,
            60_000,
        )
        .unwrap();
        let calls = guard.calls();
        drop(guard);
        assert!(heavy_result.stopped_early);
        assert_eq!(
            calls, 2,
            "expected while match + 1 nested whileCaptures match before stopping early"
        );
        assert_eq!(heavy_result.stack.depth, first.stack.depth);

        // Returned state remains valid for subsequent lines.
        let (next_tokens, next_result) = tokenize_line(&grammar, "plain", Some(heavy_result.stack));
        assert!(!next_result.stopped_early);
        assert_eq!(next_result.stack.depth, 1);
        assert_eq!(next_tokens[0].scopes, ["source.test", "keyword.plain"]);
    }

    #[test]
    fn pops_failed_while_rule_before_returning_stopped_early() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "^>",
                    "while": "z",
                    "name": "markup.quote"
                }]
            }"#,
        );
        let (_, first) = tokenize_line(&grammar, ">seed", None);
        assert_eq!(first.stack.depth, 2);

        // Expire the active deadline right after the failed while search (call 1)
        // and confirm the failed BeginWhileRule is popped before returning stopped_early.
        let line = "no-match\n";
        let onig = crate::OnigString::new(line);
        let mut tokens = LineTokens::new(false, line, Vec::new(), None);
        let mut fonts = LineFonts::new();
        let guard = ExpireAfterScannerCalls::new(1);
        let result = tokenize_string(
            &grammar,
            &onig,
            false,
            0,
            Arc::clone(&first.stack),
            &mut tokens,
            &mut fonts,
            true,
            60_000,
        )
        .unwrap();
        let calls = guard.calls();
        drop(guard);

        assert!(result.stopped_early);
        assert_eq!(calls, 1);
        assert_eq!(
            result.stack.depth, 1,
            "a while condition that already failed during an overrunning search must be popped"
        );
    }

    #[test]
    fn handles_u64_max_time_limit_without_overflow() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "foo", "name": "keyword.test" }]
            }"#,
        );
        let line_text = "foo\n";
        let onig = crate::OnigString::new(line_text);
        let state = grammar.initial_state();
        let mut tokens = LineTokens::new(false, line_text, Vec::new(), None);
        let mut fonts = LineFonts::new();
        let result = tokenize_string(
            &grammar,
            &onig,
            true,
            0,
            state,
            &mut tokens,
            &mut fonts,
            true,
            u64::MAX,
        )
        .unwrap();
        assert!(!result.stopped_early);
    }
}
