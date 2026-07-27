/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! The property-list reader used by TextMate grammar files.

use std::error::Error;
use std::fmt;

use serde_json::{Map, Number, Value};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlistError {
    offset: usize,
    message: String,
}

impl PlistError {
    fn new(offset: usize, message: impl Into<String>) -> Self {
        Self {
            offset,
            message: message.into(),
        }
    }
}

impl fmt::Display for PlistError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "near offset {}: {}", self.offset, self.message)
    }
}

impl Error for PlistError {}

/// Parse an XML property list into its JSON-compatible value representation.
///
/// vscode-textmate's grammar reader only needs dictionaries, arrays, scalar
/// values, and XML entity decoding. Dates and data remain strings, matching
/// the values observed by the raw grammar model.
pub fn parse_plist(content: &str) -> Result<Value, PlistError> {
    Parser::new(content).parse()
}

struct Parser<'a> {
    content: &'a str,
    position: usize,
}

impl<'a> Parser<'a> {
    fn new(content: &'a str) -> Self {
        Self {
            content: content.strip_prefix('\u{feff}').unwrap_or(content),
            position: 0,
        }
    }

    fn parse(mut self) -> Result<Value, PlistError> {
        self.skip_trivia()?;
        let value = if self.peek_open_tag_name()?.starts_with("plist") {
            self.parse_open_tag()?;
            self.skip_trivia()?;
            let value = self.parse_value()?;
            self.skip_trivia()?;
            self.parse_close_tag("plist")?;
            value
        } else {
            self.parse_value()?
        };
        self.skip_trivia()?;
        if self.position != self.content.len() {
            return Err(self.fail("too many constructs in root"));
        }
        Ok(value)
    }

    fn parse_value(&mut self) -> Result<Value, PlistError> {
        self.skip_trivia()?;
        let tag = self.parse_open_tag()?;
        match tag.name.as_str() {
            "dict" => self.parse_dict(tag.is_closed),
            "array" => self.parse_array(tag.is_closed),
            "string" | "date" | "data" => Ok(Value::String(self.parse_tag_value(&tag)?)),
            "real" => {
                let value = self.parse_tag_value(&tag)?;
                let parsed = value
                    .parse::<f64>()
                    .ok()
                    .and_then(Number::from_f64)
                    .ok_or_else(|| self.fail("cannot parse float"))?;
                Ok(Value::Number(parsed))
            }
            "integer" => {
                let value = self.parse_tag_value(&tag)?;
                let parsed = value
                    .parse::<i64>()
                    .map_err(|_| self.fail("cannot parse integer"))?;
                Ok(Value::Number(parsed.into()))
            }
            "true" => {
                self.parse_tag_value(&tag)?;
                Ok(Value::Bool(true))
            }
            "false" => {
                self.parse_tag_value(&tag)?;
                Ok(Value::Bool(false))
            }
            _ => Err(self.fail(format!("unexpected opened tag {}", tag.name))),
        }
    }

    fn parse_dict(&mut self, is_closed: bool) -> Result<Value, PlistError> {
        let mut result = Map::new();
        if is_closed {
            return Ok(Value::Object(result));
        }
        loop {
            self.skip_trivia()?;
            if self.starts_with_close_tag("dict") {
                self.parse_close_tag("dict")?;
                return Ok(Value::Object(result));
            }
            let key_tag = self.parse_open_tag()?;
            if key_tag.name != "key" {
                return Err(self.fail("missing <key>"));
            }
            let key = self.parse_tag_value(&key_tag)?;
            let value = self.parse_value()?;
            result.insert(key, value);
        }
    }

    fn parse_array(&mut self, is_closed: bool) -> Result<Value, PlistError> {
        let mut result = Vec::new();
        if is_closed {
            return Ok(Value::Array(result));
        }
        loop {
            self.skip_trivia()?;
            if self.starts_with_close_tag("array") {
                self.parse_close_tag("array")?;
                return Ok(Value::Array(result));
            }
            result.push(self.parse_value()?);
        }
    }

    fn parse_tag_value(&mut self, tag: &Tag) -> Result<String, PlistError> {
        if tag.is_closed {
            return Ok(String::new());
        }
        let remaining = &self.content[self.position..];
        let end = remaining
            .find("</")
            .ok_or_else(|| self.fail("unexpected end of input"))?;
        let value = decode_entities(&remaining[..end])?;
        self.position += end;
        let closing_name = self.parse_any_close_tag()?;
        if closing_name != tag.name {
            return Err(self.fail(format!(
                "expected </{}>, found </{}>",
                tag.name, closing_name
            )));
        }
        Ok(value)
    }

    fn parse_open_tag(&mut self) -> Result<Tag, PlistError> {
        if !self.remaining().starts_with('<') {
            return Err(self.fail("expected <"));
        }
        self.position += 1;
        if self.remaining().starts_with('/') {
            return Err(self.fail("unexpected closed tag"));
        }
        let end = self
            .remaining()
            .find('>')
            .ok_or_else(|| self.fail("unexpected end of input"))?;
        let raw_name = self.remaining()[..end].trim();
        let is_closed = raw_name.ends_with('/');
        let name = raw_name
            .strip_suffix('/')
            .unwrap_or(raw_name)
            .trim_end()
            .to_owned();
        self.position += end + 1;
        Ok(Tag { name, is_closed })
    }

    fn parse_close_tag(&mut self, expected: &str) -> Result<(), PlistError> {
        let actual = self.parse_any_close_tag()?;
        if actual != expected {
            return Err(self.fail(format!("expected </{expected}>, found </{actual}>")));
        }
        Ok(())
    }

    fn parse_any_close_tag(&mut self) -> Result<String, PlistError> {
        if !self.remaining().starts_with("</") {
            return Err(self.fail("expected closed tag"));
        }
        self.position += 2;
        let end = self
            .remaining()
            .find('>')
            .ok_or_else(|| self.fail("unexpected end of input"))?;
        let name = self.remaining()[..end].trim().to_owned();
        self.position += end + 1;
        Ok(name)
    }

    fn skip_trivia(&mut self) -> Result<(), PlistError> {
        loop {
            let before = self.position;
            while self
                .remaining()
                .chars()
                .next()
                .is_some_and(char::is_whitespace)
            {
                self.position += self
                    .remaining()
                    .chars()
                    .next()
                    .expect("a character was just observed")
                    .len_utf8();
            }
            if self.remaining().starts_with("<?") {
                self.advance_until("?>")?;
            } else if self.remaining().starts_with("<!--") {
                self.advance_until("-->")?;
            } else if self.remaining().starts_with("<!") {
                self.advance_until(">")?;
            }
            if self.position == before {
                return Ok(());
            }
        }
    }

    fn advance_until(&mut self, delimiter: &str) -> Result<(), PlistError> {
        let end = self
            .remaining()
            .find(delimiter)
            .ok_or_else(|| self.fail("unexpected end of input"))?;
        self.position += end + delimiter.len();
        Ok(())
    }

    fn starts_with_close_tag(&self, name: &str) -> bool {
        let remaining = self.remaining();
        let Some(after_prefix) = remaining.strip_prefix("</") else {
            return false;
        };
        after_prefix
            .strip_prefix(name)
            .is_some_and(|suffix| suffix.trim_start().starts_with('>'))
    }

    fn peek_open_tag_name(&self) -> Result<&str, PlistError> {
        let remaining = self.remaining();
        let body = remaining
            .strip_prefix('<')
            .ok_or_else(|| self.fail("expected <"))?;
        let end = body
            .find('>')
            .ok_or_else(|| self.fail("unexpected end of input"))?;
        Ok(body[..end].trim())
    }

    fn remaining(&self) -> &str {
        &self.content[self.position..]
    }

    fn fail(&self, message: impl Into<String>) -> PlistError {
        PlistError::new(self.position, message)
    }
}

struct Tag {
    name: String,
    is_closed: bool,
}

fn decode_entities(value: &str) -> Result<String, PlistError> {
    let mut result = String::with_capacity(value.len());
    let mut position = 0;
    while let Some(relative_start) = value[position..].find('&') {
        let start = position + relative_start;
        result.push_str(&value[position..start]);
        let Some(relative_end) = value[start..].find(';') else {
            result.push_str(&value[start..]);
            return Ok(result);
        };
        let end = start + relative_end;
        let entity = &value[start + 1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .and_then(|digits| u32::from_str_radix(digits, 16).ok())
                .or_else(|| {
                    entity
                        .strip_prefix('#')
                        .and_then(|digits| digits.parse::<u32>().ok())
                })
                .and_then(char::from_u32),
        };
        if let Some(decoded) = decoded {
            result.push(decoded);
        } else {
            result.push_str(&value[start..=end]);
        }
        position = end + 1;
    }
    result.push_str(&value[position..]);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::parse_plist;

    #[test]
    fn parses_upstream_property_list_values() {
        let value = parse_plist(
            r#"<?xml version="1.0"?>
            <!DOCTYPE plist>
            <plist version="1.0">
                <dict>
                    <key>scopeName</key>
                    <string>source.test</string>
                    <key>patterns</key>
                    <array>
                        <dict>
                            <key>match</key>
                            <string>&lt;([a-z]+)&gt;</string>
                            <key>applyEndPatternLast</key>
                            <integer>1</integer>
                        </dict>
                        <dict/>
                    </array>
                    <key>enabled</key>
                    <true/>
                </dict>
            </plist>"#,
        )
        .unwrap();

        assert_eq!(
            value,
            json!({
                "scopeName": "source.test",
                "patterns": [
                    {
                        "match": "<([a-z]+)>",
                        "applyEndPatternLast": 1
                    },
                    {}
                ],
                "enabled": true
            })
        );
    }

    #[test]
    fn decodes_numeric_and_named_entities_once() {
        let value = parse_plist(
            r#"<plist><array>
                <string>&#65;&#x1f600;&amp;&lt;&gt;&quot;&apos;</string>
                <string>&amp;#65;</string>
            </array></plist>"#,
        )
        .unwrap();

        assert_eq!(value, json!(["A😀&<>\"'", "&#65;"]));
    }
}
