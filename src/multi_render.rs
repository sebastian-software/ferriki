//! Inline multi-theme HTML for the private Node render operation.

use crate::render::{escape_attribute, escape_html};
use crate::{
    FontStyle, HighlightThemeToken, HighlightThemeTokenStyle, HighlightTokensWithThemesResult,
    RenderOptions,
};

pub struct MultiThemeRenderOptions {
    pub render: RenderOptions,
    pub default_color: Option<String>,
    pub css_variable_prefix: String,
}

pub fn render_html_with_themes(
    result: &HighlightTokensWithThemesResult,
    options: &MultiThemeRenderOptions,
) -> String {
    let mut html = String::from("<pre class=\"");
    let mut class = String::from("shiki shiki-themes");
    for theme in &result.themes {
        class.push(' ');
        class.push_str(&theme.name);
    }
    html.push_str(&escape_attribute(&class));
    html.push('"');
    if options.render.include_root_style {
        let style = options
            .render
            .root_style
            .as_deref()
            .filter(|style| !style.is_empty());
        let generated;
        let style = match style {
            Some(style) => style,
            None => {
                let foreground = theme_property(result, options, false);
                let background = theme_property(result, options, true);
                generated = if options.default_color.is_some() {
                    format!("background-color:{background};color:{foreground}")
                } else {
                    format!("{foreground};{background}")
                };
                &generated
            }
        };
        html.push_str(" style=\"");
        html.push_str(&escape_attribute(style));
        html.push('"');
    }
    if let Some(tabindex) = &options.render.tabindex {
        html.push_str(" tabindex=\"");
        html.push_str(&escape_attribute(tabindex));
        html.push('"');
    }
    html.push_str("><code>");
    for (index, line) in result.tokens.iter().enumerate() {
        if index > 0 {
            html.push('\n');
        }
        html.push_str("<span class=\"line\">");
        render_line(&mut html, line, result, options);
        html.push_str("</span>");
    }
    html.push_str("</code></pre>");
    html
}

fn render_line(
    html: &mut String,
    line: &[HighlightThemeToken],
    result: &HighlightTokensWithThemesResult,
    options: &MultiThemeRenderOptions,
) {
    let mut carried = None;
    let mut previous_style: Option<String> = None;
    for (index, token) in line.iter().enumerate() {
        // Combined theme tokens have no top-level fontStyle in the JS
        // pipeline: whitespace takes the following token's complete CSS.
        if options.render.merge_whitespaces
            && index + 1 < line.len()
            && !token.content.is_empty()
            && token.content.chars().all(is_js_whitespace)
        {
            carried.get_or_insert(index);
            continue;
        }
        let style = token_style(token, result, options);
        if !options.render.merge_same_style_tokens || previous_style.as_ref() != Some(&style) {
            if previous_style.is_some() {
                html.push_str("</span>");
            }
            html.push_str("<span");
            if !style.is_empty() {
                html.push_str(" style=\"");
                html.push_str(&escape_attribute(&style));
                html.push('"');
            }
            html.push('>');
            previous_style = Some(style);
        }
        let start = carried.take().unwrap_or(index);
        for piece in &line[start..=index] {
            html.push_str(&escape_html(&piece.content));
        }
    }
    if previous_style.is_some() {
        html.push_str("</span>");
    }
}

// ECMAScript \s, rather than Rust's Unicode White_Space (NEL differs and
// ECMAScript additionally accepts the BOM). Match prepareRenderTokens.
fn is_js_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Property {
    Color,
    Italic,
    Bold,
    Decoration,
}

impl Property {
    const ALL: [Self; 4] = [Self::Color, Self::Italic, Self::Bold, Self::Decoration];
    fn name(self) -> &'static str {
        match self {
            Self::Color => "color",
            Self::Italic => "font-style",
            Self::Bold => "font-weight",
            Self::Decoration => "text-decoration",
        }
    }
    fn suffix(self) -> &'static str {
        match self {
            Self::Color => "",
            Self::Italic => "-font-style",
            Self::Bold => "-font-weight",
            Self::Decoration => "-text-decoration",
        }
    }
    fn value(self, style: Option<&HighlightThemeTokenStyle>) -> Option<&str> {
        let style = style?;
        let font = style.font_style.unwrap_or_default();
        match self {
            Self::Color => style.color.as_deref().filter(|color| !color.is_empty()),
            Self::Italic => font.contains(FontStyle::ITALIC).then_some("italic"),
            Self::Bold => font.contains(FontStyle::BOLD).then_some("bold"),
            Self::Decoration => match (
                font.contains(FontStyle::UNDERLINE),
                font.contains(FontStyle::STRIKETHROUGH),
            ) {
                (true, true) => Some("underline line-through"),
                (true, false) => Some("underline"),
                (false, true) => Some("line-through"),
                (false, false) => None,
            },
        }
    }
}

fn separator(output: &mut String) {
    if !output.is_empty() {
        output.push(';');
    }
}

fn token_style(
    token: &HighlightThemeToken,
    result: &HighlightTokensWithThemesResult,
    options: &MultiThemeRenderOptions,
) -> String {
    // JS Set preserves the first occurrence of each property across themes.
    // Four slots suffice for the fixed property set, without per-token keys.
    let mut keys = [Property::Color; 4];
    let mut count = 0;
    for theme in &result.themes {
        let style = token.variants.get(&theme.color);
        for key in Property::ALL {
            if key.value(style).is_some() && !keys[..count].contains(&key) {
                keys[count] = key;
                count += 1;
            }
        }
    }
    let mut output = String::new();
    let light_dark = options.default_color.as_deref() == Some("light-dark()");
    for (index, theme) in result.themes.iter().enumerate() {
        for &key in &keys[..count] {
            let value = key
                .value(token.variants.get(&theme.color))
                .unwrap_or("inherit");
            if index == 0 && options.default_color.is_some() && key == Property::Color {
                separator(&mut output);
                output.push_str(key.name());
                output.push(':');
                if light_dark {
                    let light = key.value(token.variants.get("light")).unwrap_or("inherit");
                    let dark = key.value(token.variants.get("dark")).unwrap_or("inherit");
                    output.push_str("light-dark(");
                    output.push_str(light);
                    output.push_str(", ");
                    output.push_str(dark);
                    output.push(')');
                } else {
                    output.push_str(value);
                }
            }
            if index > 0 || options.default_color.is_none() || key != Property::Color || light_dark
            {
                separator(&mut output);
                output.push_str(&options.css_variable_prefix);
                output.push_str(&theme.color);
                output.push_str(key.suffix());
                output.push(':');
                output.push_str(value);
            }
        }
    }
    output
}

fn theme_property(
    result: &HighlightTokensWithThemesResult,
    options: &MultiThemeRenderOptions,
    background: bool,
) -> String {
    let read = |index: usize| {
        let theme = &result.themes[index];
        let value = if background {
            &theme.background
        } else {
            &theme.foreground
        };
        if value.is_empty() {
            "inherit"
        } else {
            value.as_str()
        }
    };
    let mut output = String::new();
    let light_dark = options.default_color.as_deref() == Some("light-dark()");
    for (index, theme) in result.themes.iter().enumerate() {
        if index == 0 && options.default_color.is_some() {
            if light_dark {
                let light = result
                    .themes
                    .iter()
                    .position(|theme| theme.color == "light")
                    .map(read)
                    .unwrap_or("inherit");
                let dark = result
                    .themes
                    .iter()
                    .position(|theme| theme.color == "dark")
                    .map(read)
                    .unwrap_or("inherit");
                output.push_str("light-dark(");
                output.push_str(light);
                output.push_str(", ");
                output.push_str(dark);
                output.push(')');
            } else {
                output.push_str(read(index));
            }
        }
        if index > 0 || options.default_color.is_none() || light_dark {
            separator(&mut output);
            output.push_str(&options.css_variable_prefix);
            output.push_str(&theme.color);
            if background {
                output.push_str("-bg");
            }
            output.push(':');
            output.push_str(read(index));
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HighlightThemeMetadata;
    use std::collections::BTreeMap;

    fn fixture() -> HighlightTokensWithThemesResult {
        HighlightTokensWithThemesResult {
            themes: vec![
                HighlightThemeMetadata {
                    color: "light".into(),
                    name: "light".into(),
                    foreground: "#111".into(),
                    background: String::new(),
                },
                HighlightThemeMetadata {
                    color: "dark".into(),
                    name: "dark<&\"".into(),
                    foreground: "#eee".into(),
                    background: "#222".into(),
                },
            ],
            tokens: vec![
                vec![HighlightThemeToken {
                    content: "<&>".into(),
                    offset: 0,
                    token_type: None,
                    scope_names: None,
                    variants: BTreeMap::from([
                        (
                            "light".into(),
                            HighlightThemeTokenStyle {
                                color: Some("#123".into()),
                                font_style: Some(FontStyle::UNDERLINE),
                            },
                        ),
                        (
                            "dark".into(),
                            HighlightThemeTokenStyle {
                                color: None,
                                font_style: Some(
                                    FontStyle::ITALIC | FontStyle::BOLD | FontStyle::STRIKETHROUGH,
                                ),
                            },
                        ),
                    ]),
                }],
                vec![],
            ],
        }
    }

    fn options(default_color: Option<&str>) -> MultiThemeRenderOptions {
        MultiThemeRenderOptions {
            render: RenderOptions::default(),
            default_color: default_color.map(str::to_owned),
            css_variable_prefix: "--shiki-".into(),
        }
    }

    #[test]
    fn ordered_css_union_escapes_html_and_keeps_empty_lines() {
        let html = render_html_with_themes(&fixture(), &options(None));
        assert!(html.starts_with(concat!(
            "<pre class=\"shiki shiki-themes light dark&#x3C;&#x26;&#x22;\" ",
            "style=\"--shiki-light:#111;--shiki-dark:#eee;--shiki-light-bg:inherit;--shiki-dark-bg:#222\" tabindex=\"0\"><code>"
        )));
        assert!(html.contains(concat!(
            "<span style=\"--shiki-light:#123;--shiki-light-text-decoration:underline;",
            "--shiki-light-font-style:inherit;--shiki-light-font-weight:inherit;",
            "--shiki-dark:inherit;--shiki-dark-text-decoration:line-through;",
            "--shiki-dark-font-style:italic;--shiki-dark-font-weight:bold\">&#x3C;&#x26;></span>"
        )));
        assert!(html.ends_with("</span>\n<span class=\"line\"></span></code></pre>"));
    }

    #[test]
    fn default_color_and_light_dark_keep_literal_and_variable_order() {
        let result = fixture();
        let html = render_html_with_themes(&result, &options(Some("light")));
        assert!(html.contains(
            "style=\"background-color:inherit;--shiki-dark-bg:#222;color:#111;--shiki-dark:#eee\""
        ));
        assert!(html.contains("<span style=\"color:#123;--shiki-light-text-decoration:underline;"));
        assert!(!html.contains("--shiki-light:#123"));
        let html = render_html_with_themes(&result, &options(Some("light-dark()")));
        assert!(html.contains("background-color:light-dark(inherit, #222);--shiki-light-bg:inherit;--shiki-dark-bg:#222;color:light-dark(#111, #eee);--shiki-light:#111;--shiki-dark:#eee"));
        assert!(html.contains("color:light-dark(#123, inherit);--shiki-light:#123;"));
        // A named variant other than light/dark still has inherited values
        // when CSS light-dark() cannot find its corresponding pair.
        let mut missing_pair = result.clone();
        missing_pair.themes[0].color = "custom".into();
        missing_pair.themes.pop();
        let html = render_html_with_themes(&missing_pair, &options(Some("light-dark()")));
        assert!(html.contains("background-color:light-dark(inherit, inherit)"));
    }

    #[test]
    fn root_controls_and_missing_styles_preserve_the_host_contract() {
        let mut result = fixture();
        result.tokens[0][0].variants.clear();
        let mut opts = options(None);
        opts.render.root_style = Some("<&\"".into());
        opts.render.tabindex = Some("<&\"".into());
        let html = render_html_with_themes(&result, &opts);
        assert!(html.contains("style=\"&#x3C;&#x26;&#x22;\" tabindex=\"&#x3C;&#x26;&#x22;\""));
        assert!(html.contains("<span>&#x3C;&#x26;></span>"));
        opts.render.include_root_style = false;
        opts.render.tabindex = None;
        let html = render_html_with_themes(&result, &opts);
        assert!(!html.contains(" style="));
        assert!(!html.contains("tabindex="));
        opts.render.include_root_style = true;
        opts.render.root_style = Some(String::new());
        opts.css_variable_prefix = "--custom-<&\"".into();
        let html = render_html_with_themes(&result, &opts);
        assert!(html.contains("--custom-&#x3C;&#x26;&#x22;light:#111"));
    }

    #[test]
    fn whitespace_and_equal_style_merging_keep_source_and_span_boundaries() {
        let mut result = fixture();
        let styled = result.tokens[0][0].clone();
        let mut plain = styled.clone();
        plain.content = "\u{feff}".into();
        plain.variants.clear();
        result.tokens = vec![vec![plain.clone(), styled.clone()]];
        let mut opts = options(None);
        let html = render_html_with_themes(&result, &opts);
        assert!(html.contains(">\u{feff}&#x3C;&#x26;></span>"));
        assert_eq!(html.matches("<span").count(), 2);
        opts.render.merge_whitespaces = false;
        assert_eq!(
            render_html_with_themes(&result, &opts)
                .matches("<span")
                .count(),
            3
        );
        opts.render.merge_whitespaces = true;
        result.tokens[0][0].content = "\u{85}".into();
        assert_eq!(
            render_html_with_themes(&result, &opts)
                .matches("<span")
                .count(),
            3
        );
        result.tokens[0] = vec![styled.clone(), styled];
        opts.render.merge_same_style_tokens = true;
        assert_eq!(
            render_html_with_themes(&result, &opts)
                .matches("<span")
                .count(),
            2
        );
        plain.content.clear();
        result.tokens[0].push(plain);
        assert_eq!(
            render_html_with_themes(&result, &opts)
                .matches("<span")
                .count(),
            3
        );
    }
}
