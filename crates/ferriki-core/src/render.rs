use ferriki_textmate::FontStyle;
use serde_json::{json, Map, Value};

use crate::{HighlightToken, HighlightTokensResult};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderOptions {
    pub merge_whitespaces: bool,
    pub merge_same_style_tokens: bool,
    pub root_style: Option<String>,
    pub include_root_style: bool,
    pub tabindex: Option<String>,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            merge_whitespaces: true,
            merge_same_style_tokens: false,
            root_style: None,
            include_root_style: true,
            tabindex: Some("0".to_owned()),
        }
    }
}

pub fn render_html(result: &HighlightTokensResult, options: &RenderOptions) -> String {
    render_hast(result, options)
        .get("children")
        .and_then(Value::as_array)
        .and_then(|children| children.first())
        .map_or_else(String::new, hast_node_to_html)
}

pub fn render_hast(result: &HighlightTokensResult, options: &RenderOptions) -> Value {
    let tokens = prepare_tokens(&result.tokens, options);
    let mut pre_properties = Map::new();
    pre_properties.insert(
        "class".to_owned(),
        Value::String(format!("shiki {}", result.theme_name)),
    );
    if options.include_root_style {
        pre_properties.insert(
            "style".to_owned(),
            Value::String(options.root_style.clone().unwrap_or_else(|| {
                format!(
                    "background-color:{};color:{}",
                    result.background, result.foreground
                )
            })),
        );
    }
    if let Some(tabindex) = options.tabindex.as_ref() {
        pre_properties.insert("tabindex".to_owned(), Value::String(tabindex.clone()));
    }

    let mut code_children = Vec::new();
    for (line_index, line) in tokens.iter().enumerate() {
        if line_index > 0 {
            code_children.push(json!({ "type": "text", "value": "\n" }));
        }
        let children = line
            .iter()
            .map(|token| {
                let mut properties = Map::new();
                let style = token_style(token);
                if !style.is_empty() {
                    properties.insert("style".to_owned(), Value::String(style));
                }
                json!({
                    "type": "element",
                    "tagName": "span",
                    "properties": properties,
                    "children": [{
                        "type": "text",
                        "value": token.content,
                    }],
                })
            })
            .collect::<Vec<_>>();
        code_children.push(json!({
            "type": "element",
            "tagName": "span",
            "properties": { "class": "line" },
            "children": children,
        }));
    }

    json!({
        "type": "root",
        "children": [{
            "type": "element",
            "tagName": "pre",
            "properties": pre_properties,
            "children": [{
                "type": "element",
                "tagName": "code",
                "properties": {},
                "children": code_children,
            }],
        }],
    })
}

fn prepare_tokens(
    source: &[Vec<HighlightToken>],
    options: &RenderOptions,
) -> Vec<Vec<HighlightToken>> {
    let tokens = if options.merge_whitespaces {
        merge_whitespace_tokens(source)
    } else {
        source.to_vec()
    };
    if options.merge_same_style_tokens {
        merge_adjacent_styled_tokens(&tokens)
    } else {
        tokens
    }
}

fn merge_whitespace_tokens(source: &[Vec<HighlightToken>]) -> Vec<Vec<HighlightToken>> {
    source
        .iter()
        .map(|line| {
            let mut output = Vec::new();
            let mut carried = String::new();
            let mut first_offset = None;
            for (index, token) in line.iter().enumerate() {
                let decorated = has_decoration(token);
                if !decorated
                    && !token.content.is_empty()
                    && token.content.chars().all(char::is_whitespace)
                    && line.get(index + 1).is_some()
                {
                    first_offset.get_or_insert(token.offset);
                    carried.push_str(&token.content);
                    continue;
                }

                if carried.is_empty() {
                    output.push(token.clone());
                } else if !decorated {
                    let mut merged = token.clone();
                    merged.offset = first_offset.expect("carried whitespace has an offset");
                    merged.content = format!("{carried}{}", token.content);
                    output.push(merged);
                    carried.clear();
                    first_offset = None;
                } else {
                    output.push(HighlightToken {
                        content: std::mem::take(&mut carried),
                        offset: first_offset
                            .take()
                            .expect("carried whitespace has an offset"),
                        color: None,
                        font_style: None,
                        token_type: None,
                    });
                    output.push(token.clone());
                }
            }
            output
        })
        .collect()
}

fn merge_adjacent_styled_tokens(source: &[Vec<HighlightToken>]) -> Vec<Vec<HighlightToken>> {
    source
        .iter()
        .map(|line| {
            let mut output: Vec<HighlightToken> = Vec::new();
            for token in line {
                let Some(previous) = output.last_mut() else {
                    output.push(token.clone());
                    continue;
                };
                if !has_decoration(previous)
                    && !has_decoration(token)
                    && token_style(previous) == token_style(token)
                {
                    previous.content.push_str(&token.content);
                } else {
                    output.push(token.clone());
                }
            }
            output
        })
        .collect()
}

fn token_style(token: &HighlightToken) -> String {
    let mut declarations = Vec::new();
    if let Some(color) = token.color.as_ref().filter(|color| !color.is_empty()) {
        declarations.push(format!("color:{color}"));
    }
    let style = FontStyle::from_bits(token.font_style.unwrap_or_default());
    if style.contains(FontStyle::ITALIC) {
        declarations.push("font-style:italic".to_owned());
    }
    if style.contains(FontStyle::BOLD) {
        declarations.push("font-weight:bold".to_owned());
    }
    let mut decorations = Vec::new();
    if style.contains(FontStyle::UNDERLINE) {
        decorations.push("underline");
    }
    if style.contains(FontStyle::STRIKETHROUGH) {
        decorations.push("line-through");
    }
    if !decorations.is_empty() {
        declarations.push(format!("text-decoration:{}", decorations.join(" ")));
    }
    declarations.join(";")
}

fn has_decoration(token: &HighlightToken) -> bool {
    let style = FontStyle::from_bits(token.font_style.unwrap_or_default());
    style.contains(FontStyle::UNDERLINE) || style.contains(FontStyle::STRIKETHROUGH)
}

fn hast_node_to_html(node: &Value) -> String {
    match node.get("type").and_then(Value::as_str) {
        Some("text") => escape_html(
            node.get("value")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        Some("element") => {
            let tag_name = node
                .get("tagName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mut output = format!("<{tag_name}");
            if let Some(properties) = node.get("properties").and_then(Value::as_object) {
                for (key, value) in properties {
                    if let Some(value) = value.as_str() {
                        output.push(' ');
                        output.push_str(key);
                        output.push_str("=\"");
                        output.push_str(&escape_attribute(value));
                        output.push('"');
                    }
                }
            }
            output.push('>');
            if let Some(children) = node.get("children").and_then(Value::as_array) {
                for child in children {
                    output.push_str(&hast_node_to_html(child));
                }
            }
            output.push_str("</");
            output.push_str(tag_name);
            output.push('>');
            output
        }
        _ => String::new(),
    }
}

fn escape_html(input: &str) -> String {
    input.replace('&', "&#x26;").replace('<', "&#x3C;")
}

fn escape_attribute(input: &str) -> String {
    escape_html(input).replace('"', "&#x22;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HighlighterCore, TokenizeOptions};
    use std::path::Path;

    fn javascript_tokens(code: &str) -> HighlightTokensResult {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/shiki");
        HighlighterCore::with_standard_assets(&root)
            .expect("highlighter")
            .tokenize(
                code,
                "javascript",
                "nord",
                &TokenizeOptions {
                    time_limit_millis: 0,
                    ..TokenizeOptions::default()
                },
            )
            .expect("tokens")
    }

    #[test]
    fn renders_shiki_classic_html() {
        let html = render_html(
            &javascript_tokens("console.log(\"Hi\")"),
            &RenderOptions::default(),
        );

        assert_eq!(
            html,
            "<pre class=\"shiki nord\" style=\"background-color:#2e3440ff;color:#d8dee9ff\" tabindex=\"0\"><code><span class=\"line\"><span style=\"color:#D8DEE9\">console</span><span style=\"color:#ECEFF4\">.</span><span style=\"color:#88C0D0\">log</span><span style=\"color:#D8DEE9FF\">(</span><span style=\"color:#ECEFF4\">\"</span><span style=\"color:#A3BE8C\">Hi</span><span style=\"color:#ECEFF4\">\"</span><span style=\"color:#D8DEE9FF\">)</span></span></code></pre>"
        );
    }

    #[test]
    fn renders_hast_lines_and_escapes_source_only_in_html() {
        let result = javascript_tokens("a < b\n");
        let hast = render_hast(&result, &RenderOptions::default());
        let html = render_html(&result, &RenderOptions::default());

        assert_eq!(hast["type"], "root");
        assert_eq!(
            hast["children"][0]["children"][0]["children"][2]["properties"]["class"],
            "line"
        );
        assert!(html.contains("&#x3C;"));
        assert!(!hast.to_string().contains("&#x3C;"));
    }
}
