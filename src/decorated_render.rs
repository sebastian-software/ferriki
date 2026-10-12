//! Complete native rendering for the Node facade's declarative HTML lane.
//! The stable Rust render API is unchanged; this is a private consumer bridge.
use crate::decorations::{
    DecorationBoundaries, DecorationNode, DecorationRange, DecorationSource, DecorationTarget,
    DecorationToken, decoration_sections, plan_decoration_mutations,
};
use crate::render::{escape_attribute, escape_html, prepare_tokens, token_style};
use crate::{HighlightTokensResult, RenderOptions};

pub struct HtmlDecoration {
    pub range: DecorationRange,
    pub tag_name: String,
    /// Ordered, normalized HTML attributes; opaque JS values stay in the host.
    pub properties: Vec<(String, String)>,
}

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
                return;
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
        });
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
    for edit in plan.mutations {
        let decoration = &decorations[edit.decoration];
        if edit.target == DecorationTarget::Wrapper {
            let children = nodes[edit.line].children[edit.start..edit.start + edit.count].to_vec();
            debug_assert_eq!(edit.node, nodes.len());
            nodes.push(Node::element(&decoration.tag_name, Vec::new(), children));
        }
        let node = &mut nodes[edit.node];
        node.tag = Some(decoration.tag_name.clone());
        for (key, value) in &decoration.properties {
            if let Some((_, old)) = node
                .properties
                .iter_mut()
                .find(|(existing, _)| existing == key)
            {
                old.clone_from(value);
            } else {
                node.properties.push((key.clone(), value.clone()));
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
        let default = format!(
            "background-color:{};color:{}",
            result.background, result.foreground
        );
        let style = options
            .root_style
            .as_deref()
            .filter(|style| !style.is_empty())
            .unwrap_or(&default);
        html.push_str(" style=\"");
        html.push_str(&escape_attribute(style));
        html.push('"');
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

fn write_node(nodes: &[Node], index: usize, html: &mut String) {
    let node = &nodes[index];
    let Some(tag) = &node.tag else {
        html.push_str(&escape_html(&node.text));
        return;
    };
    html.push('<');
    html.push_str(tag);
    for (key, value) in &node.properties {
        html.push(' ');
        html.push_str(key);
        html.push_str("=\"");
        html.push_str(&escape_attribute(value));
        html.push('"');
    }
    html.push('>');
    for child in &node.children {
        write_node(nodes, *child, html);
    }
    html.push_str("</");
    html.push_str(tag);
    html.push('>');
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
        item.properties.push(("style".into(), "custom".into()));
        let html =
            render_html_with_decorations("abc", &result("abc"), &RenderOptions::default(), &[item])
                .unwrap()
                .unwrap();
        assert!(html.contains("<mark style=\"custom\" class=\"selected\" title="));
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
}
