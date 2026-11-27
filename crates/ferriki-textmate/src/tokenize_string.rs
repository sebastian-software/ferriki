/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::RegexError;

use crate::attributed_scope_stack::{AttributedScopeStack, ScopeAttributesProvider};
use crate::line_output::{LineFonts, LineTokens};
use crate::matcher::{Matcher, MatcherError, MatcherPriority, create_matchers};
use crate::regexp::{FindNextMatchResult, OnigString, ScannerCaptureIndex, ScannerFindOptions};
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
    line_tokens: &mut LineTokens<'_>,
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

struct TokenizeContext<'a, 'b, G: TokenizerGrammar> {
    grammar: &'a G,
    line_tokens: &'a mut LineTokens<'b>,
    line_fonts: &'a mut LineFonts,
    injection_cache: InjectionScopeCache,
    capture_pool: CapturePool,
    deadline: Option<Instant>,
}

/// Depth-0 reusable storage for small inline Ferroni capture tuples (2..=8
/// slots) so nonrecursive multi-capture matches avoid heap allocations while
/// keeping `tokenize_string_loop`'s recursive stack frames free of
/// `ScannerMatch`'s 272-byte inline buffer. Wide (>8-slot) matches already live
/// on the heap inside Ferroni and move their `Vec` directly via
/// `into_captures()` with zero copying.
#[derive(Default)]
struct CapturePool {
    inline: Option<[ScannerCaptureIndex; 16]>,
    inline_len: usize,
}

impl CapturePool {
    /// Ferroni's `ScannerMatch` stores up to 8 capture slots inline before
    /// spilling to a heap-backed `Vec`.
    const FERRONI_INLINE_CAPTURES: usize = 8;

    #[inline]
    fn mark(&self) -> usize {
        self.inline_len
    }

    #[inline]
    fn restore(&mut self, mark: usize) {
        self.inline_len = mark;
    }

    #[inline]
    fn store_match(&mut self, matched: FindNextMatchResult<RuleScannerId>) -> StepCaptures {
        let captures = matched.captures();
        let len = captures.len();
        if len == 1 {
            return StepCaptures::Single(captures[0].clone());
        }
        if len <= Self::FERRONI_INLINE_CAPTURES && self.inline_len + len <= 16 {
            let start = self.inline_len;
            let inline = self
                .inline
                .get_or_insert_with(|| std::array::from_fn(|_| captures[0].clone()));
            inline[start..start + len].clone_from_slice(captures);
            self.inline_len += len;
            StepCaptures::Inline { start, len }
        } else {
            StepCaptures::Owned(matched.into_captures())
        }
    }

    #[cfg(test)]
    #[inline]
    fn push_slice(&mut self, captures: &[ScannerCaptureIndex]) -> StepCaptures {
        let len = captures.len();
        if len == 1 {
            return StepCaptures::Single(captures[0].clone());
        }
        if len <= Self::FERRONI_INLINE_CAPTURES && self.inline_len + len <= 16 {
            let start = self.inline_len;
            let inline = self
                .inline
                .get_or_insert_with(|| std::array::from_fn(|_| captures[0].clone()));
            inline[start..start + len].clone_from_slice(captures);
            self.inline_len += len;
            StepCaptures::Inline { start, len }
        } else {
            StepCaptures::Owned(captures.to_vec())
        }
    }
}

enum StepCaptures {
    Empty,
    Single(ScannerCaptureIndex),
    Inline { start: usize, len: usize },
    Owned(Vec<ScannerCaptureIndex>),
}

impl StepCaptures {
    #[inline]
    fn len(&self) -> usize {
        match self {
            Self::Empty => 0,
            Self::Single(_) => 1,
            Self::Inline { len, .. } => *len,
            Self::Owned(captures) => captures.len(),
        }
    }

    #[inline]
    fn as_slice<'a>(&'a self, pool: &'a CapturePool) -> &'a [ScannerCaptureIndex] {
        match self {
            Self::Empty => &[],
            Self::Single(capture) => std::slice::from_ref(capture),
            Self::Inline { start, len } => &pool
                .inline
                .as_ref()
                .expect("inline capture pool initialized")[*start..*start + *len],
            Self::Owned(captures) => captures.as_slice(),
        }
    }

    #[inline]
    fn get<'a>(&'a self, pool: &'a CapturePool, index: usize) -> &'a ScannerCaptureIndex {
        match self {
            Self::Empty => unreachable!("empty captures cannot be indexed"),
            Self::Single(capture) => {
                debug_assert_eq!(index, 0);
                capture
            }
            Self::Inline { start, .. } => &pool
                .inline
                .as_ref()
                .expect("inline capture pool initialized")[*start + index],
            Self::Owned(captures) => &captures[index],
        }
    }
}

struct StepMatch {
    rule_id: RuleScannerId,
    match_start: usize,
    match_end: usize,
    captures: StepCaptures,
}

enum NextStep {
    Matched(StepMatch),
    EndOfLine,
    TimedOut,
}

struct MatchedSpan<'a> {
    line_text: &'a OnigString,
    line_is_ascii: bool,
    line_length: usize,
    is_first_line: bool,
    line_pos: usize,
    has_advanced: bool,
    match_start: usize,
    match_end: usize,
    captures: StepCaptures,
    capture_depth: usize,
}

impl MatchedSpan<'_> {
    #[inline]
    fn capture_indices<'a>(&'a self, pool: &'a CapturePool) -> &'a [ScannerCaptureIndex] {
        self.captures.as_slice(pool)
    }
}

#[allow(clippy::too_many_arguments)]
fn tokenize_string_inner<G: TokenizerGrammar>(
    grammar: &G,
    line_text: &OnigString,
    mut is_first_line: bool,
    mut line_pos: usize,
    mut stack: Arc<StateStack>,
    line_tokens: &mut LineTokens<'_>,
    line_fonts: &mut LineFonts,
    check_while_conditions: bool,
    deadline: Option<Instant>,
    capture_depth: usize,
) -> Result<TokenizeStringResult, RegexError> {
    let line_length = line_text.utf16_len();
    let line_is_ascii = line_text.content().len() == line_length;
    let mut anchor_position = -1;
    let mut ctx = TokenizeContext {
        grammar,
        line_tokens,
        line_fonts,
        injection_cache: InjectionScopeCache::default(),
        capture_pool: CapturePool::default(),
        deadline,
    };

    if check_while_conditions {
        let result = check_while_conditions_impl(
            &mut ctx,
            line_text,
            line_is_ascii,
            line_length,
            is_first_line,
            line_pos,
            stack,
            capture_depth,
        )?;
        stack = result.stack;
        line_pos = result.line_pos;
        is_first_line = result.is_first_line;
        anchor_position = result.anchor_position;

        if result.stopped_early {
            return Ok(TokenizeStringResult {
                stack,
                stopped_early: true,
            });
        }
    }

    tokenize_string_loop(
        &mut ctx,
        line_text,
        line_is_ascii,
        line_length,
        is_first_line,
        line_pos,
        anchor_position,
        stack,
        capture_depth,
    )
}

enum StepOutcome {
    Continue,
    Return { stopped_early: bool },
}

#[cfg_attr(debug_assertions, inline(never))]
fn match_next_step<G: TokenizerGrammar>(
    ctx: &mut TokenizeContext<'_, '_, G>,
    line_text: &OnigString,
    is_first_line: bool,
    line_pos: usize,
    stack: &Arc<StateStack>,
    anchor_position: isize,
) -> Result<NextStep, RegexError> {
    let matched = match_rule_or_injections(
        ctx.grammar,
        line_text,
        is_first_line,
        line_pos,
        stack,
        anchor_position,
        &mut ctx.injection_cache,
        ctx.deadline,
    )?;

    // Ferroni's synchronous Scanner API cannot accept a per-search
    // deadline. Detect an overrun as soon as the current search returns.
    if deadline_exceeded(ctx.deadline) {
        return Ok(NextStep::TimedOut);
    }

    let Some(matched) = matched else {
        return Ok(NextStep::EndOfLine);
    };
    let Some(full_match) = matched.matched.captures().first() else {
        return Ok(NextStep::EndOfLine);
    };
    let match_start = full_match.start;
    let match_end = full_match.end;
    let rule_id = matched.matched.rule_id;
    let needs_captures = match rule_id {
        RuleScannerId::End => stack
            .rule(ctx.grammar.rule_registry())
            .as_begin_end()
            .is_some_and(|rule| !rule.end_captures.is_empty()),
        RuleScannerId::Rule(id) => ctx
            .grammar
            .rule_registry()
            .get_rule(id)
            .needs_match_captures(),
        RuleScannerId::While => false,
    };
    let captures = if needs_captures {
        ctx.capture_pool.store_match(matched.matched)
    } else {
        StepCaptures::Empty
    };
    Ok(NextStep::Matched(StepMatch {
        rule_id,
        match_start,
        match_end,
        captures,
    }))
}

#[allow(clippy::too_many_arguments)]
fn tokenize_string_loop<G: TokenizerGrammar>(
    ctx: &mut TokenizeContext<'_, '_, G>,
    line_text: &OnigString,
    line_is_ascii: bool,
    line_length: usize,
    mut is_first_line: bool,
    mut line_pos: usize,
    mut anchor_position: isize,
    mut stack: Arc<StateStack>,
    capture_depth: usize,
) -> Result<TokenizeStringResult, RegexError> {
    loop {
        if deadline_exceeded(ctx.deadline) {
            return Ok(TokenizeStringResult {
                stack,
                stopped_early: true,
            });
        }

        let capture_mark = ctx.capture_pool.mark();
        let step = match match_next_step(
            ctx,
            line_text,
            is_first_line,
            line_pos,
            &stack,
            anchor_position,
        )? {
            NextStep::TimedOut => {
                ctx.capture_pool.restore(capture_mark);
                return Ok(TokenizeStringResult {
                    stack,
                    stopped_early: true,
                });
            }
            NextStep::EndOfLine => {
                ctx.capture_pool.restore(capture_mark);
                produce(&stack, line_length, ctx.line_tokens, ctx.line_fonts);
                return Ok(TokenizeStringResult {
                    stack,
                    stopped_early: false,
                });
            }
            NextStep::Matched(step) => step,
        };
        let match_start = step.match_start;
        let match_end = step.match_end;
        let span = MatchedSpan {
            line_text,
            line_is_ascii,
            line_length,
            is_first_line,
            line_pos,
            has_advanced: match_end > line_pos,
            match_start,
            match_end,
            captures: step.captures,
            capture_depth,
        };

        let outcome = match step.rule_id {
            RuleScannerId::End => apply_end_rule(ctx, &span, &mut anchor_position, &mut stack),
            RuleScannerId::Rule(matched_rule_id) => {
                let matched_rule = ctx.grammar.rule_registry().get_rule(matched_rule_id);
                if let Some(matching_rule) = matched_rule.as_match() {
                    apply_match_rule(
                        ctx,
                        &span,
                        matched_rule_id,
                        matched_rule,
                        matching_rule,
                        anchor_position,
                        &mut stack,
                    )
                } else if let Some(pushed_rule) = matched_rule.as_begin_end() {
                    apply_begin_end_rule(
                        ctx,
                        &span,
                        matched_rule_id,
                        matched_rule,
                        pushed_rule,
                        &mut anchor_position,
                        &mut stack,
                    )
                } else if let Some(pushed_rule) = matched_rule.as_begin_while() {
                    apply_begin_while_rule(
                        ctx,
                        &span,
                        matched_rule_id,
                        matched_rule,
                        pushed_rule,
                        &mut anchor_position,
                        &mut stack,
                    )
                } else {
                    unreachable!("scanner must resolve to a matchable rule");
                }
            }
            RuleScannerId::While => {
                unreachable!("while scanner identity is only valid in while checks");
            }
        };
        ctx.capture_pool.restore(capture_mark);
        let outcome = outcome?;

        if let StepOutcome::Return { stopped_early } = outcome {
            return Ok(TokenizeStringResult {
                stack,
                stopped_early,
            });
        }

        if match_end > line_pos {
            line_pos = match_end;
            is_first_line = false;
        }
    }
}

#[cfg_attr(debug_assertions, inline(never))]
fn apply_end_rule<G: TokenizerGrammar>(
    ctx: &mut TokenizeContext<'_, '_, G>,
    span: &MatchedSpan<'_>,
    anchor_position: &mut isize,
    stack: &mut Arc<StateStack>,
) -> Result<StepOutcome, RegexError> {
    let popped_rule = stack
        .rule(ctx.grammar.rule_registry())
        .as_begin_end()
        .expect("end scanner identity requires a BeginEndRule");
    produce(stack, span.match_start, ctx.line_tokens, ctx.line_fonts);
    let name_scopes = stack
        .name_scopes_list
        .as_ref()
        .expect("grammar state must have name scopes");
    let capture_stopped_early = if popped_rule.end_captures.is_empty() {
        false
    } else {
        let mut capture_stack = None;
        handle_captures(
            ctx,
            span,
            &mut capture_stack,
            || stack.with_content_name_scopes_list(Arc::clone(name_scopes)),
            name_scopes,
            &popped_rule.end_captures,
        )?
    };
    if !capture_stopped_early {
        produce_from_scopes(
            Some(name_scopes),
            span.match_end,
            ctx.line_tokens,
            ctx.line_fonts,
        );
    }

    *anchor_position = stack.anchor_pos();
    if !span.has_advanced && stack.enter_pos() == span.line_pos as isize {
        let name_scopes = Arc::clone(name_scopes);
        *stack = stack.with_content_name_scopes_list(name_scopes);
        if !capture_stopped_early {
            produce(stack, span.line_length, ctx.line_tokens, ctx.line_fonts);
        }
        return Ok(StepOutcome::Return {
            stopped_early: capture_stopped_early,
        });
    }
    *stack = stack
        .parent
        .clone()
        .expect("BeginEndRule state must have a parent");
    if capture_stopped_early {
        return Ok(StepOutcome::Return {
            stopped_early: true,
        });
    }
    Ok(StepOutcome::Continue)
}

#[cfg_attr(debug_assertions, inline(never))]
#[allow(clippy::too_many_arguments)]
fn apply_match_rule<G: TokenizerGrammar>(
    ctx: &mut TokenizeContext<'_, '_, G>,
    span: &MatchedSpan<'_>,
    matched_rule_id: crate::RuleId,
    matched_rule: &crate::rule::Rule,
    matching_rule: &crate::rule::MatchRule,
    anchor_position: isize,
    stack: &mut Arc<StateStack>,
) -> Result<StepOutcome, RegexError> {
    produce(stack, span.match_start, ctx.line_tokens, ctx.line_fonts);
    let base_scopes = stack
        .content_name_scopes_list
        .as_ref()
        .expect("grammar state must have content-name scopes");
    let scope_name = matched_rule.resolved_name(
        Some(span.line_text.content()),
        Some(span.capture_indices(&ctx.capture_pool)),
        span.line_is_ascii,
    );
    let pushed_scopes = scope_name.map(|name| base_scopes.push_resolved(Some(name), ctx.grammar));
    let active_scopes = pushed_scopes.as_ref().unwrap_or(base_scopes);

    let capture_stopped_early = if matching_rule.captures.is_empty() {
        false
    } else {
        let mut capture_stack = None;
        let theme_id = ctx.grammar.theme_id();
        handle_captures(
            ctx,
            span,
            &mut capture_stack,
            || {
                stack.push_with_theme_id(
                    matched_rule_id,
                    theme_id,
                    span.line_pos as isize,
                    anchor_position,
                    span.match_end == span.line_length,
                    None,
                    Some(Arc::clone(active_scopes)),
                    Some(Arc::clone(active_scopes)),
                )
            },
            active_scopes,
            &matching_rule.captures,
        )?
    };
    if !capture_stopped_early {
        produce_from_scopes(
            Some(active_scopes),
            span.match_end,
            ctx.line_tokens,
            ctx.line_fonts,
        );
    }
    if !span.has_advanced {
        *stack = stack.safe_pop();
        if !capture_stopped_early {
            produce(stack, span.line_length, ctx.line_tokens, ctx.line_fonts);
        }
        return Ok(StepOutcome::Return {
            stopped_early: capture_stopped_early,
        });
    }
    if capture_stopped_early {
        return Ok(StepOutcome::Return {
            stopped_early: true,
        });
    }
    Ok(StepOutcome::Continue)
}

#[cfg_attr(debug_assertions, inline(never))]
#[allow(clippy::too_many_arguments)]
fn apply_begin_end_rule<G: TokenizerGrammar>(
    ctx: &mut TokenizeContext<'_, '_, G>,
    span: &MatchedSpan<'_>,
    matched_rule_id: crate::RuleId,
    matched_rule: &crate::rule::Rule,
    pushed_rule: &crate::rule::BeginEndRule,
    anchor_position: &mut isize,
    stack: &mut Arc<StateStack>,
) -> Result<StepOutcome, RegexError> {
    if stack.depth >= MAX_STATE_STACK_DEPTH {
        return Err(RegexError::depth_limit(
            "grammar state stack depth limit exceeded",
        ));
    }
    produce(stack, span.match_start, ctx.line_tokens, ctx.line_fonts);
    let scope_name = matched_rule.resolved_name(
        Some(span.line_text.content()),
        Some(span.capture_indices(&ctx.capture_pool)),
        span.line_is_ascii,
    );
    let name_scopes_list = stack
        .content_name_scopes_list
        .as_ref()
        .expect("grammar state must have content-name scopes")
        .push_resolved(scope_name, ctx.grammar);

    let mut temp_stack = None;
    let theme_id = ctx.grammar.theme_id();
    let capture_stopped_early = if pushed_rule.begin_captures.is_empty() {
        false
    } else {
        handle_captures(
            ctx,
            span,
            &mut temp_stack,
            || {
                stack.push_with_theme_id(
                    matched_rule_id,
                    theme_id,
                    span.line_pos as isize,
                    *anchor_position,
                    span.match_end == span.line_length,
                    None,
                    Some(Arc::clone(&name_scopes_list)),
                    Some(Arc::clone(&name_scopes_list)),
                )
            },
            &name_scopes_list,
            &pushed_rule.begin_captures,
        )?
    };
    if !capture_stopped_early {
        produce_from_scopes(
            Some(&name_scopes_list),
            span.match_end,
            ctx.line_tokens,
            ctx.line_fonts,
        );
    }
    let begin_anchor = *anchor_position;
    *anchor_position = span.match_end as isize;
    let content_name = matched_rule.resolved_content_name(
        span.line_text.content(),
        span.capture_indices(&ctx.capture_pool),
        span.line_is_ascii,
    );
    let has_content_name = content_name.is_some();
    let content_name_scopes_list = name_scopes_list.push_resolved(content_name, ctx.grammar);
    let end_rule = if pushed_rule.end_has_back_references {
        Some(
            pushed_rule.get_end_with_resolved_back_references_with_ascii(
                span.line_text.content(),
                span.capture_indices(&ctx.capture_pool),
                span.line_is_ascii,
            )?,
        )
    } else {
        None
    };
    if !span.has_advanced && stack.has_same_rule(matched_rule_id, span.line_pos as isize) {
        if !capture_stopped_early {
            produce(stack, span.line_length, ctx.line_tokens, ctx.line_fonts);
        }
        return Ok(StepOutcome::Return {
            stopped_early: capture_stopped_early,
        });
    }
    *stack = if !has_content_name
        && end_rule.is_none()
        && let Some(reused) = temp_stack.take()
    {
        reused
    } else {
        stack.push_with_theme_id(
            matched_rule_id,
            theme_id,
            span.line_pos as isize,
            begin_anchor,
            span.match_end == span.line_length,
            end_rule,
            Some(name_scopes_list),
            Some(content_name_scopes_list),
        )
    };
    if capture_stopped_early {
        return Ok(StepOutcome::Return {
            stopped_early: true,
        });
    }
    Ok(StepOutcome::Continue)
}

#[cfg_attr(debug_assertions, inline(never))]
#[allow(clippy::too_many_arguments)]
fn apply_begin_while_rule<G: TokenizerGrammar>(
    ctx: &mut TokenizeContext<'_, '_, G>,
    span: &MatchedSpan<'_>,
    matched_rule_id: crate::RuleId,
    matched_rule: &crate::rule::Rule,
    pushed_rule: &crate::rule::BeginWhileRule,
    anchor_position: &mut isize,
    stack: &mut Arc<StateStack>,
) -> Result<StepOutcome, RegexError> {
    if stack.depth >= MAX_STATE_STACK_DEPTH {
        return Err(RegexError::depth_limit(
            "grammar state stack depth limit exceeded",
        ));
    }
    produce(stack, span.match_start, ctx.line_tokens, ctx.line_fonts);
    let scope_name = matched_rule.resolved_name(
        Some(span.line_text.content()),
        Some(span.capture_indices(&ctx.capture_pool)),
        span.line_is_ascii,
    );
    let name_scopes_list = stack
        .content_name_scopes_list
        .as_ref()
        .expect("grammar state must have content-name scopes")
        .push_resolved(scope_name, ctx.grammar);

    let mut temp_stack = None;
    let theme_id = ctx.grammar.theme_id();
    let capture_stopped_early = if pushed_rule.begin_captures.is_empty() {
        false
    } else {
        handle_captures(
            ctx,
            span,
            &mut temp_stack,
            || {
                stack.push_with_theme_id(
                    matched_rule_id,
                    theme_id,
                    span.line_pos as isize,
                    *anchor_position,
                    span.match_end == span.line_length,
                    None,
                    Some(Arc::clone(&name_scopes_list)),
                    Some(Arc::clone(&name_scopes_list)),
                )
            },
            &name_scopes_list,
            &pushed_rule.begin_captures,
        )?
    };
    if !capture_stopped_early {
        produce_from_scopes(
            Some(&name_scopes_list),
            span.match_end,
            ctx.line_tokens,
            ctx.line_fonts,
        );
    }
    let begin_anchor = *anchor_position;
    *anchor_position = span.match_end as isize;
    let content_name = matched_rule.resolved_content_name(
        span.line_text.content(),
        span.capture_indices(&ctx.capture_pool),
        span.line_is_ascii,
    );
    let has_content_name = content_name.is_some();
    let content_name_scopes_list = name_scopes_list.push_resolved(content_name, ctx.grammar);
    let while_rule = if pushed_rule.while_has_back_references {
        Some(
            pushed_rule.get_while_with_resolved_back_references_with_ascii(
                span.line_text.content(),
                span.capture_indices(&ctx.capture_pool),
                span.line_is_ascii,
            )?,
        )
    } else {
        None
    };
    if !span.has_advanced && stack.has_same_rule(matched_rule_id, span.line_pos as isize) {
        if !capture_stopped_early {
            produce(stack, span.line_length, ctx.line_tokens, ctx.line_fonts);
        }
        return Ok(StepOutcome::Return {
            stopped_early: capture_stopped_early,
        });
    }
    *stack = if !has_content_name
        && while_rule.is_none()
        && let Some(reused) = temp_stack.take()
    {
        reused
    } else {
        stack.push_with_theme_id(
            matched_rule_id,
            theme_id,
            span.line_pos as isize,
            begin_anchor,
            span.match_end == span.line_length,
            while_rule,
            Some(name_scopes_list),
            Some(content_name_scopes_list),
        )
    };
    if capture_stopped_early {
        return Ok(StepOutcome::Return {
            stopped_early: true,
        });
    }
    Ok(StepOutcome::Continue)
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
    ctx: &mut TokenizeContext<'_, '_, G>,
    line_text: &OnigString,
    line_is_ascii: bool,
    line_length: usize,
    mut is_first_line: bool,
    mut line_pos: usize,
    mut stack: Arc<StateStack>,
    capture_depth: usize,
) -> Result<WhileCheckResult, RegexError> {
    const STOP_CHECK_INTERVAL: usize = 64;
    let mut anchor_position = if stack.begin_rule_captured_eol { 0 } else { -1 };
    if deadline_exceeded(ctx.deadline) {
        return Ok(WhileCheckResult {
            stack,
            line_pos,
            anchor_position,
            is_first_line,
            stopped_early: true,
        });
    }
    let mut next_stack = None;
    let mut stopped_early = false;
    {
        let mut while_rules: Vec<&Arc<StateStack>> = Vec::new();
        let mut node: Option<&Arc<StateStack>> = Some(&stack);
        let mut steps: usize = 0;
        while let Some(current) = node {
            steps += 1;
            if steps & (STOP_CHECK_INTERVAL - 1) == 0 && deadline_exceeded(ctx.deadline) {
                stopped_early = true;
                break;
            }
            if current
                .rule(ctx.grammar.rule_registry())
                .as_begin_while()
                .is_some()
            {
                while_rules.push(current);
            }
            node = current.parent.as_ref();
        }

        while !stopped_early && let Some(while_stack) = while_rules.pop() {
            if deadline_exceeded(ctx.deadline) {
                stopped_early = true;
                break;
            }
            let while_rule = while_stack
                .rule(ctx.grammar.rule_registry())
                .as_begin_while()
                .expect("collected while state must reference BeginWhileRule");
            let scanner = while_rule.compile_while_ag_and_record(
                ctx.grammar.rule_registry(),
                while_stack.end_rule.as_deref(),
                is_first_line,
                line_pos as isize == anchor_position,
            )?;
            if deadline_exceeded(ctx.deadline) {
                stopped_early = true;
                break;
            }
            let matched = scanner.find_next_match(line_text, line_pos, ScannerFindOptions::NONE);
            let Some(matched) = matched.filter(|matched| matched.rule_id == RuleScannerId::While)
            else {
                next_stack = Some(
                    while_stack
                        .pop()
                        .expect("BeginWhileRule state must have a parent"),
                );
                if deadline_exceeded(ctx.deadline) {
                    stopped_early = true;
                }
                break;
            };
            if deadline_exceeded(ctx.deadline) {
                stopped_early = true;
                break;
            }
            if let Some(full_match) = matched.captures().first() {
                let full_start = full_match.start;
                let full_end = full_match.end;
                produce(while_stack, full_start, ctx.line_tokens, ctx.line_fonts);
                if !while_rule.while_captures.is_empty() {
                    let while_scopes = while_stack
                        .content_name_scopes_list
                        .as_ref()
                        .expect("grammar state must have content-name scopes");
                    let mut while_capture_stack = None;
                    let capture_mark = ctx.capture_pool.mark();
                    let captures = ctx.capture_pool.store_match(matched);
                    let span = MatchedSpan {
                        line_text,
                        line_is_ascii,
                        line_length,
                        is_first_line,
                        line_pos,
                        has_advanced: full_end > line_pos,
                        match_start: full_start,
                        match_end: full_end,
                        captures,
                        capture_depth,
                    };
                    let handle_result = handle_captures(
                        ctx,
                        &span,
                        &mut while_capture_stack,
                        || Arc::clone(while_stack),
                        while_scopes,
                        &while_rule.while_captures,
                    );
                    ctx.capture_pool.restore(capture_mark);
                    if handle_result? {
                        stopped_early = true;
                        break;
                    }
                }
                produce(while_stack, full_end, ctx.line_tokens, ctx.line_fonts);
                anchor_position = full_end as isize;
                if full_end > line_pos {
                    line_pos = full_end;
                    is_first_line = false;
                }
            }
        }
    }
    if let Some(updated) = next_stack {
        stack = updated;
    }

    Ok(WhileCheckResult {
        stack,
        line_pos,
        anchor_position,
        is_first_line,
        stopped_early,
    })
}

#[derive(Default)]
struct InjectionScopeCache {
    /// Number of distinct `ScopeStack` identities observed on the current line
    /// (saturated at 3). The first 2 distinct stacks borrow `&str` scope names
    /// directly (covering single-scan lines and short begin/end delimiter lines
    /// with zero `Arc<str>` clones); starting at the 3rd distinct stack on the
    /// same line, the owned incremental cache (`node_ptrs`/`segments`) is
    /// populated and reused across transitions.
    distinct_stacks_seen: u8,
    /// Last `ScopeStack` for which injection selectors were evaluated.
    last_selector_stack: Option<Arc<crate::theme::ScopeStack>>,
    /// Number of leading entries in `grammar.injections()` whose selectors
    /// completed evaluation for `last_selector_stack`.
    last_selector_evaluated: usize,
    /// Indices `< last_selector_evaluated` whose selectors matched
    /// `last_selector_stack`, in upstream order.
    last_matched_injections: Vec<usize>,
    /// Retains the previous `ScopeStack` chain so every node address stored in
    /// `node_ptrs` and `ptr_to_index` stays alive (preventing pointer reuse /
    /// ABA) while comparing against the next `ScopeStack`.
    scope_path: Option<Arc<crate::theme::ScopeStack>>,
    /// Parallel root-to-leaf node addresses (`Arc::as_ptr(node) as usize`) for
    /// `segments`.
    node_ptrs: Vec<usize>,
    /// Persistent reverse index from node address to index in `node_ptrs`.
    /// Empty until the first deep (>16-frame) divergence, then kept in exact
    /// sync on every push/pop/replace/truncate so repeated deep capture
    /// transitions never rebuild the map.
    ptr_to_index: std::collections::HashMap<usize, usize>,
    segments: Vec<Arc<str>>,
}

impl InjectionScopeCache {
    #[cfg(test)]
    fn segments_for(
        &mut self,
        scope_path: &Arc<crate::theme::ScopeStack>,
        should_stop: &mut impl FnMut() -> bool,
    ) -> Option<&[Arc<str>]> {
        self.update_segments(scope_path, should_stop)
            .then_some(self.segments.as_slice())
    }

    fn update_segments(
        &mut self,
        scope_path: &Arc<crate::theme::ScopeStack>,
        should_stop: &mut impl FnMut() -> bool,
    ) -> bool {
        const STOP_CHECK_INTERVAL: usize = 64;
        const RECENT_WINDOW: usize = 16;

        let new_ptr = Arc::as_ptr(scope_path) as usize;
        let len = self.node_ptrs.len();

        // Fast path 1: unchanged scope stack.
        if len > 0 && self.node_ptrs[len - 1] == new_ptr {
            return true;
        }

        // Fast path 2: 1-level push onto the current stack.
        let parent_ptr = scope_path
            .parent
            .as_ref()
            .map(|parent| Arc::as_ptr(parent) as usize);
        if len > 0 && parent_ptr == Some(self.node_ptrs[len - 1]) {
            self.node_ptrs.push(new_ptr);
            self.segments.push(Arc::clone(&scope_path.scope_name));
            if !self.ptr_to_index.is_empty() {
                self.ptr_to_index.insert(new_ptr, len);
            }
            self.scope_path = Some(Arc::clone(scope_path));
            return true;
        }

        // Fast path 3: 1-level pop from the current stack.
        if len >= 2 && self.node_ptrs[len - 2] == new_ptr {
            if let Some(removed) = self.node_ptrs.pop() {
                self.segments.pop();
                if !self.ptr_to_index.is_empty() {
                    self.ptr_to_index.remove(&removed);
                }
            }
            self.scope_path = Some(Arc::clone(scope_path));
            return true;
        }

        // Fast path 4: 1-level sibling replacement at the same depth.
        if len >= 2 && parent_ptr == Some(self.node_ptrs[len - 2]) {
            let old_ptr = self.node_ptrs[len - 1];
            self.node_ptrs[len - 1] = new_ptr;
            self.segments[len - 1] = Arc::clone(&scope_path.scope_name);
            if !self.ptr_to_index.is_empty() {
                self.ptr_to_index.remove(&old_ptr);
                self.ptr_to_index.insert(new_ptr, len - 1);
            }
            self.scope_path = Some(Arc::clone(scope_path));
            return true;
        }

        // Initial population when cache is empty.
        if len == 0 {
            let mut item: Option<&Arc<crate::theme::ScopeStack>> = Some(scope_path);
            let mut steps: usize = 0;
            while let Some(node) = item {
                steps += 1;
                if steps & (STOP_CHECK_INTERVAL - 1) == 0 && should_stop() {
                    self.node_ptrs.clear();
                    self.segments.clear();
                    self.scope_path = None;
                    return false;
                }
                self.node_ptrs.push(Arc::as_ptr(node) as usize);
                self.segments.push(Arc::clone(&node.scope_name));
                item = node.parent.as_ref();
            }
            self.node_ptrs.reverse();
            self.segments.reverse();
            self.scope_path = Some(Arc::clone(scope_path));
            return true;
        }

        // General multi-level push/pop/divergence: walk up `scope_path` until
        // reaching a shared ancestor in `self.node_ptrs`, reusing the entire
        // shared prefix without cloning or dropping its `Arc<str>` segments.
        let window_start = len.saturating_sub(RECENT_WINDOW);
        let mut suffix: Vec<(usize, &Arc<str>)> = Vec::new();
        let mut shared_prefix_len = 0usize;
        let mut item: Option<&Arc<crate::theme::ScopeStack>> = Some(scope_path);
        let mut steps: usize = 0;

        while let Some(node) = item {
            steps += 1;
            if steps & (STOP_CHECK_INTERVAL - 1) == 0 && should_stop() {
                return false;
            }
            let ptr = Arc::as_ptr(node) as usize;
            let matched_index = if !self.ptr_to_index.is_empty() {
                self.ptr_to_index.get(&ptr).copied()
            } else if steps == 1 {
                self.node_ptrs.iter().rposition(|&cached| cached == ptr)
            } else if let Some(offset) = self.node_ptrs[window_start..]
                .iter()
                .rposition(|&cached| cached == ptr)
            {
                Some(window_start + offset)
            } else if steps >= RECENT_WINDOW && window_start > 0 {
                self.ptr_to_index.reserve(len);
                for (index, &cached) in self.node_ptrs.iter().enumerate() {
                    if (index + 1) & (STOP_CHECK_INTERVAL - 1) == 0 && should_stop() {
                        self.ptr_to_index.clear();
                        return false;
                    }
                    self.ptr_to_index.insert(cached, index);
                }
                self.ptr_to_index.get(&ptr).copied()
            } else {
                None
            };
            if let Some(index) = matched_index {
                shared_prefix_len = index + 1;
                break;
            }
            suffix.push((ptr, &node.scope_name));
            item = node.parent.as_ref();
        }

        if !self.ptr_to_index.is_empty() {
            if shared_prefix_len == 0 {
                self.ptr_to_index.clear();
            } else {
                for (step, &removed) in self.node_ptrs[shared_prefix_len..].iter().enumerate() {
                    if step & (STOP_CHECK_INTERVAL - 1) == STOP_CHECK_INTERVAL - 1 && should_stop()
                    {
                        self.scope_path = None;
                        self.node_ptrs.clear();
                        self.segments.clear();
                        self.ptr_to_index.clear();
                        return false;
                    }
                    self.ptr_to_index.remove(&removed);
                }
            }
        }
        self.node_ptrs.truncate(shared_prefix_len);
        self.segments.truncate(shared_prefix_len);
        let update_index = !self.ptr_to_index.is_empty();
        for (step, (ptr, scope_name)) in suffix.into_iter().rev().enumerate() {
            if step & (STOP_CHECK_INTERVAL - 1) == STOP_CHECK_INTERVAL - 1 && should_stop() {
                self.scope_path = None;
                self.node_ptrs.clear();
                self.segments.clear();
                self.ptr_to_index.clear();
                return false;
            }
            let index = self.node_ptrs.len();
            self.node_ptrs.push(ptr);
            self.segments.push(Arc::clone(scope_name));
            if update_index {
                self.ptr_to_index.insert(ptr, index);
            }
        }
        self.scope_path = Some(Arc::clone(scope_path));
        true
    }
}

struct MatchResult {
    matched: FindNextMatchResult<RuleScannerId>,
    priority_match: bool,
}

#[allow(clippy::too_many_arguments)]
fn match_rule_or_injections<G: TokenizerGrammar>(
    grammar: &G,
    line_text: &OnigString,
    is_first_line: bool,
    line_pos: usize,
    stack: &Arc<StateStack>,
    anchor_position: isize,
    injection_cache: &mut InjectionScopeCache,
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
        injection_cache,
        deadline,
    )?;
    let Some(injection_result) = injection_result else {
        return Ok(match_result);
    };
    let Some(match_result) = match_result else {
        return Ok(Some(injection_result));
    };
    let match_score = match_result.matched.captures()[0].start;
    let injection_score = injection_result.matched.captures()[0].start;
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
            matched,
            priority_match: false,
        }))
}

#[allow(clippy::too_many_arguments)]
fn match_injections<G: TokenizerGrammar>(
    grammar: &G,
    line_text: &OnigString,
    is_first_line: bool,
    line_pos: usize,
    stack: &Arc<StateStack>,
    anchor_position: isize,
    injection_cache: &mut InjectionScopeCache,
    deadline: Option<Instant>,
) -> Result<Option<MatchResult>, RegexError> {
    let scope_path = &stack
        .content_name_scopes_list
        .as_ref()
        .expect("grammar state must have content-name scopes")
        .scope_path;
    let injections = grammar.injections();
    let mut best: Option<(usize, FindNextMatchResult<RuleScannerId>, MatcherPriority)> = None;

    // Fast path: unchanged `ScopeStack` replays cached matching injection
    // indices without re-walking the scope chain or re-evaluating selectors.
    if injection_cache
        .last_selector_stack
        .as_ref()
        .is_some_and(|cached| Arc::ptr_eq(cached, scope_path))
    {
        if deadline_exceeded(deadline) {
            return Ok(None);
        }
        let mut hit_line_pos = false;
        for &index in &injection_cache.last_matched_injections {
            if deadline_exceeded(deadline) {
                return Ok(None);
            }
            let injection = &injections[index];
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
            let Some(matched) =
                scanner.find_next_match(line_text, line_pos, ScannerFindOptions::NONE)
            else {
                continue;
            };
            let rating = matched.captures()[0].start;
            if best
                .as_ref()
                .is_some_and(|(best_rating, _, _)| rating >= *best_rating)
            {
                continue;
            }
            best = Some((rating, matched, injection.priority));
            if rating == line_pos {
                hit_line_pos = true;
                break;
            }
        }
        if hit_line_pos || injection_cache.last_selector_evaluated >= injections.len() {
            return Ok(best.map(|(_, matched, priority)| MatchResult {
                matched,
                priority_match: priority == MatcherPriority::Left,
            }));
        }
        // Previous scan on this stack stopped early at `rating == line_pos`;
        // evaluate only the remaining tail selectors.
        if injection_cache.node_ptrs.is_empty() {
            let Some(borrowed_scopes) =
                collect_borrowed_segments_with_stop(scope_path, &mut || {
                    deadline_exceeded(deadline)
                })
            else {
                return Ok(None);
            };
            return match_injections_tail(
                grammar,
                line_text,
                is_first_line,
                line_pos,
                anchor_position,
                borrowed_scopes.as_slice(),
                best,
                &mut injection_cache.last_selector_evaluated,
                &mut injection_cache.last_matched_injections,
                deadline,
            );
        }
        return match_injections_tail(
            grammar,
            line_text,
            is_first_line,
            line_pos,
            anchor_position,
            &injection_cache.segments,
            best,
            &mut injection_cache.last_selector_evaluated,
            &mut injection_cache.last_matched_injections,
            deadline,
        );
    }

    // First scan of the line or changed scope stack: reset cached selector results.
    injection_cache.last_selector_stack = None;
    injection_cache.last_selector_evaluated = 0;
    injection_cache.last_matched_injections.clear();
    injection_cache.distinct_stacks_seen = injection_cache.distinct_stacks_seen.saturating_add(1);

    let result = if injection_cache.distinct_stacks_seen <= 2 {
        let Some(borrowed_scopes) =
            collect_borrowed_segments_with_stop(scope_path, &mut || deadline_exceeded(deadline))
        else {
            return Ok(None);
        };
        match_injections_tail(
            grammar,
            line_text,
            is_first_line,
            line_pos,
            anchor_position,
            borrowed_scopes.as_slice(),
            None,
            &mut injection_cache.last_selector_evaluated,
            &mut injection_cache.last_matched_injections,
            deadline,
        )?
    } else {
        if !injection_cache.update_segments(scope_path, &mut || deadline_exceeded(deadline)) {
            return Ok(None);
        }
        match_injections_tail(
            grammar,
            line_text,
            is_first_line,
            line_pos,
            anchor_position,
            &injection_cache.segments,
            None,
            &mut injection_cache.last_selector_evaluated,
            &mut injection_cache.last_matched_injections,
            deadline,
        )?
    };
    if injection_cache.last_selector_evaluated > 0 {
        injection_cache.last_selector_stack = Some(Arc::clone(scope_path));
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn match_injections_tail<G: TokenizerGrammar, S: AsRef<str>>(
    grammar: &G,
    line_text: &OnigString,
    is_first_line: bool,
    line_pos: usize,
    anchor_position: isize,
    scope_slice: &[S],
    mut best: Option<(usize, FindNextMatchResult<RuleScannerId>, MatcherPriority)>,
    evaluated_count: &mut usize,
    matched_indices: &mut Vec<usize>,
    deadline: Option<Instant>,
) -> Result<Option<MatchResult>, RegexError> {
    let start = *evaluated_count;
    for (offset, injection) in grammar.injections()[start..].iter().enumerate() {
        let index = start + offset;
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
        if selector_matched {
            matched_indices.push(index);
        }
        *evaluated_count = index + 1;
        if !selector_matched {
            continue;
        }
        if deadline_exceeded(deadline) {
            return Ok(None);
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
        let rating = matched.captures()[0].start;
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
        matched,
        priority_match: priority == MatcherPriority::Left,
    }))
}

fn handle_captures<G: TokenizerGrammar>(
    ctx: &mut TokenizeContext<'_, '_, G>,
    span: &MatchedSpan<'_>,
    capture_stack: &mut Option<Arc<StateStack>>,
    mut make_capture_stack: impl FnMut() -> Arc<StateStack>,
    base_scopes: &Arc<AttributedScopeStack>,
    captures: &[(usize, Arc<CaptureRule>)],
) -> Result<bool, RegexError> {
    if captures.is_empty() {
        return Ok(false);
    }
    let line_text_content = span.line_text.content();
    let capture_count = span.captures.len();
    let mut local_stack: Vec<LocalStackElement> = Vec::new();
    let max_end = span.captures.get(&ctx.capture_pool, 0).end;

    for &(index, ref capture_rule) in captures {
        if deadline_exceeded(ctx.deadline) {
            return Ok(true);
        }
        if index >= capture_count {
            break;
        }
        let capture_index = span.captures.get(&ctx.capture_pool, index);
        let capture_start = capture_index.start;
        let capture_end = capture_index.end;
        let capture_length = capture_index.length;
        if capture_length == 0 {
            continue;
        }
        if capture_start > max_end {
            break;
        }

        while local_stack
            .last()
            .is_some_and(|local| local.end_pos <= capture_start)
        {
            if deadline_exceeded(ctx.deadline) {
                return Ok(true);
            }
            let local = local_stack
                .pop()
                .expect("checked local capture stack must be nonempty");
            produce_from_scopes(
                Some(&local.scopes),
                local.end_pos,
                ctx.line_tokens,
                ctx.line_fonts,
            );
        }
        if let Some(local) = local_stack.last() {
            produce_from_scopes(
                Some(&local.scopes),
                capture_start,
                ctx.line_tokens,
                ctx.line_fonts,
            );
        } else {
            produce_from_scopes(
                Some(base_scopes),
                capture_start,
                ctx.line_tokens,
                ctx.line_fonts,
            );
        }

        if let Some(retokenize_rule_id) = capture_rule.retokenize_captured_with_rule_id {
            if span.capture_depth >= MAX_CAPTURE_RETOKENIZE_DEPTH {
                return Err(RegexError::depth_limit(
                    "capture retokenization depth limit exceeded",
                ));
            }
            let capture_slice = span.capture_indices(&ctx.capture_pool);
            let scope_name = capture_rule.resolved_name(
                Some(line_text_content),
                Some(capture_slice),
                span.line_is_ascii,
            );
            let name_scopes_list = base_scopes.push_resolved(scope_name, ctx.grammar);
            let content_name = capture_rule.resolved_content_name(
                line_text_content,
                capture_slice,
                span.line_is_ascii,
            );
            let content_name_scopes_list =
                name_scopes_list.push_resolved(content_name, ctx.grammar);
            let retokenize_parent = capture_stack.get_or_insert_with(&mut make_capture_stack);
            let stack_clone = retokenize_parent.push_with_theme_id(
                retokenize_rule_id,
                ctx.grammar.theme_id(),
                capture_start as isize,
                -1,
                false,
                None,
                Some(name_scopes_list),
                Some(content_name_scopes_list),
            );
            let prefix = utf16_prefix(line_text_content, capture_end, span.line_is_ascii);
            let substring = OnigString::new(prefix);
            let substring_len = substring.utf16_len();
            let substring_is_ascii = substring.content().len() == substring_len;
            let retokenized = tokenize_string_loop(
                ctx,
                &substring,
                substring_is_ascii,
                substring_len,
                span.is_first_line && capture_start == 0,
                capture_start,
                -1,
                stack_clone,
                span.capture_depth + 1,
            )?;
            if retokenized.stopped_early || deadline_exceeded(ctx.deadline) {
                return Ok(true);
            }
            continue;
        }

        let capture_scope_name = capture_rule.resolved_name(
            Some(line_text_content),
            Some(span.capture_indices(&ctx.capture_pool)),
            span.line_is_ascii,
        );
        if let Some(capture_scope_name) = capture_scope_name {
            let base = local_stack
                .last()
                .map_or(base_scopes, |local| &local.scopes);
            let capture_scopes = base.push_resolved(Some(capture_scope_name), ctx.grammar);
            local_stack.push(LocalStackElement {
                scopes: capture_scopes,
                end_pos: capture_end,
            });
        }
    }

    while let Some(local) = local_stack.pop() {
        if deadline_exceeded(ctx.deadline) {
            return Ok(true);
        }
        produce_from_scopes(
            Some(&local.scopes),
            local.end_pos,
            ctx.line_tokens,
            ctx.line_fonts,
        );
    }
    Ok(deadline_exceeded(ctx.deadline))
}

struct LocalStackElement {
    scopes: Arc<AttributedScopeStack>,
    end_pos: usize,
}

fn produce(
    stack: &StateStack,
    end_index: usize,
    line_tokens: &mut LineTokens<'_>,
    line_fonts: &mut LineFonts,
) {
    line_tokens.produce(stack, end_index);
    line_fonts.produce(stack, end_index);
}

fn produce_from_scopes(
    scopes: Option<&Arc<AttributedScopeStack>>,
    end_index: usize,
    line_tokens: &mut LineTokens<'_>,
    line_fonts: &mut LineFonts,
) {
    line_tokens.produce_from_scopes(scopes, end_index);
    line_fonts.produce_from_scopes(scopes, end_index);
}

#[derive(Debug, PartialEq)]
#[allow(
    clippy::large_enum_variant,
    reason = "stack-allocated inline buffer avoids heap allocation for ordinary scope depths <= 32"
)]
enum BorrowedScopes<'a> {
    Inline { buf: [&'a str; 32], len: usize },
    Heap(Vec<&'a str>),
}

impl<'a> BorrowedScopes<'a> {
    fn as_slice(&self) -> &[&'a str] {
        match self {
            Self::Inline { buf, len } => &buf[..*len],
            Self::Heap(vec) => vec.as_slice(),
        }
    }
}

impl<'a> std::ops::Deref for BorrowedScopes<'a> {
    type Target = [&'a str];

    fn deref(&self) -> &Self::Target {
        self.as_slice()
    }
}

fn collect_borrowed_segments_with_stop<'a>(
    scope_path: &'a crate::theme::ScopeStack,
    should_stop: &mut impl FnMut() -> bool,
) -> Option<BorrowedScopes<'a>> {
    const STOP_CHECK_INTERVAL: usize = 64;
    const INLINE_CAP: usize = 32;
    let mut item = Some(scope_path);
    let mut inline_buf = [""; INLINE_CAP];
    let mut inline_len = 0usize;
    let mut heap: Option<Vec<&'a str>> = None;
    let mut steps: usize = 0;
    while let Some(scope) = item {
        steps += 1;
        if steps & (STOP_CHECK_INTERVAL - 1) == 0 && should_stop() {
            return None;
        }
        let name: &'a str = &scope.scope_name;
        if let Some(vec) = heap.as_mut() {
            vec.push(name);
        } else if inline_len < INLINE_CAP {
            inline_buf[inline_len] = name;
            inline_len += 1;
        } else {
            let mut vec = Vec::with_capacity(INLINE_CAP * 2);
            vec.extend_from_slice(&inline_buf);
            vec.push(name);
            heap = Some(vec);
        }
        item = scope.parent.as_deref();
    }
    if let Some(mut vec) = heap {
        vec.reverse();
        Some(BorrowedScopes::Heap(vec))
    } else {
        inline_buf[..inline_len].reverse();
        Some(BorrowedScopes::Inline {
            buf: inline_buf,
            len: inline_len,
        })
    }
}

fn matches_scope_identifiers_with_stop<S: AsRef<str>>(
    identifiers: &[String],
    scopes: &&[S],
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
            let scope = scope.as_ref();
            if scope == identifier
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

fn utf16_prefix(value: &str, end: usize, is_ascii: bool) -> &str {
    if is_ascii {
        return &value[..end.min(value.len())];
    }
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
                .get_name::<crate::regexp::ScannerCaptureIndex>(None, None)
                .unwrap_or(std::borrow::Cow::Borrowed("unknown"));
            let scopes = AttributedScopeStack::create_root_and_lookup_scope_name(
                root_name.as_ref(),
                metadata,
                font,
                self,
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
        let mut tokens = LineTokens::new(false, &line, &[], None);
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
        let mut tokens = LineTokens::new(false, line, &[], None);
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
            let mut tokens = LineTokens::new(true, &line_text, &[], None);
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
        let mut tokens = LineTokens::new(true, line_text, &[], None);
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

    #[test]
    fn caps_recursive_capture_retokenization_depth_within_384kib_debug_stack() {
        let handle = std::thread::Builder::new()
            .name("capture-depth-384kib".to_owned())
            .stack_size(384 * 1024)
            .spawn(|| {
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
                let mut tokens = LineTokens::new(true, line_text, &[], None);
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
                .expect("self-recursive capture retokenization must return depth limit error");
                assert!(err.to_string().contains("depth limit"));
            })
            .expect("worker thread with 384 KiB stack should spawn");
        handle
            .join()
            .expect("recursive capture retokenization must stay within 384 KiB debug stack");
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
        let mut tokens = LineTokens::new(false, &line_text, &[], None);
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
        let mut tokens = LineTokens::new(false, line_text, &[], None);
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
        let mut tokens = LineTokens::new(false, line_text, &[], None);
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
        let mut tokens = LineTokens::new(false, line_text, &[], None);
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
        let mut tokens = LineTokens::new(false, line_text, &[], None);
        let mut fonts = LineFonts::new();

        // Checks before flushing local_stack in handle_captures:
        // 1: entry check, 2: match_rule pre-search check,
        // 3: after match_rule_or_injections, 4: handle_captures loop start for
        // capture 1, 5: local_stack flush check.
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
        let mut tokens = LineTokens::new(false, line_text, &[], None);
        let mut fonts = LineFonts::new();

        // Checks before periodic poll inside matches_scope_identifiers_with_stop:
        // 1: entry check, 2: match_rule after fresh compile, 3: match_rule_or_injections,
        // 4..6: 3 periodic polls collecting 201 scopes,
        // 7: match_injections loop start, 8: first periodic poll at step 64.
        let guard = ExpireAfterDeadlineChecks::new(8);
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
        let mut tokens = LineTokens::new(false, line_text, &[], None);
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
        let mut tokens = LineTokens::new(false, line_text, &[], None);
        let mut fonts = LineFonts::new();
        let expired = Instant::now().checked_sub(Duration::from_secs(1));

        let base_scopes = stack.content_name_scopes_list.as_ref().unwrap();
        let captures = matched.captures();
        let mut ctx = super::TokenizeContext {
            grammar: &grammar,
            line_tokens: &mut tokens,
            line_fonts: &mut fonts,
            injection_cache: super::InjectionScopeCache::default(),
            capture_pool: super::CapturePool::default(),
            deadline: expired,
        };
        let step_captures = ctx.capture_pool.push_slice(captures);
        let span = super::MatchedSpan {
            line_text: &onig,
            line_is_ascii: onig.content().len() == onig.utf16_len(),
            line_length: onig.utf16_len(),
            is_first_line: true,
            line_pos: 0,
            has_advanced: captures[0].end > 0,
            match_start: captures[0].start,
            match_end: captures[0].end,
            captures: step_captures,
            capture_depth: 0,
        };
        let mut capture_stack = None;
        let stopped = super::handle_captures(
            &mut ctx,
            &span,
            &mut capture_stack,
            || Arc::clone(&stack),
            base_scopes,
            &match_rule.captures,
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
        let mut tokens = LineTokens::new(false, line_text, &[], None);
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
        let mut heavy_tokens = LineTokens::new(false, &heavy_line, &[], None);
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
        let mut tokens = LineTokens::new(false, line, &[], None);
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
        let mut tokens = LineTokens::new(false, line_text, &[], None);
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

    #[test]
    fn earlier_non_left_injection_short_circuits_before_later_invalid_injection() {
        let mut grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "<",
                    "end": ">",
                    "name": "meta.tag"
                }]
            }"#,
        );
        let first_rule_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("injected.first".to_owned()),
                ">",
                Vec::new(),
            ))
        });
        let invalid_rule_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("injected.invalid".to_owned()),
                "(",
                Vec::new(),
            ))
        });
        let mut injections = Injection::from_selector("R:meta.tag", first_rule_id).unwrap();
        injections.extend(Injection::from_selector("R:meta.tag", invalid_rule_id).unwrap());
        grammar.injections = injections;

        // Inside `meta.tag` at `line_pos = 1`, the first R: injection matches `>`
        // at `line_pos` and short-circuits before the later invalid injection is
        // compiled; primary `End` wins the tie and pops `meta.tag`.
        let (tokens, result) = tokenize_line(&grammar, "<>", None);
        assert!(!result.stopped_early);
        assert_eq!(result.stack.depth, 1);
        assert_eq!(tokens[0].scopes, ["source.test", "meta.tag"]);
    }

    #[test]
    fn keeps_non_left_injection_with_keep_reset_in_lookbehind() {
        let mut grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "<",
                    "end": ">",
                    "name": "meta.tag"
                }]
            }"#,
        );
        let inj_rule_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("injected.keep".to_owned()),
                r"(?<=\K<)>",
                Vec::new(),
            ))
        });
        grammar.injections = Injection::from_selector("R:meta.tag", inj_rule_id).unwrap();

        let (tokens, result) = tokenize_line(&grammar, "<>", None);
        assert!(!result.stopped_early);
        assert!(
            tokens
                .iter()
                .any(|token| token.scopes.iter().any(|scope| scope == "injected.keep")),
            "R: injection using \\K inside lookbehind must still run and beat primary End at line_pos; got {tokens:?}"
        );
    }

    #[test]
    fn preserves_injection_order_when_earlier_non_left_blocks_later_keep_reset() {
        let mut grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "<",
                    "end": ">",
                    "name": "meta.tag"
                }]
            }"#,
        );
        let first_rule_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("injected.at_pos".to_owned()),
                ">",
                Vec::new(),
            ))
        });
        let keep_rule_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("injected.keep".to_owned()),
                r"(?<=\K<)>",
                Vec::new(),
            ))
        });
        let mut injections = Injection::from_selector("R:meta.tag", first_rule_id).unwrap();
        injections.extend(Injection::from_selector("R:meta.tag", keep_rule_id).unwrap());
        grammar.injections = injections;

        // Earlier R: injection matches `>` at `line_pos = 1` and short-circuits
        // before the later `\K` injection runs, so primary `End` wins at `pos = 1`
        // and closes `meta.tag` back to depth 1.
        let (tokens, result) = tokenize_line(&grammar, "<>", None);
        assert!(!result.stopped_early);
        assert_eq!(result.stack.depth, 1);
        assert!(
            !tokens
                .iter()
                .any(|token| token.scopes.iter().any(|scope| scope == "injected.keep")),
            "earlier non-left injection at line_pos must short-circuit before later \\K injection; got {tokens:?}"
        );
    }

    #[test]
    fn surfaces_regex_error_from_matching_non_left_injection_even_at_line_pos() {
        let mut grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "x", "name": "primary.x" }]
            }"#,
        );
        let bad_rule_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("injected.broken".to_owned()),
                "(",
                Vec::new(),
            ))
        });
        grammar.injections = Injection::from_selector("R:source.test", bad_rule_id).unwrap();

        let line = "x\n";
        let onig = crate::OnigString::new(line);
        let state = grammar.initial_state();
        let mut tokens = LineTokens::new(false, line, &[], None);
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
        .expect("applicable R: injection with invalid regex must still return RegexError");
        assert!(!err.to_string().is_empty());
    }

    #[test]
    fn rechecks_deadline_after_injection_selector_evaluation() {
        let mut grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "x", "name": "primary.x" }]
            }"#,
        );
        let inj_rule_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("injected.x".to_owned()),
                "x",
                Vec::new(),
            ))
        });
        grammar.injections = Injection::from_selector("L:source.test", inj_rule_id).unwrap();

        // Warm up both primary and injection scanners so both are cached hits.
        let _ = tokenize_line(&grammar, "x", None);

        let line = "x\n";
        let onig = crate::OnigString::new(line);
        let state = grammar.initial_state();
        let mut tokens = LineTokens::new(false, line, &[], None);
        let mut fonts = LineFonts::new();

        // Warm cached checks:
        // 1: loop start -> passes
        // 2: match_rule pre-search -> passes, runs primary scanner (call #1)
        // 3: match_rule_or_injections -> passes
        // 4: match_injections loop start -> passes, evaluates selector
        // 5: post-selector deadline check -> EXPIRES before cached injection scanner runs!
        let guard = ExpireAfterDeadlineChecks::new(5);
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
        assert_eq!(
            calls, 1,
            "cached injection scanner must not run after deadline expires during selector evaluation"
        );
    }

    #[test]
    fn rechecks_deadline_after_contended_cached_scanner_lock_wait() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc;

        let grammar = Arc::new(TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "foo", "name": "keyword.foo" }]
            }"#,
        ));
        // Warm up the scanner so `compile_ag_with_status` takes the cache-hit path.
        let _ = tokenize_line(&grammar, "foo", None);

        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let holder_grammar = Arc::clone(&grammar);
        let holder = std::thread::spawn(move || {
            let guard = holder_grammar
                .registry
                .get_rule(holder_grammar.root_id)
                .lock_cached_patterns_for_test();
            locked_tx.send(()).unwrap();
            // Hold deterministically until the caller observes `WouldBlock`.
            release_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("caller must signal contention before timeout");
            drop(guard);
        });

        locked_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("holder thread must acquire pattern cache lock before timeout");
        let saw_contention = Arc::new(AtomicBool::new(false));
        let hook_saw_contention = Arc::clone(&saw_contention);
        let contention_hook = crate::rule::PatternCacheContentionHookGuard::install(move || {
            hook_saw_contention.store(true, Ordering::SeqCst);
            let _ = release_tx.send(());
        });

        let line = "foo\n";
        let onig = crate::OnigString::new(line);
        let state = grammar.initial_state();
        let mut tokens = LineTokens::new(false, line, &[], None);
        let mut fonts = LineFonts::new();

        // Check #1 (loop top) passes -> enters `compile_ag_with_status` ->
        // hits `WouldBlock` (sets `maybe_blocked = true` and releases holder) ->
        // Check #2 (post-compile `maybe_blocked` check) expires before search!
        let deadline_guard = ExpireAfterDeadlineChecks::new(2);
        let result = tokenize_string(
            grammar.as_ref(),
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
        let calls = deadline_guard.calls();
        drop(deadline_guard);
        drop(contention_hook);
        holder.join().unwrap();

        assert!(
            saw_contention.load(Ordering::SeqCst),
            "test must deterministically exercise the contended try_lock WouldBlock path"
        );
        assert!(
            result.stopped_early,
            "deadline expiring while waiting on a contended rule mutex must stop early"
        );
        assert_eq!(
            calls, 0,
            "synchronous regex search must not start after contended mutex wait exceeded deadline"
        );
    }

    #[test]
    fn rechecks_deadline_after_cached_scanner_backtracking_warning_wait() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc;

        // Pattern with a nested quantifier so Ferroni emits a backtracking warning
        // and `record_backtracking_warnings_once` enters `OnceLock::get_or_init`.
        let grammar = Arc::new(TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "(a+)+b", "name": "keyword.backtrack" }]
            }"#,
        ));

        let (in_init_tx, in_init_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let init_grammar = Arc::clone(&grammar);
        let initializer = std::thread::spawn(move || {
            let _inside_hook =
                crate::regexp::BacktrackingInitHookGuard::on_inside_init(move || {
                    in_init_tx.send(()).unwrap();
                    release_rx
                        .recv_timeout(Duration::from_secs(5))
                        .expect("caller must enter OnceLock wait before timeout");
                });
            let _ = init_grammar
                .registry
                .get_rule(init_grammar.root_id)
                .compile_ag(&init_grammar.registry, None, true, true)
                .unwrap();
        });

        // Wait until thread 1 has cached the compiled scanner, released the
        // rule mutex, and is actively inside `OnceLock::get_or_init`.
        in_init_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("initializer thread must enter OnceLock::get_or_init before timeout");

        let saw_warning_wait = Arc::new(AtomicBool::new(false));
        let hook_saw_wait = Arc::clone(&saw_warning_wait);
        let before_hook = crate::regexp::BacktrackingInitHookGuard::on_before_init(move || {
            hook_saw_wait.store(true, Ordering::SeqCst);
            let _ = release_tx.send(());
        });

        let line = "ab\n";
        let onig = crate::OnigString::new(line);
        let state = grammar.initial_state();
        let mut tokens = LineTokens::new(false, line, &[], None);
        let mut fonts = LineFonts::new();

        // Check #1 (loop top) passes -> `compile_ag_with_status` hits the cached
        // scanner uncontended (`contended == false`, `fresh == false`), enters
        // `record_backtracking_warnings_once` while `OnceLock` is initializing
        // (`maybe_blocked = true`) -> Check #2 expires before `find_next_match`!
        let deadline_guard = ExpireAfterDeadlineChecks::new(2);
        let result = tokenize_string(
            grammar.as_ref(),
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
        let calls = deadline_guard.calls();
        drop(deadline_guard);
        drop(before_hook);
        initializer.join().unwrap();

        assert!(
            saw_warning_wait.load(Ordering::SeqCst),
            "test must deterministically exercise OnceLock wait on cached scanner warnings"
        );
        assert!(
            result.stopped_early,
            "deadline expiring while waiting on backtracking warning OnceLock must stop early"
        );
        assert_eq!(
            calls, 0,
            "synchronous regex search must not start after OnceLock warning wait exceeded deadline"
        );
    }

    #[test]
    fn tokenizes_deferred_oversized_static_scope_name_identically() {
        let segments: Vec<String> = (0..25)
            .map(|i| format!("scope.long.segment{i:02}"))
            .collect();
        let long_scope_name = segments.join(" ");
        assert!(long_scope_name.len() > 256);
        let raw = format!(
            r#"{{
                "scopeName": "source.test",
                "patterns": [{{ "match": "tok", "name": "{long_scope_name}" }}]
            }}"#
        );
        let grammar = TestGrammar::new(&raw);
        let (tokens, _) = tokenize_line(&grammar, "tok", None);
        let mut expected = vec!["source.test".to_owned()];
        expected.extend(segments);
        assert_eq!(tokens[0].scopes, expected);
    }

    #[test]
    fn stops_before_next_scanner_call_when_deadline_expires_during_token_processing() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "[a-z]+", "name": "word.test" }]
            }"#,
        );
        // Warm up scanner so cached compile_ag skips the post-compile check.
        let _ = tokenize_line(&grammar, "foo bar", None);

        let line_text = "foo bar\n";
        let onig = crate::OnigString::new(line_text);
        let state = grammar.initial_state();
        let mut tokens = LineTokens::new(false, line_text, &[], None);
        let mut fonts = LineFonts::new();

        // Checks on a warm, non-injection grammar with check_while_conditions=false:
        // 1: loop start (iter 1) -> passes,
        // 2: match_rule pre-search (iter 1) -> passes, runs scanner call #1 ("foo"),
        // 3: after match_rule_or_injections (iter 1) -> passes, processes "foo" scopes/tokens,
        // 4: loop start (iter 2) -> EXPIRES before scanner call #2 ("bar") can run!
        let guard = ExpireAfterDeadlineChecks::new(4);
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
        assert_eq!(
            calls, 1,
            "second synchronous regex search must not start after deadline expires during token processing"
        );
    }

    #[test]
    fn preserves_anchor_and_end_capture_semantics_without_throwaway_stacks() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "(<)([a-z]+)>",
                    "beginCaptures": {
                        "1": { "name": "punctuation.open" },
                        "2": { "name": "entity.tag" }
                    },
                    "end": "(</\\2>)",
                    "endCaptures": {
                        "1": { "name": "punctuation.close" }
                    },
                    "name": "meta.element",
                    "contentName": "meta.element.body",
                    "patterns": [{
                        "match": "\\Gbody",
                        "name": "keyword.anchored"
                    }]
                }]
            }"#,
        );

        let (tokens, result) = tokenize_line(&grammar, "<div>body</div>", None);
        assert!(!result.stopped_early);
        assert_eq!(result.stack.depth, 1);
        assert_eq!(
            tokens
                .iter()
                .map(|t| (t.start_index, t.end_index, t.scopes.clone()))
                .collect::<Vec<_>>(),
            vec![
                (
                    0,
                    1,
                    vec![
                        "source.test".into(),
                        "meta.element".into(),
                        "punctuation.open".into(),
                    ],
                ),
                (
                    1,
                    4,
                    vec![
                        "source.test".into(),
                        "meta.element".into(),
                        "entity.tag".into(),
                    ],
                ),
                (4, 5, vec!["source.test".into(), "meta.element".into()]),
                (
                    5,
                    9,
                    vec![
                        "source.test".into(),
                        "meta.element".into(),
                        "meta.element.body".into(),
                        "keyword.anchored".into(),
                    ],
                ),
                (
                    9,
                    15,
                    vec![
                        "source.test".into(),
                        "meta.element".into(),
                        "punctuation.close".into(),
                    ],
                ),
            ]
        );
    }

    #[test]
    fn rechecks_deadline_after_cached_dynamic_while_pattern_comparison() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "^(>)",
                    "while": "^\\1",
                    "name": "markup.quote",
                    "patterns": [{ "match": ".", "name": "quote.body" }]
                }]
            }"#,
        );

        let (_, first) = tokenize_line(&grammar, ">one", None);
        assert_eq!(first.stack.depth, 2);
        // Warm up the cached dynamic `while` scanner so the next line takes the cache-hit path.
        let (_, second) = tokenize_line(&grammar, ">two", Some(first.stack));
        assert_eq!(second.stack.depth, 2);

        // Next line does NOT start with `>`; if `find_next_match` ran it would pop the frame.
        let line = "nope\n";
        let onig = crate::OnigString::new(line);
        let mut tokens = LineTokens::new(false, line, &[], None);
        let mut fonts = LineFonts::new();

        // Check #1 (while loop top) passes -> `compile_while_ag_and_record_with_status`
        // compares the cached dynamic `while` pattern (`maybe_blocked = true`) ->
        // Check #2 expires before `find_next_match` runs!
        let guard = ExpireAfterDeadlineChecks::new(2);
        let result = tokenize_string(
            &grammar,
            &onig,
            false,
            0,
            second.stack,
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
            "deadline expiring after cached dynamic while pattern comparison must stop early"
        );
        assert_eq!(
            calls, 0,
            "while scanner must not run after deadline expires during dynamic pattern comparison"
        );
        assert_eq!(
            result.stack.depth, 2,
            "continuation while frame must be retained when stopping before while search"
        );
    }

    #[test]
    fn rechecks_deadline_after_cached_dynamic_end_pattern_comparison() {
        let grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{
                    "begin": "(<)",
                    "end": "\\1",
                    "name": "meta.block",
                    "patterns": []
                }]
            }"#,
        );

        let (_, first) = tokenize_line(&grammar, "<open", None);
        assert_eq!(first.stack.depth, 2);
        // Warm up the cached dynamic `end` scanner so the next line takes the cache-hit path.
        let (_, second) = tokenize_line(&grammar, "still inside", Some(first.stack));
        assert_eq!(second.stack.depth, 2);

        let line = "<\n";
        let onig = crate::OnigString::new(line);
        let mut tokens = LineTokens::new(false, line, &[], None);
        let mut fonts = LineFonts::new();

        // Check #1 (main loop top) passes -> `compile_ag_with_status` compares the
        // cached dynamic `end` pattern (`maybe_blocked = true`) -> Check #2 expires
        // before `find_next_match` runs!
        let guard = ExpireAfterDeadlineChecks::new(2);
        let result = tokenize_string(
            &grammar,
            &onig,
            false,
            0,
            second.stack,
            &mut tokens,
            &mut fonts,
            false,
            60_000,
        )
        .unwrap();
        let calls = guard.calls();
        drop(guard);

        assert!(
            result.stopped_early,
            "deadline expiring after cached dynamic end pattern comparison must stop early"
        );
        assert_eq!(
            calls, 0,
            "end scanner must not run after deadline expires during dynamic pattern comparison"
        );
        assert_eq!(result.stack.depth, 2);
    }

    #[test]
    fn has_retokenize_captures_skips_unreachable_capture_entries() {
        let mut grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": []
            }"#,
        );
        let dummy_retokenize_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("inner.unreachable".to_owned()),
                "x",
                Vec::new(),
            ))
        });

        let mut captures = Vec::with_capacity(8_192);
        for index in 0..8_192usize {
            let retokenize = (index == 8_191).then_some(dummy_retokenize_id);
            let name = (index == 1).then(|| "capture.one".to_owned());
            let capture_id = grammar.registry.reserve_rule();
            let rule = Arc::new(crate::rule::CaptureRule::new(
                None, capture_id, name, None, retokenize,
            ));
            grammar
                .registry
                .set_rule(capture_id, Rule::Capture(Arc::clone(&rule)));
            captures.push((index, rule));
        }

        let match_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("outer.x".to_owned()),
                "(x)",
                captures,
            ))
        });

        // Verify `handle_captures` stops at unreachable entries without invoking
        // the lazy retokenize stack factory.
        let compiled = grammar
            .registry
            .get_rule(match_id)
            .compile_ag(&grammar.registry, None, true, true)
            .unwrap();
        let onig_one = crate::OnigString::new("x");
        let matched = compiled
            .find_next_match(&onig_one, 0, super::ScannerFindOptions::NONE)
            .unwrap();
        assert_eq!(matched.captures().len(), 2);
        let init_state = grammar.initial_state();
        let base_scopes = init_state.content_name_scopes_list.as_ref().unwrap();
        let mut cap_tokens = LineTokens::new(false, "x", &[], None);
        let mut cap_fonts = LineFonts::new();
        let captures = matched.captures();
        let mut ctx = super::TokenizeContext {
            grammar: &grammar,
            line_tokens: &mut cap_tokens,
            line_fonts: &mut cap_fonts,
            injection_cache: super::InjectionScopeCache::default(),
            capture_pool: super::CapturePool::default(),
            deadline: None,
        };
        let step_captures = ctx.capture_pool.push_slice(captures);
        let span = super::MatchedSpan {
            line_text: &onig_one,
            line_is_ascii: true,
            line_length: onig_one.utf16_len(),
            is_first_line: true,
            line_pos: 0,
            has_advanced: captures[0].end > 0,
            match_start: captures[0].start,
            match_end: captures[0].end,
            captures: step_captures,
            capture_depth: 0,
        };
        let mut lazy_stack = None;
        let mut factory_called = false;
        let stopped = super::handle_captures(
            &mut ctx,
            &span,
            &mut lazy_stack,
            || {
                factory_called = true;
                Arc::clone(&init_state)
            },
            base_scopes,
            &grammar
                .registry
                .get_rule(match_id)
                .as_match()
                .unwrap()
                .captures,
        )
        .unwrap();
        assert!(!stopped);
        assert!(
            !factory_called && lazy_stack.is_none(),
            "unreachable capture entries beyond capture_indices.len() must not allocate a retokenize stack"
        );

        let root_id = grammar.registry.register_rule(|id| {
            Rule::IncludeOnly(crate::rule::IncludeOnlyRule::new(
                None,
                id,
                Some("source.test".to_owned()),
                None,
                crate::rule::CompilePatternsResult {
                    patterns: vec![match_id],
                    has_missing_patterns: false,
                },
            ))
        });
        grammar.root_id = root_id;

        let line = "x".repeat(256);
        let (tokens, result) = tokenize_line(&grammar, &line, None);
        assert!(!result.stopped_early);
        assert_eq!(tokens.len(), 256);
        assert_eq!(tokens[0].scopes, ["source.test", "outer.x", "capture.one"]);
    }

    #[test]
    fn injection_scope_cache_reuses_shared_ancestors_across_transitions() {
        use crate::theme::ScopeStack;

        let mut chain: Vec<Arc<ScopeStack>> = Vec::with_capacity(64);
        let mut current = ScopeStack::push(None, ["source.root"]).unwrap();
        chain.push(Arc::clone(&current));
        for level in 1..64 {
            current = current.push_arc(Arc::from(format!("meta.level{level}")));
            chain.push(Arc::clone(&current));
        }

        let mut cache = super::InjectionScopeCache::default();
        let assert_matches = |cache: &mut super::InjectionScopeCache, target: &Arc<ScopeStack>| {
            let expected = target.get_segments();
            let cached = cache
                .segments_for(target, &mut || false)
                .expect("unstopped cache lookup must succeed");
            let actual: Vec<&str> = cached.iter().map(AsRef::as_ref).collect();
            let expected_refs: Vec<&str> = expected.iter().map(String::as_str).collect();
            assert_eq!(actual, expected_refs);
        };

        // Initial population at depth 64.
        assert_matches(&mut cache, &chain[63]);
        // Capture pointer identity of shared ancestor segment at level 30.
        let shared_30_ptr = Arc::as_ptr(&cache.segments[30]);

        // Unchanged fast path.
        assert_matches(&mut cache, &chain[63]);
        assert_eq!(Arc::as_ptr(&cache.segments[30]), shared_30_ptr);

        // 1-level push fast path.
        let pushed_one = chain[63].push_arc(Arc::from("keyword.pushed"));
        assert_matches(&mut cache, &pushed_one);
        assert_eq!(Arc::as_ptr(&cache.segments[30]), shared_30_ptr);

        // 1-level sibling replace fast path.
        let sibling_one = chain[63].push_arc(Arc::from("keyword.sibling"));
        assert_matches(&mut cache, &sibling_one);
        assert_eq!(Arc::as_ptr(&cache.segments[30]), shared_30_ptr);

        // 1-level pop fast path.
        assert_matches(&mut cache, &chain[63]);
        assert_eq!(Arc::as_ptr(&cache.segments[30]), shared_30_ptr);

        // Multi-level push (3 levels).
        let pushed_three = chain[63]
            .push_arc(Arc::from("meta.a"))
            .push_arc(Arc::from("meta.b"))
            .push_arc(Arc::from("meta.c"));
        assert_matches(&mut cache, &pushed_three);
        assert_eq!(Arc::as_ptr(&cache.segments[30]), shared_30_ptr);

        // Deep multi-level pop (> 16 levels, down to level 30).
        assert_matches(&mut cache, &chain[30]);
        assert_eq!(Arc::as_ptr(&cache.segments[30]), shared_30_ptr);

        // Deep multi-level divergence (> 16 levels pushed from level 30, then
        // jumping back to depth 63 which diverges at level 30).
        let mut branch = Arc::clone(&chain[30]);
        for i in 0..24 {
            branch = branch.push_arc(Arc::from(format!("branch.deep{i}")));
        }
        assert_matches(&mut cache, &branch);
        assert_eq!(Arc::as_ptr(&cache.segments[30]), shared_30_ptr);

        assert_matches(&mut cache, &chain[63]);
        assert_eq!(Arc::as_ptr(&cache.segments[30]), shared_30_ptr);

        // Completely disjoint root stack replaces everything cleanly.
        let disjoint = ScopeStack::push(None, ["text.plain", "meta.other"]).unwrap();
        assert_matches(&mut cache, &disjoint);
        assert_eq!(cache.segments.len(), 2);
    }

    #[test]
    fn single_scan_injection_line_avoids_populating_owned_scope_cache() {
        let mut grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "x", "name": "keyword.x" }]
            }"#,
        );
        grammar.add_left_injection("y", "injected.y");

        let initial = grammar.initial_state();
        let mut scopes = Arc::clone(initial.content_name_scopes_list.as_ref().unwrap());
        for level in 0..32 {
            scopes = scopes.push_attributed(Some(&format!("meta.deep{level}")), &grammar);
        }
        let deep_state = initial.push(
            grammar.root_id,
            0,
            -1,
            false,
            None,
            Some(Arc::clone(&scopes)),
            Some(scopes),
        );

        let line = "z\n";
        let onig = crate::OnigString::new(line);
        let mut cache = super::InjectionScopeCache::default();

        // First distinct stack uses borrowed `&str` scopes and leaves the owned cache empty.
        let first =
            super::match_injections(&grammar, &onig, true, 0, &deep_state, -1, &mut cache, None)
                .unwrap();
        assert!(first.is_none());
        assert_eq!(cache.distinct_stacks_seen, 1);
        assert!(
            cache.segments.is_empty(),
            "first injection scan on a line must not allocate owned Arc<str> cache entries"
        );
        assert!(cache.node_ptrs.is_empty());

        // Follow-up scan on the SAME unchanged stack replays cached selector matches
        // without walking scopes or populating the owned `Arc<str>` cache.
        let second =
            super::match_injections(&grammar, &onig, false, 0, &deep_state, -1, &mut cache, None)
                .unwrap();
        assert!(second.is_none());
        assert_eq!(cache.distinct_stacks_seen, 1);
        assert!(
            cache.segments.is_empty(),
            "unchanged-stack follow-up scan must not populate owned Arc<str> cache entries"
        );
        assert!(cache.node_ptrs.is_empty());
        assert_eq!(cache.last_selector_evaluated, 1);
        assert_eq!(cache.last_matched_injections, vec![0]);

        // Second distinct stack on the same line (e.g., short begin/end delimiter line)
        // STILL uses borrowed `&str` scopes and keeps the owned cache empty.
        let second_scopes = deep_state
            .content_name_scopes_list
            .as_ref()
            .unwrap()
            .push_attributed(Some("meta.second"), &grammar);
        let second_state = deep_state.push(
            grammar.root_id,
            0,
            -1,
            false,
            None,
            Some(Arc::clone(&second_scopes)),
            Some(second_scopes),
        );
        let third = super::match_injections(
            &grammar,
            &onig,
            false,
            0,
            &second_state,
            -1,
            &mut cache,
            None,
        )
        .unwrap();
        assert!(third.is_none());
        assert_eq!(cache.distinct_stacks_seen, 2);
        assert!(
            cache.segments.is_empty(),
            "second distinct stack on a line must still stay borrowed without Arc<str> clones"
        );
        assert!(cache.node_ptrs.is_empty());

        // Third distinct stack on the same line populates the owned incremental cache.
        let third_scopes = second_state
            .content_name_scopes_list
            .as_ref()
            .unwrap()
            .push_attributed(Some("meta.third"), &grammar);
        let third_state = second_state.push(
            grammar.root_id,
            0,
            -1,
            false,
            None,
            Some(Arc::clone(&third_scopes)),
            Some(third_scopes),
        );
        let fourth = super::match_injections(
            &grammar,
            &onig,
            false,
            0,
            &third_state,
            -1,
            &mut cache,
            None,
        )
        .unwrap();
        assert!(fourth.is_none());
        assert_eq!(cache.distinct_stacks_seen, 3);
        assert_eq!(cache.segments.len(), 35);
        assert_eq!(cache.node_ptrs.len(), 35);
    }

    #[test]
    fn unchanged_stack_injection_cache_resumes_tail_after_early_line_pos_break() {
        let mut grammar = TestGrammar::new(
            r#"{
                "scopeName": "source.test",
                "patterns": [{ "match": "z", "name": "keyword.z" }]
            }"#,
        );
        let first_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("injected.a".to_owned()),
                "a",
                Vec::new(),
            ))
        });
        let second_id = grammar.registry.register_rule(|id| {
            Rule::Match(MatchRule::new(
                None,
                id,
                Some("injected.b".to_owned()),
                "b",
                Vec::new(),
            ))
        });
        let mut injections = Injection::from_selector("L:source.test", first_id).unwrap();
        injections.extend(Injection::from_selector("L:source.test", second_id).unwrap());
        grammar.injections = injections;

        let line = "ab\n";
        let onig = crate::OnigString::new(line);
        let state = grammar.initial_state();
        let mut cache = super::InjectionScopeCache::default();

        // At line_pos=0, injection 0 matches 'a' at line_pos and breaks early
        // before injection 1's selector is evaluated.
        let hit_a = super::match_injections(&grammar, &onig, true, 0, &state, -1, &mut cache, None)
            .unwrap()
            .expect("injection 0 must match 'a'");
        assert_eq!(hit_a.matched.rule_id, super::RuleScannerId::Rule(first_id));
        assert_eq!(cache.last_selector_evaluated, 1);
        assert_eq!(cache.last_matched_injections, vec![0]);
        assert!(cache.segments.is_empty());

        // At line_pos=1 on the SAME stack, injection 0 replays and misses, so
        // the cache evaluates the remaining tail selector (injection 1) and
        // matches 'b' while still leaving `segments`/`node_ptrs` empty!
        let hit_b =
            super::match_injections(&grammar, &onig, false, 1, &state, -1, &mut cache, None)
                .unwrap()
                .expect("injection 1 must match 'b' when resuming tail");
        assert_eq!(hit_b.matched.rule_id, super::RuleScannerId::Rule(second_id));
        assert_eq!(cache.last_selector_evaluated, 2);
        assert_eq!(cache.last_matched_injections, vec![0, 1]);
        assert!(cache.segments.is_empty());
        assert!(cache.node_ptrs.is_empty());
    }

    #[test]
    fn injection_scope_cache_reuses_persistent_ptr_index_across_deep_transitions() {
        use crate::theme::ScopeStack;

        let mut base = ScopeStack::push(None, ["source.root"]).unwrap();
        for level in 1..256 {
            base = base.push_arc(Arc::from(format!("meta.base{level}")));
        }

        let mut cache = super::InjectionScopeCache::default();
        let assert_invariants = |cache: &super::InjectionScopeCache, target: &Arc<ScopeStack>| {
            let expected = target.get_segments();
            let actual: Vec<&str> = cache.segments.iter().map(AsRef::as_ref).collect();
            let expected_refs: Vec<&str> = expected.iter().map(String::as_str).collect();
            assert_eq!(actual, expected_refs);
            assert_eq!(cache.node_ptrs.len(), cache.segments.len());
            if !cache.ptr_to_index.is_empty() {
                assert_eq!(cache.ptr_to_index.len(), cache.node_ptrs.len());
                for (index, &ptr) in cache.node_ptrs.iter().enumerate() {
                    assert_eq!(cache.ptr_to_index.get(&ptr).copied(), Some(index));
                }
            }
        };

        cache.segments_for(&base, &mut || false).unwrap();
        assert!(cache.ptr_to_index.is_empty());
        let shared_base_ptr = Arc::as_ptr(&cache.segments[100]);

        // Repeated 20-level push/pop/sibling transitions beneath the 256-deep base:
        // first 20-level push initializes `ptr_to_index`; subsequent transitions
        // reuse and incrementally update it without losing sync or cloning shared base scopes.
        for round in 0..5 {
            let mut deep_capture = Arc::clone(&base);
            for depth in 0..20 {
                deep_capture =
                    deep_capture.push_arc(Arc::from(format!("capture.r{round}.d{depth}")));
            }
            cache.segments_for(&deep_capture, &mut || false).unwrap();
            assert!(!cache.ptr_to_index.is_empty());
            assert_invariants(&cache, &deep_capture);
            assert_eq!(Arc::as_ptr(&cache.segments[100]), shared_base_ptr);

            // 1-level push, sibling replace, and pop while `ptr_to_index` is active.
            let extra = deep_capture.push_arc(Arc::from("extra.one"));
            cache.segments_for(&extra, &mut || false).unwrap();
            assert_invariants(&cache, &extra);

            let sibling = deep_capture.push_arc(Arc::from("extra.two"));
            cache.segments_for(&sibling, &mut || false).unwrap();
            assert_invariants(&cache, &sibling);

            cache.segments_for(&deep_capture, &mut || false).unwrap();
            assert_invariants(&cache, &deep_capture);

            // Return to base (20-level pop).
            cache.segments_for(&base, &mut || false).unwrap();
            assert_invariants(&cache, &base);
            assert_eq!(Arc::as_ptr(&cache.segments[100]), shared_base_ptr);
        }

        // Disjoint root clears `ptr_to_index` cleanly.
        let disjoint = ScopeStack::push(None, ["text.disjoint"]).unwrap();
        cache.segments_for(&disjoint, &mut || false).unwrap();
        assert!(cache.ptr_to_index.is_empty());
        assert_invariants(&cache, &disjoint);
    }
}
