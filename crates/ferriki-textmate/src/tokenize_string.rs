/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::sync::Arc;
use std::time::Instant;

use ferroni::error::RegexError;

use crate::attributed_scope_stack::{AttributedScopeStack, ScopeAttributesProvider};
use crate::line_output::{LineFonts, LineTokens};
use crate::matcher::{Matcher, MatcherPriority, create_matchers};
use crate::regexp::{CaptureIndex, FindNextMatchResult, OnigString, ScannerFindOptions};
use crate::rule::{CaptureRule, RuleRegistry, RuleScannerId};
use crate::state_stack::StateStack;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Injection {
    pub debug_selector: String,
    pub matcher: Matcher,
    pub priority: MatcherPriority,
    pub rule_id: crate::RuleId,
}

impl Injection {
    #[must_use]
    pub fn from_selector(selector: &str, rule_id: crate::RuleId) -> Vec<Self> {
        create_matchers(selector)
            .into_iter()
            .map(|matcher| Self {
                debug_selector: selector.to_owned(),
                matcher: matcher.matcher,
                priority: matcher.priority,
                rule_id,
            })
            .collect()
    }
}

pub trait TokenizerGrammar: ScopeAttributesProvider {
    fn rule_registry(&self) -> &RuleRegistry;
    fn injections(&self) -> &[Injection];
}

pub struct TokenizeStringResult {
    pub stack: Arc<StateStack>,
    pub stopped_early: bool,
}

#[allow(clippy::too_many_arguments)]
pub fn tokenize_string<G: TokenizerGrammar>(
    grammar: &G,
    line_text: &OnigString,
    mut is_first_line: bool,
    mut line_pos: usize,
    mut stack: Arc<StateStack>,
    line_tokens: &mut LineTokens,
    line_fonts: &mut LineFonts,
    check_while_conditions: bool,
    time_limit_millis: u64,
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
        )?;
        stack = result.stack;
        line_pos = result.line_pos;
        is_first_line = result.is_first_line;
        anchor_position = result.anchor_position;
    }

    let start_time = Instant::now();
    loop {
        if time_limit_millis != 0
            && start_time.elapsed().as_millis() > u128::from(time_limit_millis)
        {
            return Ok(TokenizeStringResult {
                stack,
                stopped_early: true,
            });
        }

        let Some(matched) = match_rule_or_injections(
            grammar,
            line_text,
            is_first_line,
            line_pos,
            &stack,
            anchor_position,
        )?
        else {
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
                handle_captures(
                    grammar,
                    line_text,
                    is_first_line,
                    &stack,
                    line_tokens,
                    line_fonts,
                    &popped_rule.end_captures,
                    &capture_indices,
                )?;
                produce(&stack, full_match.end, line_tokens, line_fonts);

                let popped = Arc::clone(&stack);
                stack = stack
                    .parent
                    .clone()
                    .expect("BeginEndRule state must have a parent");
                anchor_position = popped.anchor_pos();

                if !has_advanced && popped.enter_pos() == line_pos as isize {
                    stack = popped;
                    produce(&stack, line_length, line_tokens, line_fonts);
                    return Ok(TokenizeStringResult {
                        stack,
                        stopped_early: false,
                    });
                }
            }
            RuleScannerId::Rule(matched_rule_id) => {
                let matched_rule = grammar.rule_registry().get_rule(matched_rule_id);
                produce(&stack, full_match.start, line_tokens, line_fonts);

                let before_push = Arc::clone(&stack);
                let scope_name =
                    matched_rule.get_name(Some(line_text.content()), Some(&capture_indices));
                let name_scopes_list = stack
                    .content_name_scopes_list
                    .as_ref()
                    .expect("grammar state must have content-name scopes")
                    .push_attributed(scope_name.as_deref(), grammar);
                stack = stack.push(
                    matched_rule_id,
                    line_pos as isize,
                    anchor_position,
                    full_match.end == line_length,
                    None,
                    Some(Arc::clone(&name_scopes_list)),
                    Some(Arc::clone(&name_scopes_list)),
                );

                if let Some(pushed_rule) = matched_rule.as_begin_end() {
                    handle_captures(
                        grammar,
                        line_text,
                        is_first_line,
                        &stack,
                        line_tokens,
                        line_fonts,
                        &pushed_rule.begin_captures,
                        &capture_indices,
                    )?;
                    produce(&stack, full_match.end, line_tokens, line_fonts);
                    anchor_position = full_match.end as isize;
                    let content_name =
                        matched_rule.get_content_name(line_text.content(), &capture_indices);
                    let content_name_scopes_list =
                        name_scopes_list.push_attributed(content_name.as_deref(), grammar);
                    stack = stack.with_content_name_scopes_list(content_name_scopes_list);
                    if pushed_rule.end_has_back_references {
                        stack =
                            stack.with_end_rule(pushed_rule.get_end_with_resolved_back_references(
                                line_text.content(),
                                &capture_indices,
                            ));
                    }
                    if !has_advanced && before_push.has_same_rule_as(&stack) {
                        stack = stack.pop().expect("newly pushed state must have a parent");
                        produce(&stack, line_length, line_tokens, line_fonts);
                        return Ok(TokenizeStringResult {
                            stack,
                            stopped_early: false,
                        });
                    }
                } else if let Some(pushed_rule) = matched_rule.as_begin_while() {
                    handle_captures(
                        grammar,
                        line_text,
                        is_first_line,
                        &stack,
                        line_tokens,
                        line_fonts,
                        &pushed_rule.begin_captures,
                        &capture_indices,
                    )?;
                    produce(&stack, full_match.end, line_tokens, line_fonts);
                    anchor_position = full_match.end as isize;
                    let content_name =
                        matched_rule.get_content_name(line_text.content(), &capture_indices);
                    let content_name_scopes_list =
                        name_scopes_list.push_attributed(content_name.as_deref(), grammar);
                    stack = stack.with_content_name_scopes_list(content_name_scopes_list);
                    if pushed_rule.while_has_back_references {
                        stack = stack.with_end_rule(
                            pushed_rule.get_while_with_resolved_back_references(
                                line_text.content(),
                                &capture_indices,
                            ),
                        );
                    }
                    if !has_advanced && before_push.has_same_rule_as(&stack) {
                        stack = stack.pop().expect("newly pushed state must have a parent");
                        produce(&stack, line_length, line_tokens, line_fonts);
                        return Ok(TokenizeStringResult {
                            stack,
                            stopped_early: false,
                        });
                    }
                } else if let Some(matching_rule) = matched_rule.as_match() {
                    handle_captures(
                        grammar,
                        line_text,
                        is_first_line,
                        &stack,
                        line_tokens,
                        line_fonts,
                        &matching_rule.captures,
                        &capture_indices,
                    )?;
                    produce(&stack, full_match.end, line_tokens, line_fonts);
                    stack = stack.pop().expect("MatchRule state must have a parent");
                    if !has_advanced {
                        stack = stack.safe_pop();
                        produce(&stack, line_length, line_tokens, line_fonts);
                        return Ok(TokenizeStringResult {
                            stack,
                            stopped_early: false,
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

struct WhileCheckResult {
    stack: Arc<StateStack>,
    line_pos: usize,
    anchor_position: isize,
    is_first_line: bool,
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
) -> Result<WhileCheckResult, RegexError> {
    let mut anchor_position = if stack.begin_rule_captured_eol { 0 } else { -1 };
    let mut while_rules = Vec::new();
    let mut node = Some(Arc::clone(&stack));
    while let Some(current) = node {
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
        let while_rule = while_stack
            .rule(grammar.rule_registry())
            .as_begin_while()
            .expect("collected while state must reference BeginWhileRule");
        let scanner = while_rule.compile_while_ag(
            while_stack.end_rule.as_deref(),
            is_first_line,
            line_pos as isize == anchor_position,
        )?;
        let matched = scanner.find_next_match(line_text, line_pos, ScannerFindOptions::NONE);
        let Some(matched) = matched else {
            stack = while_stack
                .pop()
                .expect("BeginWhileRule state must have a parent");
            break;
        };
        if matched.rule_id != RuleScannerId::While {
            stack = while_stack
                .pop()
                .expect("BeginWhileRule state must have a parent");
            break;
        }
        if let Some(full_match) = matched.capture_indices.first() {
            produce(&while_stack, full_match.start, line_tokens, line_fonts);
            handle_captures(
                grammar,
                line_text,
                is_first_line,
                &while_stack,
                line_tokens,
                line_fonts,
                &while_rule.while_captures,
                &matched.capture_indices,
            )?;
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
) -> Result<Option<MatchResult>, RegexError> {
    let match_result = match_rule(
        grammar,
        line_text,
        is_first_line,
        line_pos,
        stack,
        anchor_position,
    )?;
    if grammar.injections().is_empty() {
        return Ok(match_result);
    }
    let injection_result = match_injections(
        grammar,
        line_text,
        is_first_line,
        line_pos,
        stack,
        anchor_position,
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
) -> Result<Option<MatchResult>, RegexError> {
    let rule = stack.rule(grammar.rule_registry());
    let scanner = rule.compile_ag(
        grammar.rule_registry(),
        stack.end_rule.as_deref(),
        is_first_line,
        line_pos as isize == anchor_position,
    )?;
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
) -> Result<Option<MatchResult>, RegexError> {
    let scopes = stack
        .content_name_scopes_list
        .as_ref()
        .expect("grammar state must have content-name scopes")
        .scope_names();
    let scope_slice = scopes.as_slice();
    let mut best: Option<(usize, FindNextMatchResult<RuleScannerId>, MatcherPriority)> = None;

    for injection in grammar.injections() {
        if !injection
            .matcher
            .matches(&scope_slice, &matches_scope_identifiers)
        {
            continue;
        }
        let rule = grammar.rule_registry().get_rule(injection.rule_id);
        let scanner = rule.compile_ag(
            grammar.rule_registry(),
            None,
            is_first_line,
            line_pos as isize == anchor_position,
        )?;
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
    captures: &[Option<Arc<CaptureRule>>],
    capture_indices: &[CaptureIndex],
) -> Result<(), RegexError> {
    if captures.is_empty() {
        return Ok(());
    }
    let line_text_content = line_text.content();
    let length = captures.len().min(capture_indices.len());
    let mut local_stack: Vec<LocalStackElement> = Vec::new();
    let max_end = capture_indices[0].end;

    for index in 0..length {
        let Some(capture_rule) = captures[index].as_ref() else {
            continue;
        };
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
            let scope_name = capture_rule.get_name(Some(line_text_content), Some(capture_indices));
            let name_scopes_list = stack
                .content_name_scopes_list
                .as_ref()
                .expect("grammar state must have content-name scopes")
                .push_attributed(scope_name.as_deref(), grammar);
            let content_name = capture_rule.get_content_name(line_text_content, capture_indices);
            let content_name_scopes_list =
                name_scopes_list.push_attributed(content_name.as_deref(), grammar);
            let stack_clone = stack.push(
                retokenize_rule_id,
                capture_index.start as isize,
                -1,
                false,
                None,
                Some(name_scopes_list),
                Some(content_name_scopes_list),
            );
            let prefix = utf16_prefix(line_text_content, capture_index.end);
            let substring = OnigString::new(prefix);
            tokenize_string(
                grammar,
                &substring,
                is_first_line && capture_index.start == 0,
                capture_index.start,
                stack_clone,
                line_tokens,
                line_fonts,
                false,
                0,
            )?;
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
        produce_from_scopes(Some(&local.scopes), local.end_pos, line_tokens, line_fonts);
    }
    Ok(())
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

fn matches_scope_identifiers(identifiers: &[String], scopes: &&[String]) -> bool {
    if scopes.len() < identifiers.len() {
        return false;
    }
    let mut last_index = 0;
    identifiers.iter().all(|identifier| {
        for (index, scope) in scopes.iter().enumerate().skip(last_index) {
            if scope == identifier
                || scope
                    .strip_prefix(identifier)
                    .is_some_and(|remainder| remainder.starts_with('.'))
            {
                last_index = index + 1;
                return true;
            }
        }
        false
    })
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
    use std::sync::Arc;

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
            self.injections = Injection::from_selector("L:source.test", rule_id);
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
}
