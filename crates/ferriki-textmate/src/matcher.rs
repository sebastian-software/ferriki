use std::fmt;

/// Upper bound on nested selector expressions (`(` / `-`) during parsing.
const MAX_MATCHER_DEPTH: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MatcherError {
    DepthLimitExceeded,
}

impl fmt::Display for MatcherError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DepthLimitExceeded => {
                formatter.write_str("scope selector nesting depth limit exceeded")
            }
        }
    }
}

impl std::error::Error for MatcherError {}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum MatcherPriority {
    Left,
    #[default]
    Normal,
    Right,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MatcherWithPriority {
    pub matcher: Matcher,
    pub priority: MatcherPriority,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Matcher {
    Name(Vec<String>),
    Negate(Box<Self>),
    Conjunction(Vec<Self>),
    Disjunction(Vec<Self>),
    Never,
}

impl Matcher {
    pub(crate) fn matches<T>(
        &self,
        matcher_input: &T,
        matches_name: &impl Fn(&[String], &T) -> bool,
    ) -> bool {
        self.matches_with_stop(
            matcher_input,
            &mut |identifiers, input| Some(matches_name(identifiers, input)),
            &mut || false,
        )
        .expect("unbounded matcher evaluation cannot stop early")
    }

    /// Evaluates this matcher iteratively, polling `should_stop` periodically
    /// so wide selector expressions and long ancestor scope paths can abort
    /// early when a caller's time budget expires. Returns `None` if stopped.
    pub(crate) fn matches_with_stop<T>(
        &self,
        matcher_input: &T,
        matches_name: &mut impl FnMut(&[String], &T) -> Option<bool>,
        should_stop: &mut impl FnMut() -> bool,
    ) -> Option<bool> {
        // Fast paths for the common leaf and single-negation selectors avoid
        // initializing any traversal frame stack or allocating on the heap.
        match self {
            Self::Name(identifiers) => return matches_name(identifiers, matcher_input),
            Self::Never => return Some(false),
            Self::Negate(inner) => match inner.as_ref() {
                Self::Name(identifiers) => {
                    return matches_name(identifiers, matcher_input).map(|matched| !matched);
                }
                Self::Never => return Some(true),
                _ => {}
            },
            _ => {}
        }

        const INLINE_FRAME_CAPACITY: usize = 16;
        const STOP_CHECK_INTERVAL: usize = 64;

        enum Frame<'a> {
            Negate,
            Conjunction(std::slice::Iter<'a, Matcher>),
            Disjunction(std::slice::Iter<'a, Matcher>),
        }

        struct EvalStack<'a> {
            inline: [Option<Frame<'a>>; INLINE_FRAME_CAPACITY],
            inline_len: usize,
            overflow: Vec<Frame<'a>>,
        }

        impl<'a> EvalStack<'a> {
            fn new() -> Self {
                Self {
                    inline: [const { None }; INLINE_FRAME_CAPACITY],
                    inline_len: 0,
                    overflow: Vec::new(),
                }
            }

            fn push(&mut self, frame: Frame<'a>) {
                if self.overflow.is_empty() && self.inline_len < INLINE_FRAME_CAPACITY {
                    self.inline[self.inline_len] = Some(frame);
                    self.inline_len += 1;
                } else {
                    self.overflow.push(frame);
                }
            }

            fn pop(&mut self) -> Option<Frame<'a>> {
                if let Some(frame) = self.overflow.pop() {
                    return Some(frame);
                }
                if self.inline_len > 0 {
                    self.inline_len -= 1;
                    return self.inline[self.inline_len].take();
                }
                None
            }
        }

        let mut stack = EvalStack::new();
        let mut node = self;
        let mut steps: usize = 0;

        loop {
            steps += 1;
            if steps & (STOP_CHECK_INTERVAL - 1) == 0 && should_stop() {
                return None;
            }

            let mut result = match node {
                Self::Name(identifiers) => matches_name(identifiers, matcher_input)?,
                Self::Never => false,
                Self::Negate(inner) => {
                    stack.push(Frame::Negate);
                    node = inner;
                    continue;
                }
                Self::Conjunction(matchers) => {
                    let mut iter = matchers.iter();
                    if let Some(first) = iter.next() {
                        stack.push(Frame::Conjunction(iter));
                        node = first;
                        continue;
                    }
                    true
                }
                Self::Disjunction(matchers) => {
                    let mut iter = matchers.iter();
                    if let Some(first) = iter.next() {
                        stack.push(Frame::Disjunction(iter));
                        node = first;
                        continue;
                    }
                    false
                }
            };

            loop {
                match stack.pop() {
                    None => return Some(result),
                    Some(Frame::Negate) => {
                        result = !result;
                    }
                    Some(Frame::Conjunction(mut iter)) => {
                        if !result {
                            result = false;
                        } else if let Some(next) = iter.next() {
                            stack.push(Frame::Conjunction(iter));
                            node = next;
                            break;
                        } else {
                            result = true;
                        }
                    }
                    Some(Frame::Disjunction(mut iter)) => {
                        if result {
                            result = true;
                        } else if let Some(next) = iter.next() {
                            stack.push(Frame::Disjunction(iter));
                            node = next;
                            break;
                        } else {
                            result = false;
                        }
                    }
                }
            }
        }
    }
}

impl Drop for Matcher {
    fn drop(&mut self) {
        enum DropItem {
            Single(Option<Matcher>),
            List(std::vec::IntoIter<Matcher>),
        }

        fn push_children(node: &mut Matcher, stack: &mut Vec<DropItem>) {
            match node {
                Matcher::Negate(inner) => {
                    if !matches!(inner.as_ref(), Matcher::Never) {
                        let child = std::mem::replace(inner.as_mut(), Matcher::Never);
                        stack.push(DropItem::Single(Some(child)));
                    }
                }
                Matcher::Conjunction(matchers) | Matcher::Disjunction(matchers) => {
                    if !matchers.is_empty() {
                        stack.push(DropItem::List(std::mem::take(matchers).into_iter()));
                    }
                }
                Matcher::Name(_) | Matcher::Never => {}
            }
        }

        if matches!(self, Self::Name(_) | Self::Never) {
            return;
        }
        let mut stack = Vec::new();
        push_children(self, &mut stack);
        while let Some(top) = stack.last_mut() {
            let next = match top {
                DropItem::Single(slot) => slot.take(),
                DropItem::List(iter) => iter.next(),
            };
            let Some(mut child) = next else {
                stack.pop();
                continue;
            };
            push_children(&mut child, &mut stack);
        }
    }
}

pub(crate) fn create_matchers(selector: &str) -> Result<Vec<MatcherWithPriority>, MatcherError> {
    Parser::new(selector).parse()
}

struct Parser {
    tokenizer: Tokenizer,
    token: Option<String>,
}

impl Parser {
    fn new(selector: &str) -> Self {
        let mut tokenizer = Tokenizer::new(selector);
        let token = tokenizer.next();
        Self { tokenizer, token }
    }

    fn parse(mut self) -> Result<Vec<MatcherWithPriority>, MatcherError> {
        let mut results = Vec::new();
        while self.token.is_some() {
            let priority = match self.token.as_deref() {
                Some("R:") => {
                    self.advance();
                    MatcherPriority::Right
                }
                Some("L:") => {
                    self.advance();
                    MatcherPriority::Left
                }
                _ => MatcherPriority::Normal,
            };

            let matcher = self.parse_conjunction(0)?;
            results.push(MatcherWithPriority { matcher, priority });
            if self.token.as_deref() != Some(",") {
                break;
            }
            self.advance();
        }
        Ok(results)
    }

    fn parse_operand(&mut self, depth: usize) -> Result<Option<Matcher>, MatcherError> {
        if depth > MAX_MATCHER_DEPTH {
            return Err(MatcherError::DepthLimitExceeded);
        }
        match self.token.as_deref() {
            Some("-") => {
                self.advance();
                Ok(Some(match self.parse_operand(depth + 1)? {
                    Some(matcher) => Matcher::Negate(Box::new(matcher)),
                    None => Matcher::Never,
                }))
            }
            Some("(") => {
                self.advance();
                let matcher = self.parse_inner_expression(depth + 1)?;
                if self.token.as_deref() == Some(")") {
                    self.advance();
                }
                Ok(Some(matcher))
            }
            Some(token) if is_identifier(token) => {
                let mut identifiers = Vec::new();
                while let Some(token) = self.token.as_deref() {
                    if !is_identifier(token) {
                        break;
                    }
                    identifiers.push(token.to_owned());
                    self.advance();
                }
                Ok(Some(Matcher::Name(identifiers)))
            }
            _ => Ok(None),
        }
    }

    fn parse_conjunction(&mut self, depth: usize) -> Result<Matcher, MatcherError> {
        if depth > MAX_MATCHER_DEPTH {
            return Err(MatcherError::DepthLimitExceeded);
        }
        let mut matchers = Vec::new();
        while let Some(matcher) = self.parse_operand(depth)? {
            matchers.push(matcher);
        }
        if matchers.len() == 1 {
            return Ok(matchers.pop().expect("single-element conjunction"));
        }
        Ok(Matcher::Conjunction(matchers))
    }

    fn parse_inner_expression(&mut self, depth: usize) -> Result<Matcher, MatcherError> {
        if depth > MAX_MATCHER_DEPTH {
            return Err(MatcherError::DepthLimitExceeded);
        }
        let mut matchers = Vec::new();
        loop {
            matchers.push(self.parse_conjunction(depth)?);
            if !matches!(self.token.as_deref(), Some("|" | ",")) {
                break;
            }
            while matches!(self.token.as_deref(), Some("|" | ",")) {
                self.advance();
            }
        }
        if matchers.len() == 1 {
            return Ok(matchers.pop().expect("single-element disjunction"));
        }
        Ok(Matcher::Disjunction(matchers))
    }

    fn advance(&mut self) {
        self.token = self.tokenizer.next();
    }
}

fn is_identifier(token: &str) -> bool {
    token
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':'))
}

struct Tokenizer {
    input: Vec<char>,
    offset: usize,
}

impl Tokenizer {
    fn new(input: &str) -> Self {
        Self {
            input: input.chars().collect(),
            offset: 0,
        }
    }
}

impl Iterator for Tokenizer {
    type Item = String;

    fn next(&mut self) -> Option<Self::Item> {
        while self.offset < self.input.len() {
            let character = self.input[self.offset];
            if matches!(character, 'L' | 'R') && self.input.get(self.offset + 1) == Some(&':') {
                self.offset += 2;
                return Some(format!("{character}:"));
            }

            if is_identifier_start(character) {
                let start = self.offset;
                self.offset += 1;
                while self
                    .input
                    .get(self.offset)
                    .is_some_and(|character| is_identifier_continue(*character))
                {
                    self.offset += 1;
                }
                return Some(self.input[start..self.offset].iter().collect());
            }

            self.offset += 1;
            if matches!(character, ',' | '|' | '-' | '(' | ')') {
                return Some(character.to_string());
            }
        }
        None
    }
}

fn is_identifier_start(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':')
}

fn is_identifier_continue(character: char) -> bool {
    is_identifier_start(character) || character == '-'
}

#[cfg(test)]
mod tests {
    use super::{MatcherPriority, create_matchers};

    struct Case {
        expression: &'static str,
        input: &'static [&'static str],
        result: bool,
    }

    #[test]
    fn matches_upstream_selector_cases() {
        let cases = [
            Case {
                expression: "foo",
                input: &["foo"],
                result: true,
            },
            Case {
                expression: "foo",
                input: &["bar"],
                result: false,
            },
            Case {
                expression: "- foo",
                input: &["foo"],
                result: false,
            },
            Case {
                expression: "- foo",
                input: &["bar"],
                result: true,
            },
            Case {
                expression: "- - foo",
                input: &["bar"],
                result: false,
            },
            Case {
                expression: "bar foo",
                input: &["foo"],
                result: false,
            },
            Case {
                expression: "bar foo",
                input: &["bar"],
                result: false,
            },
            Case {
                expression: "bar foo",
                input: &["bar", "foo"],
                result: true,
            },
            Case {
                expression: "bar - foo",
                input: &["bar"],
                result: true,
            },
            Case {
                expression: "bar - foo",
                input: &["foo", "bar"],
                result: false,
            },
            Case {
                expression: "bar - foo",
                input: &["foo"],
                result: false,
            },
            Case {
                expression: "bar, foo",
                input: &["foo"],
                result: true,
            },
            Case {
                expression: "bar, foo",
                input: &["bar"],
                result: true,
            },
            Case {
                expression: "bar, foo",
                input: &["bar", "foo"],
                result: true,
            },
            Case {
                expression: "bar, -foo",
                input: &["bar", "foo"],
                result: true,
            },
            Case {
                expression: "bar, -foo",
                input: &["yo"],
                result: true,
            },
            Case {
                expression: "bar, -foo",
                input: &["foo"],
                result: false,
            },
            Case {
                expression: "(foo)",
                input: &["foo"],
                result: true,
            },
            Case {
                expression: "(foo - bar)",
                input: &["foo"],
                result: true,
            },
            Case {
                expression: "(foo - bar)",
                input: &["foo", "bar"],
                result: false,
            },
            Case {
                expression: "foo bar - (yo man)",
                input: &["foo", "bar"],
                result: true,
            },
            Case {
                expression: "foo bar - (yo man)",
                input: &["foo", "bar", "yo"],
                result: true,
            },
            Case {
                expression: "foo bar - (yo man)",
                input: &["foo", "bar", "yo", "man"],
                result: false,
            },
            Case {
                expression: "foo bar - (yo | man)",
                input: &["foo", "bar", "yo", "man"],
                result: false,
            },
            Case {
                expression: "foo bar - (yo | man)",
                input: &["foo", "bar", "yo"],
                result: false,
            },
            Case {
                expression: "R:text.html - (comment.block, text.html source)",
                input: &["text.html", "bar", "source"],
                result: false,
            },
            Case {
                expression: "text.html.php - (meta.embedded | meta.tag), L:text.html.php meta.tag, L:source.js.embedded.html",
                input: &["text.html.php", "bar", "source.js"],
                result: true,
            },
        ];

        for (index, case) in cases.into_iter().enumerate() {
            let matchers = create_matchers(case.expression).unwrap();
            let result = matchers.iter().any(|matcher| {
                matcher.matcher.matches(&case.input, &|identifiers, stack| {
                    let mut last_index = 0;
                    identifiers.iter().all(|identifier| {
                        let Some(relative_index) = stack[last_index..]
                            .iter()
                            .position(|element| *element == identifier)
                        else {
                            return false;
                        };
                        last_index += relative_index + 1;
                        true
                    })
                })
            });
            assert_eq!(result, case.result, "upstream matcher case #{index}");
        }
    }

    #[test]
    fn retains_injection_priorities() {
        let matchers = create_matchers("R:text.html, L:source.js, comment").unwrap();
        assert_eq!(matchers[0].priority, MatcherPriority::Right);
        assert_eq!(matchers[1].priority, MatcherPriority::Left);
        assert_eq!(matchers[2].priority, MatcherPriority::Normal);
        assert!(matches!(matchers[0].matcher, super::Matcher::Name(_)));
        assert!(matches!(matchers[1].matcher, super::Matcher::Name(_)));
        assert!(matches!(matchers[2].matcher, super::Matcher::Name(_)));
    }

    #[test]
    fn rejects_deeply_nested_scope_selectors() {
        let exact_limit_parens = format!(
            "{}foo{}",
            "(".repeat(super::MAX_MATCHER_DEPTH),
            ")".repeat(super::MAX_MATCHER_DEPTH)
        );
        let parsed = create_matchers(&exact_limit_parens).expect("exact depth limit should parse");
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].matcher.matches(&["foo"], &|ids, stack| {
            ids.len() == 1 && stack.contains(&ids[0].as_str())
        }));

        let exact_limit_negations = format!("{}foo", "- ".repeat(super::MAX_MATCHER_DEPTH));
        let parsed_neg =
            create_matchers(&exact_limit_negations).expect("exact negation depth should parse");
        assert_eq!(parsed_neg.len(), 1);
        // 128 negations (even) preserve truth value.
        assert!(parsed_neg[0].matcher.matches(&["foo"], &|ids, stack| {
            ids.len() == 1 && stack.contains(&ids[0].as_str())
        }));

        let deep_parens = format!(
            "{}foo{}",
            "(".repeat(super::MAX_MATCHER_DEPTH + 1),
            ")".repeat(super::MAX_MATCHER_DEPTH + 1)
        );
        assert_eq!(
            create_matchers(&deep_parens),
            Err(super::MatcherError::DepthLimitExceeded)
        );

        let deep_negations = format!("{}foo", "- ".repeat(super::MAX_MATCHER_DEPTH + 1));
        assert_eq!(
            create_matchers(&deep_negations),
            Err(super::MatcherError::DepthLimitExceeded)
        );

        let adversarial = format!("{}{}", "(".repeat(20_000), ")".repeat(20_000));
        assert_eq!(
            create_matchers(&adversarial),
            Err(super::MatcherError::DepthLimitExceeded)
        );
    }

    #[test]
    fn evaluates_and_drops_deep_matcher_ast_iteratively() {
        use std::cell::Cell;

        let mut matcher = super::Matcher::Name(vec!["foo".to_owned()]);
        for step in 0..20_000 {
            matcher = match step % 3 {
                0 => super::Matcher::Negate(Box::new(matcher)),
                1 => super::Matcher::Conjunction(vec![
                    super::Matcher::Name(vec!["bar".to_owned()]),
                    matcher,
                ]),
                _ => super::Matcher::Disjunction(vec![super::Matcher::Never, matcher]),
            };
        }

        // 20,000 steps => 6,667 Negate wrappers (step % 3 == 0 for 0..=19_998) => odd count!
        let matches_name =
            |ids: &[String], input: &&[&str]| ids.len() == 1 && input.contains(&ids[0].as_str());
        assert!(!matcher.matches(&&["bar", "foo"][..], &matches_name));
        assert!(matcher.matches(&&["bar"][..], &matches_name));
        drop(matcher);

        // Verify short-circuiting for conjunction and disjunction.
        let calls = Cell::new(0_usize);
        let counting_match = |ids: &[String], input: &&[&str]| {
            calls.set(calls.get() + 1);
            ids.len() == 1 && input.contains(&ids[0].as_str())
        };
        let conj = super::Matcher::Conjunction(vec![
            super::Matcher::Name(vec!["missing".to_owned()]),
            super::Matcher::Name(vec!["present".to_owned()]),
        ]);
        assert!(!conj.matches(&&["present"][..], &counting_match));
        assert_eq!(calls.get(), 1);

        calls.set(0);
        let disj = super::Matcher::Disjunction(vec![
            super::Matcher::Name(vec!["present".to_owned()]),
            super::Matcher::Name(vec!["other".to_owned()]),
        ]);
        assert!(disj.matches(&&["present"][..], &counting_match));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn stops_early_while_evaluating_wide_disjunction() {
        use std::cell::Cell;

        let wide = super::Matcher::Disjunction(
            (0..1_000)
                .map(|i| super::Matcher::Name(vec![format!("scope.{i}")]))
                .collect(),
        );
        let calls = Cell::new(0_usize);
        let result = wide.matches_with_stop(
            &&["other"][..],
            &mut |ids, input| {
                calls.set(calls.get() + 1);
                Some(ids.len() == 1 && input.contains(&ids[0].as_str()))
            },
            &mut || true,
        );
        assert_eq!(result, None);
        assert!(
            calls.get() < 100,
            "expected wide disjunction to stop on first periodic poll, evaluated {} leaves",
            calls.get()
        );
    }
}
