use ferriki_textmate::FontStyle;
use serde_json::{Map, Value, json};

use crate::{HighlightToken, HighlightTokensResult};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Controls how theme styles are emitted.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[non_exhaustive]
pub enum StyleMode {
    #[default]
    Inline,
    Classes,
}

/// Class-based HTML and the stylesheet required by its resolved theme.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HtmlWithCss {
    pub html: String,
    pub css: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub struct RenderOptions {
    pub style_mode: StyleMode,
    pub merge_whitespaces: bool,
    pub merge_same_style_tokens: bool,
    pub root_style: Option<String>,
    pub include_root_style: bool,
    pub tabindex: Option<String>,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            style_mode: StyleMode::Inline,
            merge_whitespaces: true,
            merge_same_style_tokens: false,
            root_style: None,
            include_root_style: true,
            tabindex: Some("0".to_owned()),
        }
    }
}

pub fn render_html(result: &HighlightTokensResult, options: &RenderOptions) -> String {
    if options.style_mode == StyleMode::Classes {
        return render_hast(result, options)
            .get("children")
            .and_then(Value::as_array)
            .and_then(|children| children.first())
            .map_or_else(String::new, hast_node_to_html);
    }

    // Match the HAST serializer's property order without constructing a tree.
    let mut html = String::from("<pre class=\"");
    html.push_str(&escape_attribute(&format!("shiki {}", result.theme_name)));
    html.push('"');
    if options.include_root_style {
        let style = options.root_style.clone().unwrap_or_else(|| {
            format!(
                "background-color:{};color:{}",
                result.background, result.foreground
            )
        });
        html.push_str(" style=\"");
        html.push_str(&escape_attribute(&style));
        html.push('"');
    }
    if let Some(tabindex) = options.tabindex.as_ref() {
        html.push_str(" tabindex=\"");
        html.push_str(&escape_attribute(tabindex));
        html.push('"');
    }
    html.push_str("><code>");
    for (line_index, line) in prepare_tokens(&result.tokens, options).iter().enumerate() {
        if line_index > 0 {
            html.push('\n');
        }
        html.push_str("<span class=\"line\">");
        for token in line {
            html.push_str("<span");
            let style = token_style(token);
            if !style.is_empty() {
                html.push_str(" style=\"");
                html.push_str(&escape_attribute(&style));
                html.push('"');
            }
            html.push('>');
            html.push_str(&escape_html(&token.content));
            html.push_str("</span>");
        }
        html.push_str("</span>");
    }
    html.push_str("</code></pre>");
    html
}

/// Renders trusted, tag-balanced HTML fragments for each highlighted line.
///
/// The fragments contain escaped source text and escaped style attributes.
/// They do not include line wrappers or a `<pre><code>` pair, so a Markdown
/// renderer can own those structures and its line annotations. The number of
/// fragments matches `result.tokens.len()`, including trailing empty lines.
pub fn render_html_lines(result: &HighlightTokensResult, options: &RenderOptions) -> Vec<String> {
    if options.style_mode == StyleMode::Classes {
        let hast = render_hast(result, options);
        return hast["children"][0]["children"][0]["children"]
            .as_array()
            .expect("code children")
            .iter()
            .filter(|node| node["type"] == "element")
            .map(|line| {
                line["children"]
                    .as_array()
                    .expect("line children")
                    .iter()
                    .map(hast_node_to_html)
                    .collect()
            })
            .collect();
    }
    prepare_tokens(&result.tokens, options)
        .iter()
        .map(|line| {
            let mut html = String::new();
            for token in line {
                html.push_str("<span");
                let style = token_style(token);
                if !style.is_empty() {
                    html.push_str(" style=\"");
                    html.push_str(&escape_attribute(&style));
                    html.push('"');
                }
                html.push('>');
                html.push_str(&escape_html(&token.content));
                html.push_str("</span>");
            }
            html
        })
        .collect()
}

fn render_styled_hast(result: &HighlightTokensResult, options: &RenderOptions) -> Value {
    let tokens = prepare_tokens(&result.tokens, options);
    let mut pre_properties = Map::new();
    pre_properties.insert(
        "class".to_owned(),
        Value::String(if options.style_mode == StyleMode::Classes {
            format!("ferriki {}", result.theme_name)
        } else {
            format!("shiki {}", result.theme_name)
        }),
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
        let mut children = line
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
        if options.style_mode == StyleMode::Classes {
            children = nest_scope_tokens(line, children);
        }
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

/// Renders a HAST tree, with styles extracted to classes when requested.
pub fn render_hast(result: &HighlightTokensResult, options: &RenderOptions) -> Value {
    let mut tree = render_styled_hast(result, options);
    if options.style_mode == StyleMode::Classes {
        extract_styles(&mut tree, &mut BTreeMap::new());
    }
    tree
}

/// Renders class-based HTML with CSS for this block. Combine CSS from every block.
/// Existing TextMate themes are resolved during tokenization and need no conversion.
pub fn render_html_with_css(
    result: &HighlightTokensResult,
    options: &RenderOptions,
) -> HtmlWithCss {
    let options = options.clone().with_style_mode(StyleMode::Classes);
    let mut tree = render_styled_hast(result, &options);
    let mut rules = BTreeMap::new();
    extract_styles(&mut tree, &mut rules);
    HtmlWithCss {
        html: hast_node_to_html(&tree["children"][0]),
        css: rules.into_values().collect::<Vec<_>>().join("\n"),
    }
}

fn extract_styles(node: &mut Value, rules: &mut BTreeMap<String, String>) {
    if let Some(properties) = node.get_mut("properties").and_then(Value::as_object_mut)
        && let Some(style) = properties
            .remove("style")
            .and_then(|value| value.as_str().map(str::to_owned))
    {
        let name = format!("ferriki-style-{:x}", Sha256::digest(style.as_bytes()));
        let class = properties
            .get("class")
            .and_then(Value::as_str)
            .unwrap_or("");
        properties.insert(
            "class".to_owned(),
            Value::String(format!("{class} {name}").trim().to_owned()),
        );
        rules.insert(name.clone(), format!(":where(.{name}){{{style}}}"));
    }
    if let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) {
        for child in children {
            extract_styles(child, rules);
        }
    }
}

fn scope_class(scope: &str) -> String {
    scope
        .chars()
        .map(|character| {
            if character == '.' {
                "-".to_owned()
            } else if character.is_ascii_alphanumeric() {
                character.to_string()
            } else {
                format!("_{:x}_", u32::from(character))
            }
        })
        .collect()
}

fn scope_prefixes(scope: &str, prefix: &str) -> Vec<String> {
    let parts: Vec<_> = scope.split('.').collect();
    (1..=parts.len())
        .map(|end| format!("{prefix}-{}", scope_class(&parts[..end].join("."))))
        .collect()
}

fn nest_scope_tokens(tokens: &[HighlightToken], nodes: Vec<Value>) -> Vec<Value> {
    let mut output = Vec::new();
    let mut stack: Vec<Value> = Vec::new();
    let mut open: Vec<String> = Vec::new();
    fn append(output: &mut Vec<Value>, stack: &mut [Value], node: Value) {
        if let Some(parent) = stack.last_mut() {
            parent["children"]
                .as_array_mut()
                .expect("scope children")
                .push(node);
        } else {
            output.push(node);
        }
    }
    for (token, mut node) in tokens.iter().zip(nodes) {
        let scopes = token.scope_names.as_deref().unwrap_or_default();
        let shared = open
            .iter()
            .zip(scopes)
            .take_while(|(left, right)| left == right)
            .count();
        while stack.len() > shared {
            let wrapper = stack.pop().expect("open scope");
            append(&mut output, &mut stack, wrapper);
        }
        for scope in &scopes[shared..] {
            let mut classes = scope_prefixes(scope, "scope");
            classes.push(format!("exact-{}", scope_class(scope)));
            stack.push(json!({"type":"element", "tagName":"span", "properties":{"class":classes.join(" ")}, "children":[]}));
        }
        let mut classes = vec!["token".to_owned()];
        for scope in scopes {
            for class in scope_prefixes(scope, "tok") {
                if !classes.contains(&class) {
                    classes.push(class);
                }
            }
        }
        if let Some(scope) = scopes.last() {
            classes.extend(scope_prefixes(scope, "leaf"));
        }
        node["properties"]["class"] = Value::String(classes.join(" "));
        append(&mut output, &mut stack, node);
        open = scopes.to_vec();
    }
    while let Some(wrapper) = stack.pop() {
        append(&mut output, &mut stack, wrapper);
    }
    output
}

fn prepare_tokens(
    source: &[Vec<HighlightToken>],
    options: &RenderOptions,
) -> Vec<Vec<HighlightToken>> {
    if options.style_mode == StyleMode::Classes {
        return source.to_vec();
    }
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
                        scope_names: None,
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
    let style = token.font_style.unwrap_or_default();
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
    let style = token.font_style.unwrap_or_default();
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

impl RenderOptions {
    /// Emits nested scope classes. Tokenize with `preserve_scope_boundaries` to retain all scopes.
    #[must_use]
    pub fn with_style_mode(mut self, value: StyleMode) -> Self {
        self.style_mode = value;
        self
    }

    /// Sets `merge_whitespaces`.
    #[must_use]
    pub fn with_merge_whitespaces(mut self, value: bool) -> Self {
        self.merge_whitespaces = value;
        self
    }
    /// Sets `merge_same_style_tokens`.
    #[must_use]
    pub fn with_merge_same_style_tokens(mut self, value: bool) -> Self {
        self.merge_same_style_tokens = value;
        self
    }
    /// Sets `root_style`.
    #[must_use]
    pub fn with_root_style(mut self, value: Option<String>) -> Self {
        self.root_style = value;
        self
    }
    /// Sets `include_root_style`.
    #[must_use]
    pub fn with_include_root_style(mut self, value: bool) -> Self {
        self.include_root_style = value;
        self
    }
    /// Sets `tabindex`.
    #[must_use]
    pub fn with_tabindex(mut self, value: Option<String>) -> Self {
        self.tabindex = value;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{__private::HighlighterCore, TokenizeOptions};
    use std::path::Path;

    fn javascript_tokens(code: &str) -> HighlightTokensResult {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/shiki");
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

    fn assert_html_matches_hast(result: &HighlightTokensResult, options: &RenderOptions) {
        let tree = render_hast(result, options);
        let expected = hast_node_to_html(&tree["children"][0]);
        assert_eq!(render_html(result, options), expected, "{options:?}");
    }

    #[test]
    fn direct_inline_html_matches_hast_for_render_controls_and_escaping() {
        let mut line = Vec::new();
        for bits in -1..=15 {
            let token = HighlightToken {
                content: "<😀&\"' >\t".to_owned(),
                offset: 0,
                color: Some("color<&\"'".to_owned()),
                font_style: Some(FontStyle::from_bits(bits)),
                token_type: None,
                scope_names: Some(vec!["source.probe".to_owned()]),
            };
            line.push(token.clone());
            line.push(token);
            line.push(HighlightToken {
                content: " \t\u{a0}".to_owned(),
                offset: 0,
                color: None,
                font_style: None,
                token_type: None,
                scope_names: None,
            });
        }
        line.push(HighlightToken {
            content: String::new(),
            offset: 0,
            color: Some(String::new()),
            font_style: Some(FontStyle::NONE),
            token_type: None,
            scope_names: None,
        });
        let mut result = HighlightTokensResult {
            tokens: vec![line, Vec::new(), Vec::new()],
            foreground: "fg<&\"".to_owned(),
            background: "bg<&\"".to_owned(),
            theme_name: "theme<&\"'".to_owned(),
        };
        for merge_whitespaces in [false, true] {
            for merge_same_style_tokens in [false, true] {
                for include_root_style in [false, true] {
                    for root_style in [None, Some(""), Some("custom:<&\"'")] {
                        for tabindex in [None, Some(""), Some("-1<&\"'")] {
                            let options = RenderOptions::default()
                                .with_merge_whitespaces(merge_whitespaces)
                                .with_merge_same_style_tokens(merge_same_style_tokens)
                                .with_include_root_style(include_root_style)
                                .with_root_style(root_style.map(str::to_owned))
                                .with_tabindex(tabindex.map(str::to_owned));
                            assert_html_matches_hast(&result, &options);
                        }
                    }
                }
            }
        }
        result.tokens = vec![Vec::new()];
        assert_html_matches_hast(&result, &RenderOptions::default());
        result.tokens.clear();
        assert_html_matches_hast(&result, &RenderOptions::default());
    }

    #[test]
    fn direct_inline_html_matches_hast_for_benchmark_fixtures() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let corpus = root.join("node/benchmarks/tiobe");
        let manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(corpus.join("manifest.json")).expect("fixture manifest"),
        )
        .expect("fixture manifest JSON");
        let mut highlighter =
            HighlighterCore::with_standard_assets(&root.join("assets/shiki")).expect("highlighter");
        for language in manifest["languages"].as_array().expect("fixture languages") {
            let Some(grammar) = language["textmate"].as_str() else {
                continue;
            };
            let code = std::fs::read_to_string(
                corpus
                    .join("fixtures")
                    .join(language["file"].as_str().expect("fixture file")),
            )
            .expect("fixture source");
            for theme in ["github-dark", "nord"] {
                let result = highlighter
                    .tokenize(
                        &code,
                        grammar,
                        theme,
                        &TokenizeOptions::default().with_time_limit_millis(0),
                    )
                    .expect("fixture tokens");
                for merge_whitespaces in [false, true] {
                    for merge_same_style_tokens in [false, true] {
                        let options = RenderOptions::default()
                            .with_merge_whitespaces(merge_whitespaces)
                            .with_merge_same_style_tokens(merge_same_style_tokens);
                        assert_html_matches_hast(&result, &options);
                    }
                }
            }
        }
    }

    #[test]
    fn class_rendering_retains_order_repetition_and_escapes_scope_names() {
        let mut result = javascript_tokens("AB");
        let mut first = result.tokens[0][0].clone();
        first.content = "<😀&".to_owned();
        first.scope_names = Some(vec![
            "source.probe".to_owned(),
            "meta.a".to_owned(),
            "meta.a".to_owned(),
            "entity.name.probe".to_owned(),
        ]);
        let mut second = first.clone();
        second.content = "B".to_owned();
        second.scope_names = Some(vec![
            "source.probe".to_owned(),
            "meta.a-b".to_owned(),
            "entity.name.probe".to_owned(),
        ]);
        result.tokens = vec![vec![first, second], vec![]];
        let options = RenderOptions::default().with_style_mode(StyleMode::Classes);
        let rendered = render_html_with_css(&result, &options);
        assert!(!rendered.html.contains(" style="));
        assert!(!rendered.html.contains("exact-meta-a-b"));
        assert!(rendered.html.contains("exact-meta-a_2d_b"));
        assert_eq!(rendered.html.matches("exact-meta-a\"").count(), 2);
        assert!(rendered.html.contains("&#x3C;😀&#x26;"));
        assert_eq!(rendered.html, render_html(&result, &options));
        assert_eq!(render_html_lines(&result, &options).len(), 2);
        assert_eq!(rendered.css.lines().count(), 2);
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

    #[test]
    fn line_fragments_match_the_html_renderer_inner_content() {
        let result = javascript_tokens("a < b\n\"x\" & 😀\n");
        let options = RenderOptions::default();
        let hast = render_hast(&result, &options);
        let lines = render_html_lines(&result, &options);
        let children = hast["children"][0]["children"][0]["children"]
            .as_array()
            .expect("code children");
        let expected = children
            .iter()
            .filter(|node| node["type"] == "element")
            .map(|line| {
                line["children"]
                    .as_array()
                    .expect("line children")
                    .iter()
                    .map(hast_node_to_html)
                    .collect::<String>()
            })
            .collect::<Vec<_>>();

        assert_eq!(lines, expected);
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("&#x3C;"));
        assert!(lines[1].contains("&#x26;"));
        assert!(lines[2].is_empty());
    }
}
