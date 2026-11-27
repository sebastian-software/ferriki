//! Complete native rendering for the Node facade's declarative HTML lane.
//! The stable Rust render API is unchanged; this is a private consumer bridge.
use crate::decorations::{
    DecorationBoundaries, DecorationNode, DecorationRange, DecorationSource, DecorationTarget,
    DecorationToken, decoration_sections, plan_decoration_mutations,
};
use crate::render::{
    default_root_style, escape_attribute, escape_html, is_safe_decoration_attribute_name,
    is_safe_decoration_attribute_value, is_safe_decoration_tag_name, is_valid_html_attribute_name,
    is_valid_html_tag_name, prepare_tokens, sanitize_css_declarations, token_style,
};
use crate::{HighlightTokensResult, RenderOptions};
use std::borrow::Cow;
use std::collections::HashMap;

pub struct HtmlDecoration {
    pub range: DecorationRange,
    pub tag_name: String,
    /// Ordered, normalized HTML attributes; opaque JS values stay in the host.
    pub properties: Vec<(String, String)>,
}

type PreparedProperties<'a> = Vec<(&'a str, Cow<'a, str>)>;

struct Node {
    tag: Option<String>,
    properties: Vec<(String, String)>,
    text: String,
    children: Vec<usize>,
}

impl Node {
    fn element(tag: &str, properties: Vec<(String, String)>, children: Vec<usize>) -> Self {
        Self {
            tag: Some(tag.to_owned()),
            properties,
            text: String::new(),
            children,
        }
    }
}

/// `None` preserves the JS path when a range cuts inside a UTF-16 surrogate
/// pair. Rust strings cannot represent the individual halves without loss.
pub fn render_html_with_decorations(
    source: &str,
    result: &HighlightTokensResult,
    options: &RenderOptions,
    decorations: &[HtmlDecoration],
) -> Result<Option<String>, String> {
    for decoration in decorations {
        if !is_safe_decoration_tag_name(&decoration.tag_name) {
            return Err(format!("Invalid HTML tag name `{}`", decoration.tag_name));
        }
        for (key, value) in &decoration.properties {
            if !is_safe_decoration_attribute_name(key) {
                return Err(format!("Invalid HTML attribute name `{key}`"));
            }
            if !is_safe_decoration_attribute_value(key, value) {
                return Err(format!("Invalid HTML attribute value for `{key}`"));
            }
        }
    }
    let ranges = DecorationSource::utf16(source).resolve_ranges(
        &decorations
            .iter()
            .map(|item| item.range)
            .collect::<Vec<_>>(),
    )?;
    let boundaries = DecorationBoundaries::new(&ranges);
    let mut nodes = Vec::new();
    let mut lines = Vec::new();
    let mut metadata = Vec::new();
    for line in prepare_tokens(&result.tokens, options) {
        let line_id = nodes.len();
        nodes.push(Node::element(
            "span",
            vec![("class".into(), "line".into())],
            Vec::new(),
        ));
        lines.push(line_id);
        metadata.clear();
        metadata.extend(line.iter().map(|token| DecorationToken {
            offset: token.offset,
            length: token.content.encode_utf16().count(),
        }));
        let mut unsupported = false;
        boundaries.split_tokens(&metadata, |slice| {
            let token = &line[slice.token];
            let Some(content) = utf16_slice(&token.content, slice.start, slice.end) else {
                unsupported = true;
                return Ok(());
            };
            let style = token_style(token);
            let properties = if style.is_empty() {
                Vec::new()
            } else {
                vec![("style".into(), style)]
            };
            let span = nodes.len();
            nodes.push(Node::element("span", properties, vec![span + 1]));
            nodes.push(Node {
                tag: None,
                properties: Vec::new(),
                text: content.to_owned(),
                children: Vec::new(),
            });
            nodes[line_id].children.push(span);
            Ok(())
        })?;
        if unsupported {
            return Ok(None);
        }
    }
    let geometry = nodes
        .iter()
        .map(|node| DecorationNode {
            element: node.tag.is_some(),
            text_length: node.text.encode_utf16().count(),
            children: node.children.clone(),
        })
        .collect();
    let plan = plan_decoration_mutations(geometry, &lines, &decoration_sections(&ranges));
    if let Some(error) = plan.error {
        return Err(error);
    }
    let mut prepared_properties: Vec<Option<PreparedProperties<'_>>> =
        vec![None; decorations.len()];
    for edit in plan.mutations {
        let decoration = &decorations[edit.decoration];
        if edit.target == DecorationTarget::Wrapper {
            let children = nodes[edit.line].children[edit.start..edit.start + edit.count].to_vec();
            debug_assert_eq!(edit.node, nodes.len());
            nodes.push(Node::element(&decoration.tag_name, Vec::new(), children));
        }
        let prepared = prepared_properties[edit.decoration]
            .get_or_insert_with(|| prepare_decoration_properties(&decoration.properties));
        let node = &mut nodes[edit.node];
        node.tag = Some(decoration.tag_name.clone());
        for (key, value) in prepared.iter() {
            if *key == "style" {
                if let Some((existing, old)) = node
                    .properties
                    .iter_mut()
                    .find(|(existing, _)| existing.eq_ignore_ascii_case("style"))
                {
                    existing.clear();
                    existing.push_str("style");
                    old.clear();
                    old.push_str(value);
                } else {
                    node.properties.push(("style".into(), value.to_string()));
                }
                continue;
            }
            if let Some((_, old)) = node
                .properties
                .iter_mut()
                .find(|(existing, _)| existing == key)
            {
                old.clear();
                old.push_str(value);
            } else {
                node.properties.push(((*key).to_owned(), value.to_string()));
            }
        }
        if edit.target != DecorationTarget::Line {
            nodes[edit.line]
                .children
                .splice(edit.start..edit.start + edit.count, [edit.node]);
        }
    }
    let mut html = String::from("<pre class=\"");
    html.push_str(&escape_attribute(&format!("shiki {}", result.theme_name)));
    html.push('"');
    if options.include_root_style {
        let default = default_root_style(&result.background, &result.foreground);
        let style = options
            .root_style
            .as_deref()
            .filter(|style| !style.is_empty())
            .unwrap_or(&default);
        if !style.is_empty() {
            html.push_str(" style=\"");
            html.push_str(&escape_attribute(style));
            html.push('"');
        }
    }
    if let Some(tabindex) = &options.tabindex {
        html.push_str(" tabindex=\"");
        html.push_str(&escape_attribute(tabindex));
        html.push('"');
    }
    html.push_str("><code>");
    for (index, line) in lines.into_iter().enumerate() {
        if index > 0 {
            html.push('\n');
        }
        write_node(&nodes, line, &mut html);
    }
    html.push_str("</code></pre>");
    Ok(Some(html))
}

fn prepare_decoration_properties<'a>(raw: &'a [(String, String)]) -> PreparedProperties<'a> {
    let mut props: PreparedProperties<'a> = Vec::with_capacity(raw.len());
    let mut index_by_key: HashMap<&'a str, usize> = HashMap::with_capacity(raw.len());
    for (key, value) in raw {
        if key.eq_ignore_ascii_case("style") {
            let sanitized = sanitize_css_declarations(value);
            if let Some(&slot) = index_by_key.get("style") {
                props[slot].1 = Cow::Owned(sanitized);
            } else {
                let slot = props.len();
                index_by_key.insert("style", slot);
                props.push(("style", Cow::Owned(sanitized)));
            }
        } else if let Some(&slot) = index_by_key.get(key.as_str()) {
            props[slot].1 = Cow::Borrowed(value.as_str());
        } else {
            let slot = props.len();
            index_by_key.insert(key.as_str(), slot);
            props.push((key.as_str(), Cow::Borrowed(value.as_str())));
        }
    }
    props
}

fn utf16_slice(text: &str, start: usize, end: usize) -> Option<&str> {
    let mut units = 0;
    let mut start_byte = None;
    let mut end_byte = None;
    for (byte, character) in text
        .char_indices()
        .chain(std::iter::once((text.len(), '\0')))
    {
        if units == start {
            start_byte = Some(byte);
        }
        if units == end {
            end_byte = Some(byte);
            break;
        }
        units += character.len_utf16();
    }
    Some(&text[start_byte?..end_byte?])
}

struct WriteFrame {
    index: usize,
    next_child: usize,
}

fn write_open_node(node: &Node, html: &mut String) -> bool {
    let Some(tag) = &node.tag else {
        html.push_str(&escape_html(&node.text));
        return false;
    };
    if !is_valid_html_tag_name(tag) {
        return false;
    }
    html.push('<');
    html.push_str(tag);
    for (key, value) in &node.properties {
        if !is_valid_html_attribute_name(key)
            || (key.eq_ignore_ascii_case("style") && value.is_empty())
        {
            continue;
        }
        html.push(' ');
        html.push_str(key);
        html.push_str("=\"");
        html.push_str(&escape_attribute(value));
        html.push('"');
    }
    html.push('>');
    true
}

fn write_node(nodes: &[Node], root: usize, html: &mut String) {
    if !write_open_node(&nodes[root], html) {
        return;
    }
    let mut stack = vec![WriteFrame {
        index: root,
        next_child: 0,
    }];
    while let Some(frame) = stack.last_mut() {
        if let Some(&child) = nodes[frame.index].children.get(frame.next_child) {
            frame.next_child += 1;
            if write_open_node(&nodes[child], html) {
                stack.push(WriteFrame {
                    index: child,
                    next_child: 0,
                });
            }
        } else {
            let finished = stack.pop().expect("active write frame must exist");
            if let Some(tag) = &nodes[finished.index].tag {
                html.push_str("</");
                html.push_str(tag);
                html.push('>');
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decorations::DecorationPosition;
    use crate::{FontStyle, HighlightToken};

    fn result(source: &str) -> HighlightTokensResult {
        let mut offset = 0;
        HighlightTokensResult {
            tokens: source
                .split('\n')
                .map(|content| {
                    let token = HighlightToken {
                        content: content.into(),
                        offset,
                        color: Some("red".into()),
                        font_style: Some(FontStyle::ITALIC | FontStyle::UNDERLINE),
                        token_type: None,
                        scope_names: None,
                    };
                    offset += content.encode_utf16().count() + 1;
                    vec![token]
                })
                .collect(),
            foreground: "black".into(),
            background: "white".into(),
            theme_name: "test".into(),
        }
    }
    fn decoration(start: usize, end: usize, always_wrap: bool) -> HtmlDecoration {
        HtmlDecoration {
            range: DecorationRange {
                start: DecorationPosition::Offset(start),
                end: DecorationPosition::Offset(end),
                always_wrap,
            },
            tag_name: "mark".into(),
            properties: vec![
                ("class".into(), "selected".into()),
                ("title".into(), "<&\"".into()),
            ],
        }
    }
    #[test]
    fn unicode_slicing_preserves_boundaries_and_rejects_surrogate_halves() {
        assert_eq!(utf16_slice("a😀z", 1, 3), Some("😀"));
        assert_eq!(utf16_slice("a😀z", 2, 3), None);
        assert_eq!(utf16_slice("a😀z", 0, 2), None);
        assert_eq!(utf16_slice("", 0, 0), Some(""));
        assert_eq!(utf16_slice("a", 2, 3), None);
    }
    #[test]
    fn renders_nested_wrappers_line_targets_and_ordered_attributes() {
        let source = "ab😀c\n<&>";
        let html = render_html_with_decorations(
            source,
            &result(source),
            &RenderOptions::default(),
            &[decoration(0, 9, false), decoration(1, 5, true)],
        )
        .unwrap()
        .unwrap();
        assert!(html.contains("<mark class=\"selected\" title=\"&#x3C;&#x26;&#x22;\">"));
        assert!(html.contains("😀c"));
        assert!(html.contains("&#x3C;&#x26;>"));
        assert!(html.contains("font-style:italic;text-decoration:underline"));
        assert_eq!(html.matches("<mark").count(), 3);
        let mut item = decoration(0, 2, false);
        item.properties.push(("style".into(), "color:blue".into()));
        let html =
            render_html_with_decorations("abc", &result("abc"), &RenderOptions::default(), &[item])
                .unwrap()
                .unwrap();
        assert!(html.contains("<mark style=\"color:blue\" class=\"selected\" title="));
    }
    #[test]
    fn empty_ranges_root_controls_and_plain_tokens_match_the_render_contract() {
        let mut tokens = result("abc");
        tokens.tokens[0][0].color = None;
        tokens.tokens[0][0].font_style = None;
        let options = RenderOptions::default()
            .with_include_root_style(false)
            .with_tabindex(None);
        let html =
            render_html_with_decorations("abc", &tokens, &options, &[decoration(1, 1, true)])
                .unwrap()
                .unwrap();
        assert!(html.starts_with("<pre class=\"shiki test\"><code>"));
        assert!(html.contains("<mark class=\"selected\" title=\"&#x3C;&#x26;&#x22;\"></mark>"));
        for style in ["", "color:blue"] {
            let options = RenderOptions::default().with_root_style(Some(style.into()));
            let html = render_html_with_decorations(
                "abc",
                &result("abc"),
                &options,
                &[decoration(0, 3, false)],
            )
            .unwrap()
            .unwrap();
            assert!(html.contains(if style.is_empty() {
                "background-color:white;color:black"
            } else {
                style
            }));
        }
    }
    #[test]
    fn invalid_ranges_and_inconsistent_token_geometry_fail_without_html() {
        assert!(
            render_html_with_decorations(
                "abc",
                &result("abc"),
                &RenderOptions::default(),
                &[decoration(2, 1, false)]
            )
            .is_err()
        );
        assert!(
            render_html_with_decorations(
                "abc",
                &result("a"),
                &RenderOptions::default(),
                &[decoration(1, 3, false)]
            )
            .is_err()
        );
        assert!(
            render_html_with_decorations(
                "a😀z",
                &result("a😀z"),
                &RenderOptions::default(),
                &[decoration(2, 3, false)]
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn renders_deeply_nested_always_wrap_decorations_without_stack_overflow() {
        // End-to-end check for stacked alwaysWrap decorations.
        let small: Vec<_> = (0..8)
            .map(|_| HtmlDecoration {
                range: DecorationRange {
                    start: DecorationPosition::Offset(0),
                    end: DecorationPosition::Offset(1),
                    always_wrap: true,
                },
                tag_name: "span".into(),
                properties: vec![("class".into(), "w".into())],
            })
            .collect();
        let small_html =
            render_html_with_decorations("a", &result("a"), &RenderOptions::default(), &small)
                .unwrap()
                .unwrap();
        assert_eq!(small_html.matches("<span class=\"w\">").count(), 8);
        assert!(small_html.contains(">a</span>"));

        // Direct writer regression for 20,000-deep wrapper chains without O(D^2) range validation.
        const DEPTH: usize = 20_000;
        let mut nodes = Vec::with_capacity(DEPTH + 1);
        nodes.push(Node {
            tag: None,
            properties: Vec::new(),
            text: "a".into(),
            children: Vec::new(),
        });
        for child in 0..DEPTH {
            nodes.push(Node::element(
                "span",
                vec![("class".into(), "w".into())],
                vec![child],
            ));
        }
        let mut html = String::new();
        write_node(&nodes, DEPTH, &mut html);
        assert_eq!(html.matches("<span class=\"w\">").count(), DEPTH);
        assert!(html.contains(">a</span>"));
    }

    #[test]
    fn rejects_overflowing_token_offset_in_decorated_render() {
        let mut tokens = result("abc");
        tokens.tokens[0][0].offset = usize::MAX;
        let err = render_html_with_decorations(
            "abc",
            &tokens,
            &RenderOptions::default(),
            &[decoration(0, 3, false)],
        )
        .unwrap_err();
        assert!(err.contains("overflow"));
    }

    #[test]
    fn rejects_invalid_html_tag_and_attribute_names_and_sanitizes_theme_colors() {
        for bad_tag in [
            "",
            "1div",
            "-div",
            "span><script>alert(1)</script><span",
            "div onclick=alert(1)",
            "span/x",
            "span\0",
            "script",
            "SCRIPT",
            "style",
            "iframe",
            "object",
            "embed",
            "link",
            "meta",
            "base",
            "plaintext",
            "ferriki-code",
            "x-custom-el",
            "syntax-token_v2",
            "form",
            "input",
            "svg",
            "math",
            "template",
        ] {
            let mut item = decoration(0, 3, false);
            item.tag_name = bad_tag.into();
            assert!(
                render_html_with_decorations(
                    "abc",
                    &result("abc"),
                    &RenderOptions::default(),
                    &[item]
                )
                .is_err(),
                "expected invalid tag error for {bad_tag:?}"
            );
        }

        for bad_attr in [
            "",
            "a b",
            "x=1",
            "x\" onclick=\"alert(1)",
            "x'y",
            "x>y",
            "x<y",
            "x/y",
            "x\0y",
            "x\ny",
            "onclick",
            "ONLOAD",
            "onmouseover",
            "srcdoc",
            "SRCDOC",
            "action",
            "attributionsrc",
            "background",
            "formaction",
            "is",
            "IS",
            "ping",
            "srcset",
        ] {
            let mut item = decoration(0, 3, false);
            item.properties = vec![(bad_attr.into(), "val".into())];
            assert!(
                render_html_with_decorations(
                    "abc",
                    &result("abc"),
                    &RenderOptions::default(),
                    &[item]
                )
                .is_err(),
                "expected invalid attribute error for {bad_attr:?}"
            );
        }

        for bad_url in [
            "javascript:alert(1)",
            "JAVASCRIPT:alert(1)",
            "java\tscript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "//evil.example/x",
            "\\evil.example/x",
            "http:evil.example",
            "mailto:   ",
        ] {
            let mut item = decoration(0, 3, false);
            item.tag_name = "a".into();
            item.properties = vec![("href".into(), bad_url.into())];
            assert!(
                render_html_with_decorations(
                    "abc",
                    &result("abc"),
                    &RenderOptions::default(),
                    &[item]
                )
                .is_err(),
                "expected unsafe URL error for {bad_url:?}"
            );
        }

        for safe_url in [
            "https://example.com/docs",
            "http://example.com",
            "mailto:dev@example.com",
            "/docs/guide",
            "./local",
            "#line-4",
            "?tab=code",
        ] {
            let mut item = decoration(0, 3, false);
            item.tag_name = "a".into();
            item.properties = vec![("href".into(), safe_url.into())];
            let html = render_html_with_decorations(
                "abc",
                &result("abc"),
                &RenderOptions::default(),
                &[item],
            )
            .unwrap()
            .unwrap();
            assert!(html.contains(&format!("href=\"{safe_url}\"")));
        }

        let mut strong_tag = decoration(0, 3, false);
        strong_tag.tag_name = "strong".into();
        let strong_html = render_html_with_decorations(
            "abc",
            &result("abc"),
            &RenderOptions::default(),
            &[strong_tag],
        )
        .unwrap()
        .unwrap();
        assert!(strong_html.contains("<strong "));
        assert!(strong_html.contains("</strong>"));

        // 200-CJK-char custom property fits the 512 UTF-16 code unit limit (even though >512 UTF-8 bytes).
        let cjk_style = format!("--cjk:\"{}\"", "漢".repeat(200));
        let mut cjk_item = decoration(0, 2, false);
        cjk_item.properties = vec![("style".into(), cjk_style.clone())];
        let cjk_html = render_html_with_decorations(
            "abc",
            &result("abc"),
            &RenderOptions::default(),
            &[cjk_item],
        )
        .unwrap()
        .unwrap();
        assert!(cjk_html.contains(&escape_attribute(&cjk_style).into_owned()));

        let mut tokens = result("abc");
        tokens.background = "white;position:fixed".into();
        tokens.foreground = "#111".into();
        let html = render_html_with_decorations(
            "abc",
            &tokens,
            &RenderOptions::default(),
            &[decoration(0, 3, false)],
        )
        .unwrap()
        .unwrap();
        assert!(!html.contains("position:fixed"));
        assert!(html.contains("style=\"color:#111\""));

        // Inline decoration `style` / `STYLE` properties are sanitized and canonicalized.
        let mut mixed_style = decoration(0, 2, false);
        mixed_style.properties = vec![(
            "STYLE".into(),
            "background:url(https://evil.test);font-weight:bold".into(),
        )];
        let mixed_html = render_html_with_decorations(
            "abc",
            &result("abc"),
            &RenderOptions::default(),
            &[mixed_style],
        )
        .unwrap()
        .unwrap();
        assert!(!mixed_html.contains("url("));
        assert!(!mixed_html.contains("STYLE="));
        assert!(mixed_html.contains("<mark style=\"font-weight:bold\">"));

        let mut hostile_style = decoration(0, 2, false);
        hostile_style.properties =
            vec![("style".into(), "background:url(https://evil.test)".into())];
        let hostile_html = render_html_with_decorations(
            "abc",
            &result("abc"),
            &RenderOptions::default(),
            &[hostile_style],
        )
        .unwrap()
        .unwrap();
        assert!(!hostile_html.contains("url("));
        assert!(hostile_html.contains("<mark>ab</mark>"));

        // An empty earlier case variant reserves the canonical `style` slot order for later variants.
        let mut ordered_style = decoration(0, 2, false);
        ordered_style.properties = vec![
            ("STYLE".into(), "".into()),
            ("title".into(), "note".into()),
            ("style".into(), "color:red".into()),
        ];
        let ordered_html = render_html_with_decorations(
            "abc",
            &result("abc"),
            &RenderOptions::default(),
            &[ordered_style],
        )
        .unwrap()
        .unwrap();
        assert!(ordered_html.contains("<mark style=\"color:red\" title=\"note\">"));

        // Reserving an empty `style` slot persists across separate decorations until serialization.
        let mut first_dec = decoration(0, 2, false);
        first_dec.properties = vec![("style".into(), "".into()), ("title".into(), "note".into())];
        let mut second_dec = decoration(0, 2, false);
        second_dec.properties = vec![("style".into(), "color:red".into())];
        let chained_html = render_html_with_decorations(
            "abc",
            &result("abc"),
            &RenderOptions::default(),
            &[first_dec, second_dec],
        )
        .unwrap()
        .unwrap();
        assert!(chained_html.contains("<mark style=\"color:red\" title=\"note\">"));
    }
}
