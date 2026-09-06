#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MatcherPriority {
    Left,
    #[default]
    Normal,
    Right,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatcherWithPriority {
    pub matcher: Matcher,
    pub priority: MatcherPriority,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Matcher {
    Name(Vec<String>),
    Negate(Box<Self>),
    Conjunction(Vec<Self>),
    Disjunction(Vec<Self>),
    Never,
}

impl Matcher {
    pub fn matches<T>(
        &self,
        matcher_input: &T,
        matches_name: &impl Fn(&[String], &T) -> bool,
    ) -> bool {
        match self {
            Self::Name(identifiers) => matches_name(identifiers, matcher_input),
            Self::Negate(matcher) => !matcher.matches(matcher_input, matches_name),
            Self::Conjunction(matchers) => matchers
                .iter()
                .all(|matcher| matcher.matches(matcher_input, matches_name)),
            Self::Disjunction(matchers) => matchers
                .iter()
                .any(|matcher| matcher.matches(matcher_input, matches_name)),
            Self::Never => false,
        }
    }
}

pub fn create_matchers(selector: &str) -> Vec<MatcherWithPriority> {
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

    fn parse(mut self) -> Vec<MatcherWithPriority> {
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

            let matcher = self.parse_conjunction();
            results.push(MatcherWithPriority { matcher, priority });
            if self.token.as_deref() != Some(",") {
                break;
            }
            self.advance();
        }
        results
    }

    fn parse_operand(&mut self) -> Option<Matcher> {
        match self.token.as_deref() {
            Some("-") => {
                self.advance();
                Some(match self.parse_operand() {
                    Some(matcher) => Matcher::Negate(Box::new(matcher)),
                    None => Matcher::Never,
                })
            }
            Some("(") => {
                self.advance();
                let matcher = self.parse_inner_expression();
                if self.token.as_deref() == Some(")") {
                    self.advance();
                }
                Some(matcher)
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
                Some(Matcher::Name(identifiers))
            }
            _ => None,
        }
    }

    fn parse_conjunction(&mut self) -> Matcher {
        let mut matchers = Vec::new();
        while let Some(matcher) = self.parse_operand() {
            matchers.push(matcher);
        }
        Matcher::Conjunction(matchers)
    }

    fn parse_inner_expression(&mut self) -> Matcher {
        let mut matchers = Vec::new();
        loop {
            matchers.push(self.parse_conjunction());
            if !matches!(self.token.as_deref(), Some("|" | ",")) {
                break;
            }
            while matches!(self.token.as_deref(), Some("|" | ",")) {
                self.advance();
            }
        }
        Matcher::Disjunction(matchers)
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
            let matchers = create_matchers(case.expression);
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
        let matchers = create_matchers("R:text.html, L:source.js, comment");
        assert_eq!(matchers[0].priority, MatcherPriority::Right);
        assert_eq!(matchers[1].priority, MatcherPriority::Left);
        assert_eq!(matchers[2].priority, MatcherPriority::Normal);
    }
}
