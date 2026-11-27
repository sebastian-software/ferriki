use ferriki_textmate::FontStyle;
use serde_json::{Map, Value, json};

use crate::asset_source::sha256_hex;
use crate::{HighlightToken, HighlightTokensResult};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;

const EFFECTIVE_FONT_STYLE_MASK: i32 = FontStyle::ITALIC.bits()
    | FontStyle::BOLD.bits()
    | FontStyle::UNDERLINE.bits()
    | FontStyle::STRIKETHROUGH.bits();

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
        return render_class_html_and_css(
            result,
            options,
            ClassTokenCssMode::Minimal,
            false,
            false,
        )
        .html;
    }

    // Match the HAST serializer's property order without constructing a tree.
    let mut html = String::with_capacity(estimate_inline_html_capacity(&result.tokens));
    write_inline_pre_open(
        &mut html,
        &result.theme_name,
        &result.background,
        &result.foreground,
        options,
    );
    for (line_index, line) in result.tokens.iter().enumerate() {
        if line_index > 0 {
            html.push('\n');
        }
        html.push_str("<span class=\"line\">");
        render_inline_tokens(&mut html, line, options);
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
        return render_class_html_lines(result);
    }
    result
        .tokens
        .iter()
        .map(|line| {
            let mut content_bytes = 0usize;
            for token in line {
                content_bytes = content_bytes.saturating_add(token.content.len());
            }
            let overhead = if options.merge_same_style_tokens {
                64
            } else {
                line.len().saturating_mul(32)
            };
            let cap = bounded_token_html_capacity(content_bytes, overhead);
            let mut html = String::with_capacity(cap);
            render_inline_tokens(&mut html, line, options);
            html
        })
        .collect()
}

const MAX_ESTIMATED_TOKEN_HTML_OVERHEAD: usize = 4 * 1024 * 1024;
const MAX_SPECULATIVE_SOURCE_HTML_OVERHEAD: usize = 1024 * 1024;

pub(crate) fn bounded_token_html_capacity(content_bytes: usize, overhead: usize) -> usize {
    content_bytes.saturating_add(overhead.min(MAX_ESTIMATED_TOKEN_HTML_OVERHEAD))
}

pub(crate) fn bounded_source_html_capacity(source_bytes: usize) -> usize {
    let overhead = source_bytes
        .saturating_mul(3)
        .saturating_add(128)
        .min(MAX_SPECULATIVE_SOURCE_HTML_OVERHEAD);
    source_bytes.saturating_add(overhead)
}

fn estimate_inline_html_capacity(lines: &[Vec<HighlightToken>]) -> usize {
    let mut content_bytes = 0usize;
    let mut overhead = 128usize;
    for line in lines {
        overhead = overhead
            .saturating_add(28)
            .saturating_add(line.len().saturating_mul(32));
        for token in line {
            content_bytes = content_bytes.saturating_add(token.content.len());
        }
    }
    bounded_token_html_capacity(content_bytes, overhead)
}

fn estimate_class_html_capacity(lines: &[Vec<HighlightToken>]) -> usize {
    let mut content_bytes = 0usize;
    let mut overhead = 256usize;
    for line in lines {
        overhead = overhead
            .saturating_add(28)
            .saturating_add(line.len().saturating_mul(96));
        for token in line {
            content_bytes = content_bytes.saturating_add(token.content.len());
        }
    }
    bounded_token_html_capacity(content_bytes, overhead)
}

pub(crate) fn write_inline_pre_open(
    html: &mut String,
    theme_name: &str,
    background: &str,
    foreground: &str,
    options: &RenderOptions,
) {
    html.push_str("<pre class=\"shiki ");
    write_escaped_attribute(html, theme_name);
    html.push('"');
    if options.include_root_style {
        match options.root_style.as_deref() {
            Some(style) => {
                html.push_str(" style=\"");
                write_escaped_attribute(html, style);
                html.push('"');
            }
            None => {
                let style = default_root_style(background, foreground);
                if !style.is_empty() {
                    html.push_str(" style=\"");
                    write_escaped_attribute(html, &style);
                    html.push('"');
                }
            }
        }
    }
    if let Some(tabindex) = options.tabindex.as_ref() {
        html.push_str(" tabindex=\"");
        write_escaped_attribute(html, tabindex);
        html.push('"');
    }
    html.push_str("><code>");
}

#[derive(Clone, Copy)]
pub(crate) struct BorrowedInlineToken<'a> {
    pub(crate) content: &'a str,
    pub(crate) color: Option<&'a str>,
    pub(crate) font_style: FontStyle,
}

fn font_style_has_decoration(style: FontStyle) -> bool {
    style.contains(FontStyle::UNDERLINE) || style.contains(FontStyle::STRIKETHROUGH)
}

fn write_inline_style_declarations(html: &mut String, color: Option<&str>, style: FontStyle) {
    let mut has_style = false;
    let mut push_decl = |name: &str, value: &str| {
        if has_style {
            html.push(';');
        } else {
            html.push_str(" style=\"");
            has_style = true;
        }
        html.push_str(name);
        html.push(':');
        write_escaped_attribute(html, value);
    };
    if let Some(color) = color {
        push_decl("color", color);
    }
    if style.contains(FontStyle::ITALIC) {
        push_decl("font-style", "italic");
    }
    if style.contains(FontStyle::BOLD) {
        push_decl("font-weight", "bold");
    }
    match (
        style.contains(FontStyle::UNDERLINE),
        style.contains(FontStyle::STRIKETHROUGH),
    ) {
        (true, true) => push_decl("text-decoration", "underline line-through"),
        (true, false) => push_decl("text-decoration", "underline"),
        (false, true) => push_decl("text-decoration", "line-through"),
        (false, false) => {}
    }
    if has_style {
        html.push('"');
    }
}

/// Renders one line of pre-sanitized borrowed inline tokens directly into `html`
/// without intermediate `HighlightToken` or per-token `String` allocations.
pub(crate) fn render_borrowed_inline_tokens<'a>(
    html: &mut String,
    line: &[BorrowedInlineToken<'a>],
    options: &RenderOptions,
) {
    let merge_whitespaces = options.merge_whitespaces;
    let merge_same = options.merge_same_style_tokens;
    let mut start = 0usize;
    let mut open_span: Option<(Option<&'a str>, i32, bool)> = None;

    let mut emit = |color: Option<&'a str>,
                    font_style: FontStyle,
                    decorated: bool,
                    slice: &[BorrowedInlineToken<'a>]| {
        let style_bits = font_style.bits() & EFFECTIVE_FONT_STYLE_MASK;
        let can_merge = merge_same
            && !decorated
            && matches!(
                open_span,
                Some((prev_color, prev_bits, false))
                    if prev_color == color && prev_bits == style_bits
            );
        if !can_merge {
            if open_span.is_some() {
                html.push_str("</span>");
            }
            html.push_str("<span");
            write_inline_style_declarations(html, color, font_style);
            html.push('>');
            open_span = Some((color, style_bits, decorated));
        }
        for token in slice {
            write_escaped_html(html, token.content);
        }
    };

    for (index, token) in line.iter().enumerate() {
        let decorated = font_style_has_decoration(token.font_style);
        if merge_whitespaces
            && !decorated
            && !token.content.is_empty()
            && token.content.chars().all(char::is_whitespace)
            && index + 1 < line.len()
        {
            continue;
        }
        if start < index && decorated {
            // Carried whitespace before an underlined/struck token stays unstyled.
            emit(None, FontStyle::NONE, false, &line[start..index]);
            start = index;
        }
        emit(
            token.color,
            token.font_style,
            decorated,
            &line[start..=index],
        );
        start = index + 1;
    }
    if open_span.is_some() {
        html.push_str("</span>");
    }
}

fn render_inline_tokens<'a>(
    html: &mut String,
    line: &'a [HighlightToken],
    options: &RenderOptions,
) {
    let merge_whitespaces = options.merge_whitespaces;
    let merge_same = options.merge_same_style_tokens;
    let mut start = 0usize;
    let mut open_span: Option<(Option<Cow<'a, str>>, i32, bool)> = None;

    let mut emit = |color: Option<Cow<'a, str>>,
                    font_style: FontStyle,
                    decorated: bool,
                    slice: &'a [HighlightToken]| {
        let style_bits = font_style.bits() & EFFECTIVE_FONT_STYLE_MASK;
        let can_merge = merge_same
            && !decorated
            && matches!(
                &open_span,
                Some((prev_color, prev_bits, false))
                    if prev_color.as_deref() == color.as_deref() && *prev_bits == style_bits
            );
        if !can_merge {
            if open_span.is_some() {
                html.push_str("</span>");
            }
            html.push_str("<span");
            write_inline_style_declarations(html, color.as_deref(), font_style);
            html.push('>');
            open_span = Some((color, style_bits, decorated));
        }
        for token in slice {
            write_escaped_html(html, &token.content);
        }
    };

    for (index, token) in line.iter().enumerate() {
        let font_style = token.font_style.unwrap_or_default();
        let decorated = font_style_has_decoration(font_style);
        if merge_whitespaces
            && !decorated
            && !token.content.is_empty()
            && token.content.chars().all(char::is_whitespace)
            && index + 1 < line.len()
        {
            continue;
        }
        if start < index && decorated {
            // Carried whitespace before an underlined/struck token stays unstyled.
            emit(None, FontStyle::NONE, false, &line[start..index]);
            start = index;
        }
        let color = token.color.as_deref().and_then(normalize_safe_css_color);
        emit(color, font_style, decorated, &line[start..=index]);
        start = index + 1;
    }
    if open_span.is_some() {
        html.push_str("</span>");
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ClassTokenCssMode {
    Minimal,
    ExplicitDefaults,
}

fn token_css_explicit_defaults(color: Option<&str>, font_style: FontStyle) -> String {
    let mut output = String::with_capacity(96);
    if let Some(color) = color.and_then(normalize_safe_css_color) {
        output.push_str("color:");
        output.push_str(&color);
        output.push(';');
    }
    output.push_str("font-style:");
    output.push_str(if font_style.contains(FontStyle::ITALIC) {
        "italic"
    } else {
        "normal"
    });
    output.push_str(";font-weight:");
    output.push_str(if font_style.contains(FontStyle::BOLD) {
        "bold"
    } else {
        "normal"
    });
    output.push_str(";text-decoration:");
    output.push_str(
        match (
            font_style.contains(FontStyle::UNDERLINE),
            font_style.contains(FontStyle::STRIKETHROUGH),
        ) {
            (true, true) => "underline line-through",
            (true, false) => "underline",
            (false, true) => "line-through",
            (false, false) => "none",
        },
    );
    output
}

#[derive(Default)]
struct StyleExtractor<'a> {
    raw_to_class: HashMap<String, Option<String>>,
    token_to_class: HashMap<(Option<&'a str>, i32), Option<String>>,
    sanitized_to_class: HashMap<String, String>,
    rules: BTreeMap<String, String>,
}

impl<'a> StyleExtractor<'a> {
    fn intern_sanitized(&mut self, sanitized: String, collect_css: bool) -> String {
        if let Some(existing) = self.sanitized_to_class.get(&sanitized) {
            return existing.clone();
        }
        let name = format!("ferriki-style-{}", sha256_hex(sanitized.as_bytes()));
        if collect_css {
            self.rules
                .insert(name.clone(), format!(":where(.{name}){{{sanitized}}}"));
        }
        self.sanitized_to_class.insert(sanitized, name.clone());
        name
    }

    fn class_for_raw_style(&mut self, raw: &str, collect_css: bool) -> Option<&str> {
        if !self.raw_to_class.contains_key(raw) {
            let sanitized = sanitize_css_declarations(raw);
            let class_name = if sanitized.is_empty() {
                None
            } else {
                Some(self.intern_sanitized(sanitized, collect_css))
            };
            self.raw_to_class.insert(raw.to_owned(), class_name);
        }
        self.raw_to_class.get(raw).and_then(Option::as_deref)
    }

    fn class_for_token(
        &mut self,
        raw_color: Option<&'a str>,
        font_style: FontStyle,
        css_mode: ClassTokenCssMode,
        collect_css: bool,
    ) -> Option<&str> {
        let key = (raw_color, font_style.bits() & EFFECTIVE_FONT_STYLE_MASK);
        if !self.token_to_class.contains_key(&key) {
            let raw_css = match css_mode {
                ClassTokenCssMode::Minimal => token_style_from_parts(raw_color, font_style),
                ClassTokenCssMode::ExplicitDefaults => {
                    token_css_explicit_defaults(raw_color, font_style)
                }
            };
            let class_name = if raw_css.is_empty() {
                None
            } else {
                self.class_for_raw_style(&raw_css, collect_css)
                    .map(str::to_owned)
            };
            self.token_to_class.insert(key, class_name);
        }
        self.token_to_class.get(&key).and_then(Option::as_deref)
    }

    fn into_css(self) -> String {
        let mut css = String::new();
        for (index, rule) in self.rules.into_values().enumerate() {
            if index > 0 {
                css.push('\n');
            }
            css.push_str(&rule);
        }
        css
    }
}

struct CachedScopeClasses {
    token: Vec<String>,
    leaf: Vec<String>,
    wrapper: String,
}

#[derive(Default)]
struct ScopeClassCache<'a> {
    entries: HashMap<&'a str, CachedScopeClasses>,
    token_classes: HashMap<&'a [String], String>,
}

impl<'a> ScopeClassCache<'a> {
    fn get(&mut self, scope: &'a str) -> &CachedScopeClasses {
        self.entries.entry(scope).or_insert_with(|| {
            let mut encoded = String::with_capacity(scope.len() + 8);
            let mut token = Vec::new();
            let mut leaf = Vec::new();
            let mut wrapper = String::new();
            for (index, segment) in scope.split('.').enumerate() {
                if index > 0 {
                    encoded.push('-');
                }
                write_scope_class_segment(&mut encoded, segment);

                let mut tok_cls = String::with_capacity(4 + encoded.len());
                tok_cls.push_str("tok-");
                tok_cls.push_str(&encoded);
                token.push(tok_cls);

                let mut leaf_cls = String::with_capacity(5 + encoded.len());
                leaf_cls.push_str("leaf-");
                leaf_cls.push_str(&encoded);
                leaf.push(leaf_cls);

                if !wrapper.is_empty() {
                    wrapper.push(' ');
                }
                wrapper.push_str("scope-");
                wrapper.push_str(&encoded);
            }
            if !wrapper.is_empty() {
                wrapper.push(' ');
            }
            wrapper.push_str("exact-");
            wrapper.push_str(&encoded);
            CachedScopeClasses {
                token,
                leaf,
                wrapper,
            }
        })
    }

    fn token_class_for_scopes(&mut self, scopes: &'a [String]) -> &str {
        if scopes.is_empty() {
            return "token";
        }
        if !self.token_classes.contains_key(scopes) {
            for scope in scopes {
                let _ = self.get(scope.as_str());
            }
            let mut seen: Vec<&str> = Vec::new();
            let mut joined = String::from("token");
            for scope in scopes {
                for class in &self.entries[scope.as_str()].token {
                    let s = class.as_str();
                    if !seen.contains(&s) {
                        seen.push(s);
                        joined.push(' ');
                        joined.push_str(s);
                    }
                }
            }
            if let Some(last) = scopes.last() {
                for class in &self.entries[last.as_str()].leaf {
                    joined.push(' ');
                    joined.push_str(class);
                }
            }
            self.token_classes.insert(scopes, joined);
        }
        self.token_classes[scopes].as_str()
    }
}

fn render_class_line<'a>(
    html: &mut String,
    line: &'a [HighlightToken],
    scope_cache: &mut ScopeClassCache<'a>,
    extractor: &mut StyleExtractor<'a>,
    css_mode: ClassTokenCssMode,
    collect_css: bool,
) {
    let mut open: &[String] = &[];
    for token in line {
        let scopes = token.scope_names.as_deref().unwrap_or_default();
        let shared = open
            .iter()
            .zip(scopes)
            .take_while(|(left, right)| left == right)
            .count();
        for _ in shared..open.len() {
            html.push_str("</span>");
        }
        for scope in &scopes[shared..] {
            let wrapper = scope_cache.get(scope.as_str()).wrapper.as_str();
            html.push_str("<span class=\"");
            html.push_str(wrapper);
            html.push_str("\">");
        }
        let token_classes = scope_cache.token_class_for_scopes(scopes);
        let style_class = extractor.class_for_token(
            token.color.as_deref(),
            token.font_style.unwrap_or_default(),
            css_mode,
            collect_css,
        );
        html.push_str("<span class=\"");
        html.push_str(token_classes);
        if let Some(style_class) = style_class {
            html.push(' ');
            html.push_str(style_class);
        }
        html.push_str("\">");
        write_escaped_html(html, &token.content);
        html.push_str("</span>");
        open = scopes;
    }
    for _ in 0..open.len() {
        html.push_str("</span>");
    }
}

fn render_class_html_and_css(
    result: &HighlightTokensResult,
    options: &RenderOptions,
    css_mode: ClassTokenCssMode,
    empty_root_style_uses_default: bool,
    collect_css: bool,
) -> HtmlWithCss {
    let mut scope_cache = ScopeClassCache::default();
    let mut extractor = StyleExtractor::default();
    let mut html = String::with_capacity(estimate_class_html_capacity(&result.tokens));

    let root_style_class = if options.include_root_style {
        let explicit = options
            .root_style
            .as_deref()
            .filter(|style| !empty_root_style_uses_default || !style.is_empty());
        match explicit {
            Some(style) => extractor
                .class_for_raw_style(style, collect_css)
                .map(str::to_owned),
            None => {
                let default_style = default_root_style(&result.background, &result.foreground);
                if default_style.is_empty() {
                    None
                } else {
                    extractor
                        .class_for_raw_style(&default_style, collect_css)
                        .map(str::to_owned)
                }
            }
        }
    } else {
        None
    };

    html.push_str("<pre class=\"ferriki ");
    write_escaped_attribute(&mut html, &result.theme_name);
    if let Some(root_class) = root_style_class.as_deref() {
        html.push(' ');
        html.push_str(root_class);
    }
    html.push('"');
    if let Some(tabindex) = options.tabindex.as_ref() {
        html.push_str(" tabindex=\"");
        write_escaped_attribute(&mut html, tabindex);
        html.push('"');
    }
    html.push_str("><code>");

    for (line_index, line) in result.tokens.iter().enumerate() {
        if line_index > 0 {
            html.push('\n');
        }
        html.push_str("<span class=\"line\">");
        render_class_line(
            &mut html,
            line,
            &mut scope_cache,
            &mut extractor,
            css_mode,
            collect_css,
        );
        html.push_str("</span>");
    }
    html.push_str("</code></pre>");

    HtmlWithCss {
        html,
        css: if collect_css {
            extractor.into_css()
        } else {
            String::new()
        },
    }
}

fn render_class_html_lines(result: &HighlightTokensResult) -> Vec<String> {
    let mut scope_cache = ScopeClassCache::default();
    let mut extractor = StyleExtractor::default();
    result
        .tokens
        .iter()
        .map(|line| {
            let mut content_bytes = 0usize;
            for token in line {
                content_bytes = content_bytes.saturating_add(token.content.len());
            }
            let cap = bounded_token_html_capacity(content_bytes, line.len().saturating_mul(96));
            let mut html = String::with_capacity(cap);
            render_class_line(
                &mut html,
                line,
                &mut scope_cache,
                &mut extractor,
                ClassTokenCssMode::Minimal,
                false,
            );
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
        let style = options
            .root_style
            .clone()
            .unwrap_or_else(|| default_root_style(&result.background, &result.foreground));
        if options.root_style.is_some() || !style.is_empty() {
            pre_properties.insert("style".to_owned(), Value::String(style));
        }
    }
    if let Some(tabindex) = options.tabindex.as_ref() {
        pre_properties.insert("tabindex".to_owned(), Value::String(tabindex.clone()));
    }

    let mut code_children = Vec::new();
    let mut scope_cache = ScopeClassCache::default();
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
            children = nest_scope_tokens(line, children, &mut scope_cache);
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
        let mut extractor = StyleExtractor::default();
        extract_styles_with_extractor(&mut tree, &mut extractor, false);
    }
    tree
}

/// Renders class-based HTML with CSS for this block. Combine CSS from every block.
/// Existing TextMate themes are resolved during tokenization and need no conversion.
pub fn render_html_with_css(
    result: &HighlightTokensResult,
    options: &RenderOptions,
) -> HtmlWithCss {
    render_class_html_and_css(result, options, ClassTokenCssMode::Minimal, false, true)
}

/// Private Node bridge class renderer matching JS `codeToHtmlWithCss` byte-for-byte.
pub fn render_html_with_css_node(
    result: &HighlightTokensResult,
    options: &RenderOptions,
) -> HtmlWithCss {
    render_class_html_and_css(
        result,
        options,
        ClassTokenCssMode::ExplicitDefaults,
        true,
        true,
    )
}

/// Private Node bridge class HTML renderer without stylesheet assembly.
pub fn render_html_node_classes(result: &HighlightTokensResult, options: &RenderOptions) -> String {
    render_class_html_and_css(
        result,
        options,
        ClassTokenCssMode::ExplicitDefaults,
        true,
        false,
    )
    .html
}

#[cfg(test)]
fn extract_styles(node: &mut Value, rules: &mut BTreeMap<String, String>) {
    let mut extractor = StyleExtractor::default();
    extract_styles_with_extractor(node, &mut extractor, true);
    rules.extend(extractor.rules);
}

fn extract_styles_with_extractor(
    node: &mut Value,
    extractor: &mut StyleExtractor<'_>,
    collect_css: bool,
) {
    if let Some(properties) = node.get_mut("properties").and_then(Value::as_object_mut)
        && let Some(style) = properties
            .remove("style")
            .and_then(|value| value.as_str().map(str::to_owned))
        && let Some(name) = extractor.class_for_raw_style(&style, collect_css)
    {
        let class = properties
            .get("class")
            .and_then(Value::as_str)
            .unwrap_or("");
        properties.insert(
            "class".to_owned(),
            Value::String(format!("{class} {name}").trim().to_owned()),
        );
    }
    if let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) {
        for child in children {
            extract_styles_with_extractor(child, extractor, collect_css);
        }
    }
}

fn write_scope_class_segment(output: &mut String, segment: &str) {
    for character in segment.chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character);
        } else {
            let _ = write!(output, "_{:x}_", u32::from(character));
        }
    }
}

fn nest_scope_tokens<'a>(
    tokens: &'a [HighlightToken],
    nodes: Vec<Value>,
    scope_cache: &mut ScopeClassCache<'a>,
) -> Vec<Value> {
    let mut output = Vec::new();
    let mut stack: Vec<Value> = Vec::new();
    let mut open: &[String] = &[];
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
            let wrapper_class = scope_cache.get(scope.as_str()).wrapper.as_str();
            stack.push(json!({"type":"element", "tagName":"span", "properties":{"class":wrapper_class}, "children":[]}));
        }
        let token_classes = scope_cache.token_class_for_scopes(scopes);
        node["properties"]["class"] = Value::String(token_classes.to_owned());
        append(&mut output, &mut stack, node);
        open = scopes;
    }
    while let Some(wrapper) = stack.pop() {
        append(&mut output, &mut stack, wrapper);
    }
    output
}

pub(crate) fn prepare_tokens(
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
            let mut output = Vec::with_capacity(line.len());
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
                    let mut content = String::with_capacity(carried.len() + token.content.len());
                    content.push_str(&carried);
                    content.push_str(&token.content);
                    merged.content = content;
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

fn token_style_key(token: &HighlightToken) -> (Option<Cow<'_, str>>, i32) {
    let color = token.color.as_deref().and_then(normalize_safe_css_color);
    let style_bits = token.font_style.unwrap_or_default().bits() & EFFECTIVE_FONT_STYLE_MASK;
    (color, style_bits)
}

fn merge_adjacent_styled_tokens(source: &[Vec<HighlightToken>]) -> Vec<Vec<HighlightToken>> {
    source
        .iter()
        .map(|line| {
            let mut output: Vec<HighlightToken> = Vec::with_capacity(line.len());
            let mut prev_key: Option<(Option<Cow<'_, str>>, i32, bool)> = None;
            for token in line {
                let decorated = has_decoration(token);
                let (color, style_bits) = token_style_key(token);
                let merged = matches!(
                    &prev_key,
                    Some((prev_color, prev_bits, false))
                        if !decorated
                            && prev_color.as_deref() == color.as_deref()
                            && *prev_bits == style_bits
                );
                if merged {
                    if let Some(previous) = output.last_mut() {
                        previous.content.push_str(&token.content);
                    }
                } else {
                    output.push(token.clone());
                    prev_key = Some((color, style_bits, decorated));
                }
            }
            output
        })
        .collect()
}

pub(crate) fn token_style(token: &HighlightToken) -> String {
    token_style_from_parts(token.color.as_deref(), token.font_style.unwrap_or_default())
}

fn token_style_from_parts(color: Option<&str>, style: FontStyle) -> String {
    let mut declarations = String::new();
    for_each_style_part(color, style, |name, value| {
        let has_declarations = !declarations.is_empty();
        declarations.reserve(usize::from(has_declarations) + name.len() + 1 + value.len());
        if has_declarations {
            declarations.push(';');
        }
        declarations.push_str(name);
        declarations.push(':');
        declarations.push_str(value);
    });
    declarations
}

fn for_each_style_part(color: Option<&str>, style: FontStyle, mut append: impl FnMut(&str, &str)) {
    if let Some(color) = color.and_then(normalize_safe_css_color) {
        append("color", &color);
    }
    if style.contains(FontStyle::ITALIC) {
        append("font-style", "italic");
    }
    if style.contains(FontStyle::BOLD) {
        append("font-weight", "bold");
    }
    match (
        style.contains(FontStyle::UNDERLINE),
        style.contains(FontStyle::STRIKETHROUGH),
    ) {
        (true, true) => append("text-decoration", "underline line-through"),
        (true, false) => append("text-decoration", "underline"),
        (false, true) => append("text-decoration", "line-through"),
        (false, false) => {}
    }
}

fn has_decoration(token: &HighlightToken) -> bool {
    font_style_has_decoration(token.font_style.unwrap_or_default())
}

#[cfg(test)]
fn hast_node_to_html(node: &Value) -> String {
    let mut output = String::new();
    write_hast_node_html(node, &mut output);
    output
}

#[cfg(test)]
fn write_hast_node_html(node: &Value, output: &mut String) {
    match node.get("type").and_then(Value::as_str) {
        Some("text") => {
            if let Some(value) = node.get("value").and_then(Value::as_str) {
                write_escaped_html(output, value);
            }
        }
        Some("element") => {
            let tag_name = node
                .get("tagName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !is_valid_html_tag_name(tag_name) {
                return;
            }
            output.push('<');
            output.push_str(tag_name);
            if let Some(properties) = node.get("properties").and_then(Value::as_object) {
                for (key, value) in properties {
                    if !is_valid_html_attribute_name(key) {
                        continue;
                    }
                    if let Some(value) = value.as_str() {
                        output.push(' ');
                        output.push_str(key);
                        output.push_str("=\"");
                        write_escaped_attribute(output, value);
                        output.push('"');
                    }
                }
            }
            output.push('>');
            if let Some(children) = node.get("children").and_then(Value::as_array) {
                for child in children {
                    write_hast_node_html(child, output);
                }
            }
            output.push_str("</");
            output.push_str(tag_name);
            output.push('>');
        }
        _ => {}
    }
}

const SAFE_COLOR_FUNCTIONS: &[&str] = &[
    "color",
    "color-mix",
    "contrast-color",
    "env",
    "hsl",
    "hsla",
    "hwb",
    "lab",
    "lch",
    "light-dark",
    "oklab",
    "oklch",
    "rgb",
    "rgba",
    "var",
];

const SAFE_COLOR_INNER_FUNCTIONS: &[&str] = &[
    "abs",
    "acos",
    "asin",
    "atan",
    "atan2",
    "calc",
    "clamp",
    "color",
    "color-mix",
    "contrast-color",
    "cos",
    "env",
    "exp",
    "hsl",
    "hsla",
    "hwb",
    "hypot",
    "lab",
    "lch",
    "light-dark",
    "log",
    "max",
    "min",
    "mod",
    "oklab",
    "oklch",
    "pow",
    "rem",
    "rgb",
    "rgba",
    "round",
    "sign",
    "sin",
    "sqrt",
    "tan",
    "var",
];

const UNSAFE_CSS_FUNCTIONS: &[&str] = &[
    "attr",
    "behavior",
    "binding",
    "cross-fade",
    "element",
    "expression",
    "filter",
    "image",
    "image-rect",
    "image-set",
    "paint",
    "src",
    "url",
];

const SAFE_DECORATION_TAGS: &[&str] = &[
    "a",
    "abbr",
    "article",
    "aside",
    "b",
    "bdi",
    "bdo",
    "blockquote",
    "br",
    "caption",
    "cite",
    "code",
    "col",
    "colgroup",
    "data",
    "dd",
    "del",
    "details",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "i",
    "ins",
    "kbd",
    "label",
    "li",
    "main",
    "mark",
    "meter",
    "nav",
    "ol",
    "output",
    "p",
    "pre",
    "progress",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "section",
    "small",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "time",
    "tr",
    "u",
    "ul",
    "var",
    "wbr",
];

const MAX_CSS_IDENTIFIER_LEN: usize = 128;
// Fits a max-length prefix (128) + max-length theme key (128) + "-text-decoration" (16).
const MAX_CSS_PROPERTY_NAME_LEN: usize = 272;
const MAX_CSS_VALUE_LEN: usize = 512;
const MAX_COMPOSED_LIGHT_DARK_LEN: usize = 2 * (2 * MAX_CSS_VALUE_LEN + 160) + 32;
const MAX_COMPOSED_VAR_COLOR_LEN: usize = MAX_COMPOSED_LIGHT_DARK_LEN + 128;
const MAX_VAR_COLOR_WRAPPER_DEPTH: usize = 6;
const MAX_COMPOSED_COLOR_DEPTH: usize = 4;

#[cfg(test)]
fn is_valid_css_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_CSS_IDENTIFIER_LEN {
        return false;
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
fn is_valid_css_variable_prefix(value: &str) -> bool {
    value.len() <= MAX_CSS_IDENTIFIER_LEN
        && value
            .strip_prefix("--")
            .is_some_and(is_valid_css_identifier)
}

pub(crate) fn is_valid_inline_css_variable_prefix(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("--") else {
        return false;
    };
    value.encode_utf16().count() <= MAX_CSS_IDENTIFIER_LEN
        && rest.chars().all(is_valid_css_custom_property_char)
}

pub(crate) fn is_valid_inline_theme_custom_property(prefix: &str, alias: &str) -> bool {
    if alias.is_empty()
        || !is_valid_inline_css_variable_prefix(prefix)
        || !alias.chars().all(is_valid_css_custom_property_char)
    {
        return false;
    }
    let base = format!("{prefix}{alias}");
    format!("{base}-text-decoration").encode_utf16().count() <= MAX_CSS_PROPERTY_NAME_LEN
}

fn is_safe_non_ascii_css_ident_char(ch: char) -> bool {
    (ch as u32) >= 0xa0 && !ch.is_whitespace() && ch != '\u{FEFF}'
}

fn is_valid_css_custom_property_char(ch: char) -> bool {
    if ch.is_ascii() {
        ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'
    } else {
        is_safe_non_ascii_css_ident_char(ch)
    }
}

fn consume_css_ident_escape(input: &str, backslash_index: usize) -> Option<usize> {
    let bytes = input.as_bytes();
    if bytes.get(backslash_index) != Some(&b'\\') {
        return None;
    }
    let next_index = backslash_index + 1;
    let next_char = input.get(next_index..)?.chars().next()?;
    let next_code = u32::from(next_char);
    if next_code <= 0x1f || matches!(next_code, 0x7f..=0x9f) {
        return None;
    }
    if next_char.is_ascii_hexdigit() {
        let mut hex_end = next_index;
        while hex_end < bytes.len()
            && hex_end - next_index < 6
            && bytes[hex_end].is_ascii_hexdigit()
        {
            hex_end += 1;
        }
        let escaped_code = u32::from_str_radix(&input[next_index..hex_end], 16).ok()?;
        if escaped_code <= 0x1f
            || matches!(escaped_code, 0x7f..=0x9f)
            || escaped_code > 0x10_ffff
            || (0xd800..=0xdfff).contains(&escaped_code)
        {
            return None;
        }
        if matches!(bytes.get(hex_end), Some(b' ' | b'\t')) {
            hex_end += 1;
        }
        return Some(hex_end);
    }
    Some(next_index + next_char.len_utf8())
}

fn has_only_valid_css_ident_tail(rest: &str) -> bool {
    let bytes = rest.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            let Some(next_index) = consume_css_ident_escape(rest, index) else {
                return false;
            };
            index = next_index;
            continue;
        }
        let Some(ch) = rest[index..].chars().next() else {
            return false;
        };
        if !is_valid_css_custom_property_char(ch) {
            return false;
        }
        index += ch.len_utf8();
    }
    true
}

fn is_valid_css_custom_property_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("--") else {
        return false;
    };
    !rest.is_empty()
        && name.encode_utf16().count() <= MAX_CSS_PROPERTY_NAME_LEN
        && has_only_valid_css_ident_tail(rest)
}

fn is_valid_css_env_name(name: &str) -> bool {
    if name.starts_with("--") {
        return is_valid_css_custom_property_name(name);
    }
    if name.is_empty() || name.encode_utf16().count() > MAX_CSS_PROPERTY_NAME_LEN {
        return false;
    }
    let mut index = 0usize;
    if name.as_bytes()[0] == b'-' {
        if name.len() < 2 {
            return false;
        }
        index = 1;
    }
    if name.as_bytes()[index] == b'\\' {
        let Some(next_index) = consume_css_ident_escape(name, index) else {
            return false;
        };
        index = next_index;
    } else {
        let Some(start) = name[index..].chars().next() else {
            return false;
        };
        let valid_start = if start.is_ascii() {
            start.is_ascii_alphabetic() || start == '_'
        } else {
            is_safe_non_ascii_css_ident_char(start)
        };
        if !valid_start {
            return false;
        }
        index += start.len_utf8();
    }
    has_only_valid_css_ident_tail(&name[index..])
}

fn is_valid_css_env_specifier(specifier: &str) -> bool {
    if specifier.is_empty() || specifier.encode_utf16().count() > MAX_CSS_PROPERTY_NAME_LEN {
        return false;
    }
    let bytes = specifier.as_bytes();
    let mut ident_end = 0usize;
    while ident_end < bytes.len() {
        if bytes[ident_end] == b'\\' {
            let Some(next_index) = consume_css_ident_escape(specifier, ident_end) else {
                return false;
            };
            ident_end = next_index;
            continue;
        }
        if is_ascii_css_whitespace(bytes[ident_end]) {
            break;
        }
        ident_end += specifier[ident_end..]
            .chars()
            .next()
            .map_or(1, char::len_utf8);
    }
    if ident_end == 0 || !is_valid_css_env_name(&specifier[..ident_end]) {
        return false;
    }
    specifier[ident_end..]
        .split([' ', '\t', '\n', '\r', '\x0c'])
        .filter(|part| !part.is_empty())
        .all(|part| part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn is_valid_css_property_name(name: &str) -> bool {
    if name.starts_with("--") {
        return is_valid_css_custom_property_name(name);
    }
    if name.is_empty() || name.len() > MAX_CSS_PROPERTY_NAME_LEN {
        return false;
    }
    if name.eq_ignore_ascii_case("behavior") || name.eq_ignore_ascii_case("-moz-binding") {
        return false;
    }
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'-')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn is_allowed_function_name(name: &str, allowed: &[&str]) -> bool {
    !name.is_empty()
        && allowed
            .iter()
            .any(|candidate| name.eq_ignore_ascii_case(candidate))
}

fn validate_var_or_env_arguments(expr: &str, open_paren: usize, is_env: bool) -> Option<usize> {
    let bytes = expr.as_bytes();
    let mut cursor = open_paren + 1;
    let mut depth = 0usize;
    let mut comma = None;
    let mut close = None;
    let mut quote: Option<u8> = None;
    let mut in_comment = false;
    while cursor < bytes.len() {
        let byte = bytes[cursor];
        if in_comment {
            if byte == b'*' && bytes.get(cursor + 1) == Some(&b'/') {
                in_comment = false;
                cursor += 2;
                continue;
            }
            cursor += 1;
            continue;
        }
        if byte == b'\\' {
            cursor += 1;
            if cursor >= bytes.len() {
                return None;
            }
            let next_char = expr[cursor..].chars().next().map_or(1, char::len_utf8);
            cursor += next_char;
            continue;
        }
        if let Some(open_quote) = quote {
            if byte == open_quote {
                quote = None;
            }
            cursor += 1;
            continue;
        }
        match byte {
            b'"' | b'\'' => quote = Some(byte),
            b'/' if bytes.get(cursor + 1) == Some(&b'*') => {
                in_comment = true;
                cursor += 2;
                continue;
            }
            b'(' => depth += 1,
            b')' => {
                if depth == 0 {
                    close = Some(cursor);
                    break;
                }
                depth -= 1;
            }
            b',' if depth == 0 && comma.is_none() => {
                comma = Some(cursor);
            }
            _ => {}
        }
        cursor += 1;
    }
    let close = close?;
    if quote.is_some() || in_comment {
        return None;
    }
    let name_end = comma.unwrap_or(close);
    let ident_name = trim_ascii_css_whitespace(&expr[open_paren + 1..name_end]);
    let valid = if is_env {
        is_valid_css_env_specifier(ident_name)
    } else {
        is_valid_css_custom_property_name(ident_name)
    };
    valid.then_some(name_end)
}

fn is_ascii_css_whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')
}

fn trim_ascii_css_whitespace(value: &str) -> &str {
    value.trim_matches(|character: char| matches!(character, ' ' | '\t' | '\n' | '\r' | '\x0c'))
}

fn normalize_css_whitespace(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut quote: Option<char> = None;
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if let Some(open_quote) = quote {
            if character == '\\' {
                output.push(character);
                if let Some(escaped) = chars.next() {
                    output.push(escaped);
                }
                continue;
            }
            if character == open_quote {
                quote = None;
            }
            output.push(character);
        } else if character == '"' || character == '\'' {
            quote = Some(character);
            output.push(character);
        } else if character == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            output.push(' ');
        } else if matches!(character, '\t' | '\n' | '\x0c') {
            output.push(' ');
        } else {
            output.push(character);
        }
    }
    output
}

fn strip_css_vendor_prefix(name: &str) -> &str {
    for prefix in ["-webkit-", "-moz-", "-ms-", "-o-"] {
        if name.len() > prefix.len() && name[..prefix.len()].eq_ignore_ascii_case(prefix) {
            return &name[prefix.len()..];
        }
    }
    name
}

fn is_safe_authored_function_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == b'-' || first == b'_') {
        return false;
    }
    if !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return false;
    }
    let unprefixed = strip_css_vendor_prefix(name);
    !UNSAFE_CSS_FUNCTIONS.iter().any(|blocked| {
        name.eq_ignore_ascii_case(blocked) || unprefixed.eq_ignore_ascii_case(blocked)
    })
}

fn split_optional_important(value: &str) -> Option<(&str, bool)> {
    let bytes = value.as_bytes();
    let mut quote: Option<u8> = None;
    let mut bang_index: Option<usize> = None;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(open_quote) = quote {
            if byte == b'\\' {
                index += 1;
                if index < bytes.len() {
                    let next_char = value[index..].chars().next().map_or(1, char::len_utf8);
                    index += next_char;
                }
                continue;
            }
            if byte == open_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        if byte == b'"' || byte == b'\'' {
            quote = Some(byte);
        } else if byte == b'!' {
            if bang_index.is_some() {
                return None;
            }
            bang_index = Some(index);
        }
        index += 1;
    }
    let Some(bang) = bang_index else {
        return Some((value, false));
    };
    let core = trim_ascii_css_whitespace(&value[..bang]);
    let flag = trim_ascii_css_whitespace(&value[bang + 1..]);
    if core.is_empty() || !flag.eq_ignore_ascii_case("important") {
        return None;
    }
    Some((core, true))
}

fn is_safe_color_ascii_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'#' | b'(' | b')' | b',' | b'.' | b'%' | b' ' | b'/' | b'*' | b'+' | b'-' | b'_'
        )
}

fn validate_css_function_expression(
    expr: &str,
    allowlist: Option<(&[&str], &[&str])>,
    require_outer_call: bool,
    allow_brackets: bool,
    allow_quotes: bool,
) -> bool {
    let bytes = expr.as_bytes();
    let safe_color_mode = allowlist.is_some();
    let mut stack: Vec<u8> = Vec::new();
    let mut quote: Option<u8> = None;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte >= 0x80 {
            let Some(ch) = expr[index..].chars().next() else {
                return false;
            };
            if safe_color_mode && !is_safe_non_ascii_css_ident_char(ch) {
                return false;
            }
            index += ch.len_utf8();
            continue;
        }
        let is_ws = matches!(byte, b'\t' | b'\n' | b'\r' | b'\x0c');
        if (byte <= 0x1f && !is_ws) || byte == 0x7f {
            return false;
        }
        if let Some(open_quote) = quote {
            if byte == b'\\' {
                index += 1;
                let Some(escaped) = expr.get(index..).and_then(|rest| rest.chars().next()) else {
                    return false;
                };
                let escaped_code = u32::from(escaped);
                let escaped_ws = matches!(escaped, '\t' | '\n' | '\r' | '\x0c');
                if (escaped_code <= 0x1f && !escaped_ws)
                    || escaped_code == 0x7f
                    || matches!(escaped, '\n' | '\r' | '\x0c')
                {
                    return false;
                }
                index += escaped.len_utf8();
                continue;
            }
            if byte == open_quote {
                quote = None;
            } else if matches!(byte, b'\n' | b'\r' | b'\x0c') {
                return false;
            }
            index += 1;
            continue;
        }
        if allow_quotes && (byte == b'"' || byte == b'\'') {
            quote = Some(byte);
            index += 1;
            continue;
        }
        if safe_color_mode {
            if !is_safe_color_ascii_byte(byte) {
                return false;
            }
        } else if matches!(
            byte,
            b'{' | b'}' | b';' | b'<' | b'>' | b'\\' | b'`' | b'@' | b':'
        ) || (byte == b'/' && bytes.get(index + 1) == Some(&b'*'))
            || (byte == b'*' && bytes.get(index + 1) == Some(&b'/'))
        {
            return false;
        }
        if byte == b'[' {
            if !allow_brackets {
                return false;
            }
            stack.push(b'[');
        } else if byte == b']' {
            if !allow_brackets || stack.pop() != Some(b'[') {
                return false;
            }
        } else if byte == b'(' {
            let depth = stack.iter().filter(|&&token| token == b'(').count();
            let has_adjacent_ident = index > 0 && {
                let prev = bytes[index - 1];
                prev.is_ascii_alphanumeric() || prev == b'-' || prev == b'_'
            };
            if has_adjacent_ident {
                let mut name_start = index;
                while name_start > 0 {
                    let prev = bytes[name_start - 1];
                    if prev.is_ascii_alphanumeric() || prev == b'-' || prev == b'_' {
                        name_start -= 1;
                    } else {
                        break;
                    }
                }
                let name = &expr[name_start..index];
                let allowed = match allowlist {
                    Some((outer_allowed, inner_allowed)) => is_allowed_function_name(
                        name,
                        if depth == 0 {
                            outer_allowed
                        } else {
                            inner_allowed
                        },
                    ),
                    None => is_safe_authored_function_name(name),
                };
                if !allowed {
                    return false;
                }
                if name.eq_ignore_ascii_case("var") || name.eq_ignore_ascii_case("env") {
                    let Some(name_end) = validate_var_or_env_arguments(
                        expr,
                        index,
                        name.eq_ignore_ascii_case("env"),
                    ) else {
                        return false;
                    };
                    stack.push(b'(');
                    index = name_end;
                    continue;
                }
            } else {
                // Parenthesized grouping is only permitted inside an enclosing function
                // after an operator, comma, or opening parenthesis (not `url (evil)`).
                if depth == 0 {
                    return false;
                }
                let mut prev = index;
                while prev > 0 && is_ascii_css_whitespace(bytes[prev - 1]) {
                    prev -= 1;
                }
                if prev == 0 || !matches!(bytes[prev - 1], b'(' | b',' | b'+' | b'-' | b'*' | b'/')
                {
                    return false;
                }
            }
            stack.push(b'(');
        } else if byte == b')' {
            if stack.pop() != Some(b'(') {
                return false;
            }
            if require_outer_call && stack.is_empty() && index + 1 != bytes.len() {
                return false;
            }
        }
        index += 1;
    }
    quote.is_none() && stack.is_empty()
}

fn split_light_dark_arguments(trimmed: &str) -> Option<(&str, &str)> {
    let bytes = trimmed.as_bytes();
    if bytes.len() <= 12
        || !bytes[..11].eq_ignore_ascii_case(b"light-dark(")
        || *bytes.last()? != b')'
    {
        return None;
    }
    let mut depth = 0usize;
    let mut comma = None;
    let mut index = 11usize;
    while index < bytes.len() - 1 {
        let byte = bytes[index];
        if byte == b'\\' {
            index += 1;
            if index >= bytes.len() - 1 {
                return None;
            }
            let next_len = trimmed[index..].chars().next().map_or(1, char::len_utf8);
            index += next_len;
            continue;
        }
        match byte {
            b'(' => depth += 1,
            b')' => {
                if depth == 0 {
                    return None;
                }
                depth -= 1;
            }
            b',' if depth == 0 => {
                if comma.is_some() {
                    return None;
                }
                comma = Some(index);
            }
            _ => {}
        }
        index += 1;
    }
    if depth != 0 {
        return None;
    }
    let comma = comma?;
    Some((
        trimmed[11..comma].trim_matches(' '),
        trimmed[comma + 1..trimmed.len() - 1].trim_matches(' '),
    ))
}

fn is_safe_single_css_color(value: &str) -> bool {
    if value.is_empty() || value.encode_utf16().count() > MAX_CSS_VALUE_LEN {
        return false;
    }
    if value
        .chars()
        .any(|ch| (ch as u32) <= 0x1f || matches!(ch as u32, 0x7f..=0x9f))
    {
        return false;
    }
    let trimmed = value.trim_matches(' ');
    if trimmed.is_empty() {
        return false;
    }
    if let Some(hex) = trimmed.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8)
            && hex.bytes().all(|byte| byte.is_ascii_hexdigit());
    }
    if !trimmed.contains(['(', ')']) {
        let mut bytes = trimmed.bytes();
        let Some(first) = bytes.next() else {
            return false;
        };
        return first.is_ascii_alphabetic()
            && bytes.all(|byte| byte.is_ascii_alphabetic() || byte == b'-');
    }
    if trimmed.contains("/*") || trimmed.contains("*/") {
        return false;
    }
    let Some(open) = trimmed.find('(') else {
        return false;
    };
    if !is_allowed_function_name(&trimmed[..open], SAFE_COLOR_FUNCTIONS) {
        return false;
    }
    validate_css_function_expression(
        trimmed,
        Some((SAFE_COLOR_FUNCTIONS, SAFE_COLOR_INNER_FUNCTIONS)),
        true,
        false,
        false,
    )
}

fn unwrap_var_color_fallback(trimmed: &str) -> Option<&str> {
    let bytes = trimmed.as_bytes();
    let is_var = bytes.len() > 6 && bytes[..4].eq_ignore_ascii_case(b"var(");
    let is_env = !is_var && bytes.len() > 6 && bytes[..4].eq_ignore_ascii_case(b"env(");
    if (!is_var && !is_env) || *bytes.last()? != b')' {
        return None;
    }
    let mut depth = 0usize;
    let mut comma = None;
    let mut index = 4usize;
    while index < bytes.len() - 1 {
        let byte = bytes[index];
        if byte == b'\\' {
            index += 1;
            if index >= bytes.len() - 1 {
                return None;
            }
            let next_len = trimmed[index..].chars().next().map_or(1, char::len_utf8);
            index += next_len;
            continue;
        }
        match byte {
            b'(' => depth += 1,
            b')' => {
                if depth == 0 {
                    return None;
                }
                depth -= 1;
            }
            b',' if depth == 0 && comma.is_none() => {
                comma = Some(index);
            }
            _ => {}
        }
        index += 1;
    }
    if depth != 0 {
        return None;
    }
    let comma = comma?;
    let ident_name = trimmed[4..comma].trim_matches(' ');
    let valid_name = if is_env {
        is_valid_css_env_specifier(ident_name)
    } else {
        is_valid_css_custom_property_name(ident_name)
    };
    if !valid_name {
        return None;
    }
    Some(trimmed[comma + 1..trimmed.len() - 1].trim_matches(' '))
}

fn normalize_css_color_whitespace(value: &str, force_collapse: bool) -> Option<Cow<'_, str>> {
    if value.is_empty() || value.encode_utf16().count() > MAX_COMPOSED_VAR_COLOR_LEN {
        return None;
    }
    let mut needs_collapse = force_collapse;
    for ch in value.chars() {
        let code = u32::from(ch);
        if matches!(ch, '\t' | '\n' | '\r' | '\x0c') {
            needs_collapse = true;
        } else if code <= 0x1f || matches!(code, 0x7f..=0x9f) {
            return None;
        }
    }
    if !needs_collapse {
        let trimmed = value.trim_matches(' ');
        return (!trimmed.is_empty()).then_some(Cow::Borrowed(trimmed));
    }
    let mut normalized = String::with_capacity(value.len());
    let mut pending_space = false;
    for ch in value.chars() {
        if matches!(ch, ' ' | '\t' | '\n' | '\r' | '\x0c') {
            if !normalized.is_empty() {
                pending_space = true;
            }
        } else {
            if pending_space {
                normalized.push(' ');
                pending_space = false;
            }
            normalized.push(ch);
        }
    }
    (!normalized.is_empty()).then_some(Cow::Owned(normalized))
}

fn is_safe_normalized_css_color(normalized: &str, depth: usize) -> bool {
    let utf16_len = normalized.encode_utf16().count();
    if utf16_len <= MAX_CSS_VALUE_LEN && is_safe_single_css_color(normalized) {
        return true;
    }
    if utf16_len > MAX_COMPOSED_VAR_COLOR_LEN || depth > MAX_COMPOSED_COLOR_DEPTH {
        return false;
    }
    let mut inner = normalized;
    let mut unwrapped = 0usize;
    while unwrapped < MAX_VAR_COLOR_WRAPPER_DEPTH {
        let Some(fallback) = unwrap_var_color_fallback(inner) else {
            break;
        };
        inner = fallback;
        unwrapped += 1;
    }
    if unwrapped == 0 && utf16_len > MAX_COMPOSED_LIGHT_DARK_LEN {
        return false;
    }
    if unwrapped > 0 && (inner.is_empty() || is_safe_single_css_color(inner)) {
        return true;
    }
    if depth >= MAX_COMPOSED_COLOR_DEPTH {
        return false;
    }
    let Some((light, dark)) = split_light_dark_arguments(inner) else {
        return false;
    };
    is_safe_normalized_css_color(light, depth + 1) && is_safe_normalized_css_color(dark, depth + 1)
}

pub(crate) fn normalize_safe_css_color(value: &str) -> Option<Cow<'_, str>> {
    if let Some(hex) = value.strip_prefix('#')
        && matches!(hex.len(), 3 | 4 | 6 | 8)
        && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Some(Cow::Borrowed(value));
    }
    if value.is_empty()
        || value.encode_utf16().count() > MAX_COMPOSED_VAR_COLOR_LEN
        || contains_closing_style_tag(value)
    {
        return None;
    }
    if value.chars().any(|ch| {
        let code = u32::from(ch);
        let is_ws = matches!(ch, '\t' | '\n' | '\r' | '\x0c');
        (code <= 0x1f && !is_ws) || matches!(code, 0x7f..=0x9f)
    }) {
        return None;
    }
    let stripped = strip_css_comments(value)?;
    let normalized = match stripped {
        Cow::Borrowed(raw) => normalize_css_color_whitespace(raw, false)?,
        Cow::Owned(cleaned) => {
            Cow::Owned(normalize_css_color_whitespace(&cleaned, true)?.into_owned())
        }
    };
    is_safe_normalized_css_color(&normalized, 0).then_some(normalized)
}

pub(crate) fn is_safe_css_color(value: &str) -> bool {
    normalize_safe_css_color(value).is_some()
}

fn contains_closing_style_tag(value: &str) -> bool {
    value
        .as_bytes()
        .windows(7)
        .any(|window| window.eq_ignore_ascii_case(b"</style"))
}

fn is_safe_css_declaration_value(value: &str) -> bool {
    if value.is_empty()
        || value.encode_utf16().count() > MAX_CSS_VALUE_LEN
        || contains_closing_style_tag(value)
    {
        return false;
    }
    validate_css_function_expression(value, None, false, true, true)
}

fn is_color_property(name: &str) -> bool {
    name.eq_ignore_ascii_case("color") || name.eq_ignore_ascii_case("background-color")
}

fn split_css_declarations(style: &str) -> Vec<&str> {
    let bytes = style.as_bytes();
    let mut declarations = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut in_comment = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_comment {
            if byte == b'*' && bytes.get(index + 1) == Some(&b'/') {
                in_comment = false;
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }
        if byte == b'\\' {
            index += 1;
            if index < bytes.len() {
                // Skip full UTF-8 scalar after backslash so slices stay on char boundaries.
                let next_char = style[index..].chars().next().map_or(1, char::len_utf8);
                index += next_char;
            }
            continue;
        }
        if let Some(open_quote) = quote {
            if byte == open_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        match byte {
            b'"' | b'\'' => quote = Some(byte),
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                in_comment = true;
                index += 2;
                continue;
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth = depth.saturating_sub(1),
            b';' if depth == 0 => {
                declarations.push(&style[start..index]);
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    declarations.push(&style[start..]);
    declarations
}

fn skip_leading_css_ws_and_comments(value: &str, mut index: usize) -> Option<usize> {
    let bytes = value.as_bytes();
    while index < bytes.len() {
        if is_ascii_css_whitespace(bytes[index]) {
            index += 1;
        } else if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            let close = value[index + 2..].find("*/")?;
            index = index + 2 + close + 2;
        } else {
            break;
        }
    }
    Some(index)
}

fn split_css_declaration_segment(segment: &str) -> Option<(&str, &str)> {
    let start = skip_leading_css_ws_and_comments(segment, 0)?;
    let bytes = segment.as_bytes();
    let mut end = start;
    while end < bytes.len() {
        if bytes[end] == b'\\' {
            end = consume_css_ident_escape(segment, end)?;
            continue;
        }
        if is_ascii_css_whitespace(bytes[end])
            || bytes[end] == b':'
            || (bytes[end] == b'/' && bytes.get(end + 1) == Some(&b'*'))
        {
            break;
        }
        end += segment[end..].chars().next().map_or(1, char::len_utf8);
    }
    if end == start {
        return None;
    }
    let colon = skip_leading_css_ws_and_comments(segment, end)?;
    if bytes.get(colon) != Some(&b':') {
        return None;
    }
    Some((&segment[start..end], &segment[colon + 1..]))
}

fn strip_css_comments(value: &str) -> Option<Cow<'_, str>> {
    if !value.contains("/*") && !value.contains("*/") {
        return Some(Cow::Borrowed(value));
    }
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut quote: Option<u8> = None;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(open_quote) = quote {
            if byte == b'\\' {
                output.push('\\');
                index += 1;
                if index < bytes.len() {
                    let ch = value[index..].chars().next()?;
                    output.push(ch);
                    index += ch.len_utf8();
                }
                continue;
            }
            if byte == open_quote {
                quote = None;
            }
            let ch = value[index..].chars().next()?;
            output.push(ch);
            index += ch.len_utf8();
            continue;
        }
        if byte == b'"' || byte == b'\'' {
            quote = Some(byte);
            output.push(byte as char);
            index += 1;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            let close_offset = value[index + 2..].find("*/")?;
            if output
                .as_bytes()
                .last()
                .is_some_and(|&last| !is_ascii_css_whitespace(last))
            {
                output.push(' ');
            }
            index = index + 2 + close_offset + 2;
            continue;
        }
        if byte == b'*' && bytes.get(index + 1) == Some(&b'/') {
            return None;
        }
        let ch = value[index..].chars().next()?;
        output.push(ch);
        index += ch.len_utf8();
    }
    quote.is_none().then_some(Cow::Owned(output))
}

pub(crate) fn sanitize_css_declarations(style: &str) -> String {
    let mut output = String::new();
    for segment in split_css_declarations(style) {
        if segment.chars().any(|character| {
            let code = u32::from(character);
            let is_ws = matches!(character, '\t' | '\n' | '\r' | '\x0c');
            (code <= 0x1f && !is_ws) || code == 0x7f
        }) {
            continue;
        }
        if contains_closing_style_tag(segment) {
            continue;
        }
        let Some((name, raw_value)) = split_css_declaration_segment(segment) else {
            continue;
        };
        let Some(stripped_value) = strip_css_comments(raw_value) else {
            continue;
        };
        let value = trim_ascii_css_whitespace(&stripped_value);
        if value.is_empty() {
            if name.starts_with("--")
                && !stripped_value.is_empty()
                && stripped_value.encode_utf16().count() <= MAX_CSS_VALUE_LEN
                && is_valid_css_property_name(name)
            {
                if !output.is_empty() {
                    output.push(';');
                }
                output.push_str(name);
                output.push_str(": ");
            }
            continue;
        }
        let allows_composed_color = is_color_property(name) || name.starts_with("--");
        let max_value_len = if allows_composed_color
            && value.as_bytes().get(..4).is_some_and(|prefix| {
                prefix.eq_ignore_ascii_case(b"var(") || prefix.eq_ignore_ascii_case(b"env(")
            }) {
            MAX_COMPOSED_VAR_COLOR_LEN
        } else if allows_composed_color
            && value
                .as_bytes()
                .get(..11)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"light-dark("))
        {
            MAX_COMPOSED_LIGHT_DARK_LEN
        } else {
            MAX_CSS_VALUE_LEN
        };
        if value.encode_utf16().count() > max_value_len {
            continue;
        }
        if !is_valid_css_property_name(name) {
            continue;
        }
        let Some((core, important)) = split_optional_important(value) else {
            continue;
        };
        let normalized = normalize_css_whitespace(core);
        let valid_value = if is_color_property(name)
            || (name.starts_with("--") && value.encode_utf16().count() > MAX_CSS_VALUE_LEN)
        {
            is_safe_css_color(&normalized)
        } else {
            is_safe_css_declaration_value(&normalized)
        };
        if !valid_value {
            continue;
        }
        if !output.is_empty() {
            output.push(';');
        }
        output.push_str(name);
        output.push(':');
        output.push_str(&normalized);
        if important {
            output.push_str(" !important");
        }
    }
    output
}

pub(crate) fn default_root_style(background: &str, foreground: &str) -> String {
    let mut style = String::new();
    if let Some(bg) = normalize_safe_css_color(background) {
        style.push_str("background-color:");
        style.push_str(&bg);
    }
    if let Some(fg) = normalize_safe_css_color(foreground) {
        if !style.is_empty() {
            style.push(';');
        }
        style.push_str("color:");
        style.push_str(&fg);
    }
    style
}

fn is_html_pcen_char(character: char) -> bool {
    character.is_ascii_alphanumeric()
        || matches!(character, '-' | '_' | '.' | '\u{00B7}')
        || matches!(
            u32::from(character),
            0x00C0..=0x00D6
                | 0x00D8..=0x00F6
                | 0x00F8..=0x037D
                | 0x037F..=0x1FFF
                | 0x200C..=0x200D
                | 0x203F..=0x2040
                | 0x2070..=0x218F
                | 0x2C00..=0x2FEF
                | 0x3001..=0xD7FF
                | 0xF900..=0xFDCF
                | 0xFDF0..=0xFFFD
                | 0x10000..=0xEFFFF
        )
}

pub(crate) fn is_valid_html_tag_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic() && chars.all(is_html_pcen_char)
}

pub(crate) fn is_valid_html_attribute_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|character| {
            let code = u32::from(character);
            code > 0x20
                && !(0x7f..=0x9f).contains(&code)
                && !matches!(character, '"' | '\'' | '/' | '<' | '=' | '>')
        })
}

pub(crate) fn is_safe_decoration_tag_name(name: &str) -> bool {
    is_valid_html_tag_name(name)
        && SAFE_DECORATION_TAGS
            .iter()
            .any(|allowed| name.eq_ignore_ascii_case(allowed))
}

const UNSAFE_DECORATION_ATTRIBUTES: &[&str] = &[
    "action",
    "attributionsrc",
    "background",
    "formaction",
    "is",
    "ping",
    "srcdoc",
    "srcset",
];

const URL_DECORATION_ATTRIBUTES: &[&str] = &["cite", "data", "href", "poster", "src", "xlink:href"];

pub(crate) fn is_safe_decoration_attribute_name(name: &str) -> bool {
    if !is_valid_html_attribute_name(name) {
        return false;
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[..2].eq_ignore_ascii_case(b"on") {
        return false;
    }
    !UNSAFE_DECORATION_ATTRIBUTES
        .iter()
        .any(|blocked| name.eq_ignore_ascii_case(blocked))
}

pub(crate) fn is_safe_decoration_url(value: &str) -> bool {
    if value.bytes().any(|byte| byte <= 0x1f || byte == 0x7f) {
        return false;
    }
    let trimmed = value.trim_matches(' ');
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.starts_with("//") || trimmed.starts_with('\\') || trimmed.starts_with("/\\") {
        return false;
    }
    let first_delim = trimmed.find(['/', '?', '#']).unwrap_or(trimmed.len());
    let first_segment = &trimmed[..first_delim];
    if let Some(colon) = first_segment.find(':') {
        let scheme = &first_segment[..colon];
        if scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http") {
            let after_colon = &trimmed[colon + 1..];
            let Some(rest) = after_colon.strip_prefix("//") else {
                return false;
            };
            let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
            return !rest[..host_end].is_empty();
        }
        if scheme.eq_ignore_ascii_case("mailto") {
            return !trimmed[colon + 1..].trim_matches(' ').is_empty();
        }
        return false;
    }
    true
}

pub(crate) fn is_safe_decoration_attribute_value(name: &str, value: &str) -> bool {
    if URL_DECORATION_ATTRIBUTES
        .iter()
        .any(|attr| name.eq_ignore_ascii_case(attr))
    {
        return is_safe_decoration_url(value);
    }
    true
}

pub(crate) fn write_escaped_html(output: &mut String, input: &str) {
    let bytes = input.as_bytes();
    let mut last = 0;
    for (index, &byte) in bytes.iter().enumerate() {
        let replacement = match byte {
            b'&' => "&#x26;",
            b'<' => "&#x3C;",
            _ => continue,
        };
        if last < index {
            output.push_str(&input[last..index]);
        }
        output.push_str(replacement);
        last = index + 1;
    }
    if last < bytes.len() {
        output.push_str(&input[last..]);
    }
}

pub(crate) fn write_escaped_attribute(output: &mut String, input: &str) {
    let bytes = input.as_bytes();
    let mut last = 0;
    for (index, &byte) in bytes.iter().enumerate() {
        let replacement = match byte {
            b'&' => "&#x26;",
            b'<' => "&#x3C;",
            b'"' => "&#x22;",
            _ => continue,
        };
        if last < index {
            output.push_str(&input[last..index]);
        }
        output.push_str(replacement);
        last = index + 1;
    }
    if last < bytes.len() {
        output.push_str(&input[last..]);
    }
}

#[cfg(test)]
pub(crate) fn escape_html(input: &str) -> Cow<'_, str> {
    if !input
        .as_bytes()
        .iter()
        .any(|&byte| byte == b'&' || byte == b'<')
    {
        return Cow::Borrowed(input);
    }
    let mut output = String::with_capacity(input.len() + 16);
    write_escaped_html(&mut output, input);
    Cow::Owned(output)
}

#[cfg(test)]
pub(crate) fn escape_attribute(input: &str) -> Cow<'_, str> {
    if !input
        .as_bytes()
        .iter()
        .any(|&byte| byte == b'&' || byte == b'<' || byte == b'"')
    {
        return Cow::Borrowed(input);
    }
    let mut output = String::with_capacity(input.len() + 16);
    write_escaped_attribute(&mut output, input);
    Cow::Owned(output)
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
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/standard");
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
        let expected_lines: Vec<_> = tree["children"][0]["children"][0]["children"]
            .as_array()
            .expect("code lines")
            .iter()
            .filter(|line| line["type"] == "element")
            .map(|line| {
                line["children"]
                    .as_array()
                    .expect("line tokens")
                    .iter()
                    .map(hast_node_to_html)
                    .collect::<String>()
            })
            .collect();
        assert_eq!(
            render_html_lines(result, options),
            expected_lines,
            "{options:?}"
        );
    }

    #[test]
    fn escaping_preserves_unicode_and_literal_entities() {
        for (input, text, attribute) in [
            ("", "", ""),
            (
                "色🦀 plain > text",
                "色🦀 plain > text",
                "色🦀 plain > text",
            ),
            ("\"quoted\"", "\"quoted\"", "&#x22;quoted&#x22;"),
            ("&<\"色🦀", "&#x26;&#x3C;\"色🦀", "&#x26;&#x3C;&#x22;色🦀"),
            ("&#x26;<", "&#x26;#x26;&#x3C;", "&#x26;#x26;&#x3C;"),
        ] {
            assert_eq!(super::escape_html(input), text);
            assert_eq!(super::escape_attribute(input), attribute);
        }
    }

    #[test]
    fn inline_styles_preserve_declaration_order_and_escape_values() {
        for (color, font_style, expected) in [
            (None, None, ""),
            (Some(""), Some(FontStyle::NONE), ""),
            (Some("#aBc"), None, "color:#aBc"),
            (
                None,
                Some(FontStyle::ITALIC | FontStyle::BOLD),
                "font-style:italic;font-weight:bold",
            ),
            (
                Some("color<&\""),
                Some(FontStyle::NOT_SET),
                "font-style:italic;font-weight:bold;text-decoration:underline line-through",
            ),
            (
                Some("rgb(12, 34, 56)"),
                Some(FontStyle::BOLD),
                "color:rgb(12, 34, 56);font-weight:bold",
            ),
            (
                None,
                Some(FontStyle::UNDERLINE),
                "text-decoration:underline",
            ),
            (
                None,
                Some(FontStyle::STRIKETHROUGH),
                "text-decoration:line-through",
            ),
            (None, Some(FontStyle::from_bits(32)), ""),
        ] {
            let token = HighlightToken {
                content: "x".to_owned(),
                offset: 0,
                color: color.map(str::to_owned),
                font_style,
                token_type: None,
                scope_names: None,
            };
            assert_eq!(super::token_style(&token), expected);
            let result = HighlightTokensResult {
                tokens: vec![vec![token]],
                foreground: String::new(),
                background: String::new(),
                theme_name: "probe".to_owned(),
            };
            let attribute = if expected.is_empty() {
                String::new()
            } else {
                format!(" style=\"{}\"", super::escape_attribute(expected))
            };
            assert_eq!(
                render_html_lines(&result, &RenderOptions::default()),
                [format!("<span{attribute}>x</span>")],
            );
        }
    }

    #[test]
    fn inline_whitespace_merging_preserves_empty_and_decorated_tokens() {
        let tokens: Vec<_> = [
            ("", FontStyle::NONE),
            ("<&😀", FontStyle::ITALIC),
            (" \t", FontStyle::NONE),
            ("\u{a0}", FontStyle::BOLD),
            (" ", FontStyle::UNDERLINE),
            ("text", FontStyle::STRIKETHROUGH),
        ]
        .into_iter()
        .map(|(content, style)| HighlightToken {
            content: content.to_owned(),
            offset: 0,
            color: Some("#abcdef".to_owned()),
            font_style: Some(style),
            token_type: None,
            scope_names: None,
        })
        .collect();
        for first in &tokens {
            for second in &tokens {
                for third in &tokens {
                    let result = HighlightTokensResult {
                        tokens: vec![vec![first.clone(), second.clone(), third.clone()]],
                        foreground: "#000000".to_owned(),
                        background: "#ffffff".to_owned(),
                        theme_name: "probe".to_owned(),
                    };
                    for merge_whitespaces in [false, true] {
                        for merge_same_style_tokens in [false, true] {
                            assert_html_matches_hast(
                                &result,
                                &RenderOptions::default()
                                    .with_merge_whitespaces(merge_whitespaces)
                                    .with_merge_same_style_tokens(merge_same_style_tokens),
                            );
                        }
                    }
                }
            }
        }
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
        let corpus = root.join("node/benchmarks/curated");
        let manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(corpus.join("manifest.json")).expect("fixture manifest"),
        )
        .expect("fixture manifest JSON");
        let mut highlighter = HighlighterCore::with_standard_assets(&root.join("assets/standard"))
            .expect("highlighter");
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

    #[test]
    fn css_color_validation_accepts_standard_forms_and_rejects_injections() {
        for valid in [
            "#fff",
            "#ffff",
            "#2e3440",
            "#2e3440ff",
            "red",
            "transparent",
            "currentColor",
            "inherit",
            "revert-layer",
            "rgb(255, 0, 0)",
            "rgba(255, 0, 0, 0.5)",
            "rgb(255 0 0 / 50%)",
            "hsl(120deg 100% 50% / 0.5)",
            "hsla(120, 100%, 50%, 0.5)",
            "hwb(194 0% 0% / .5)",
            "lab(50% 40 59.5)",
            "lch(52.2% 72.2 50)",
            "oklab(0.59 0.1 -0.1)",
            "oklch(0.62 0.15 250 / 80%)",
            "color(display-p3 1 0.5 0 / 0.8)",
            "color-mix(in oklch, var(--shiki-a, #fff) 50%, transparent)",
            "contrast-color(white)",
            "contrast-color(oklch(0.6 0.15 250))",
            "light-dark(#111, #eee)",
            "var(--shiki-foreground)",
            "var(--accent,)",
            "var(--x, )",
            "var(--_ferriki-token-color, var(--ferriki-string-color, #aabbcc))",
            "hsl(calc(180 + 20) 50% 40%)",
            "hsl(calc((90 + 10) * 2) 50% 40%)",
            "hsl(calc(180 - (10 + 5)) 50% 40%)",
            "oklch(clamp(0.2, 0.5, 0.8) 0.1 180)",
            "rgb(min(255, round(127.6)) max(0, 10) abs(-5))",
            "rgb(1, 2, 3) /* comment */",
            "rgb(255 /* red */ 0 0)",
            "env(site-foreground, #c00)",
            "env(safe-area-inset-top)",
            "env(site-foreground, rgb(255 0 0))",
            "env(viewport-segment-color 0 0, #c00)",
            "env(📐, blue)",
        ] {
            assert!(is_safe_css_color(valid), "expected safe color: {valid}");
        }
        assert_eq!(
            normalize_safe_css_color("rgb(255 /* red */ 0 0)").as_deref(),
            Some("rgb(255 0 0)")
        );
        assert_eq!(
            normalize_safe_css_color("rgb(1, 2, 3) /* comment */").as_deref(),
            Some("rgb(1, 2, 3)")
        );

        for invalid in [
            "",
            "   ",
            "#12",
            "#12345",
            "#1234567",
            "#123456789",
            "#gggggg",
            "calc(180 + 20)",
            "clamp(0.2, 0.5, 0.8)",
            "hsl(url(https://evil.test) 50% 40%)",
            "contrast-color(url(https://evil.test))",
            "hsl(url (https://evil.test) 50% 40%)",
            "hsl(expression(alert(1)) 50% 40%)",
            "red;position:fixed",
            "red);position:fixed",
            "red}body{color:red",
            "#fff</style><script>alert(1)</script>",
            "url(https://evil.test/x)",
            "expression(alert(1))",
            "@import url(https://evil.test)",
            "rgb(1, 2, 3) /* unclosed",
            "rgb(1, 2, 3) */",
            "rgb(1, 2, 3) /* </style> */",
            "rgb(1, 2, 3) /* \x07 */",
            "r/*x*/gb(255 0 0)",
            "rgb/*x*/(255 0 0)",
            "rgb(1, 2, 3) !important",
            "rgb(1, 2, 3) extra",
            "var(not-custom)",
            "var(--x, url(https://evil.test))",
            "var(,)",
            "var(--,)",
            "var(--bad;name,)",
            "env(, #c00)",
            "env(123bad, #c00)",
            "env(-1bad, #c00)",
            "env(bad name, #c00)",
            "env(viewport-segment-color -1, #c00)",
            "env(viewport-segment-color 0 -1, #c00)",
            "env(viewport-segment-color 1.5, #c00)",
            "env(viewport-segment-color 0 0, url(https://evil.test))",
            "env(site-foreground, url(https://evil.test))",
            "red\x0b",
            "red\0",
            "red\\7d",
            "\"red\"",
            "'red'",
            "rgb (1, 2, 3)",
            "((#fff))",
        ] {
            assert!(
                !is_safe_css_color(invalid),
                "expected unsafe color: {invalid}"
            );
        }
    }

    #[test]
    fn extract_styles_prevents_css_rule_and_style_tag_breakout() {
        let result = HighlightTokensResult {
            tokens: vec![vec![HighlightToken {
                content: "x".to_owned(),
                offset: 0,
                color: Some(
                    "#fff}body{background:url(https://evil.test)}</style><script>alert(1)</script>"
                        .to_owned(),
                ),
                font_style: Some(FontStyle::BOLD),
                token_type: None,
                scope_names: Some(vec!["source.test".to_owned()]),
            }]],
            foreground: "#d8dee9".to_owned(),
            background: "red;position:fixed".to_owned(),
            theme_name: "hostile".to_owned(),
        };
        let options = RenderOptions::default()
            .with_style_mode(StyleMode::Classes)
            .with_root_style(Some(
                "color:#111;background:url(https://evil.test);padding:1rem}body{display:none}</style><script>x</script>;font-weight:bold".to_owned(),
            ));
        let rendered = render_html_with_css(&result, &options);
        assert!(!rendered.css.contains("</style>"));
        assert!(!rendered.css.contains("<script>"));
        assert!(!rendered.css.contains("url("));
        assert!(!rendered.css.contains("display:none"));
        assert!(!rendered.css.contains("position:fixed"));
        assert!(rendered.css.contains("color:#111;font-weight:bold"));
        assert!(rendered.css.contains("font-weight:bold"));

        // All-hostile style produces no CSS rule and no ferriki-style class.
        let all_hostile = RenderOptions::default()
            .with_style_mode(StyleMode::Classes)
            .with_root_style(Some("background:url(evil);color:red/*unclosed".to_owned()));
        let mut tree = render_styled_hast(&result, &all_hostile);
        let mut rules = BTreeMap::new();
        extract_styles(&mut tree, &mut rules);
        let pre_class = tree["children"][0]["properties"]["class"]
            .as_str()
            .unwrap_or_default();
        assert!(!pre_class.contains("ferriki-style-"));
        assert!(
            rules
                .values()
                .all(|rule| !rule.contains("url(") && !rule.contains("/*"))
        );

        // Quoted strings preserve safe literal punctuation (like `:` and escaped quotes) without
        // leaking inner declarations, while unclosed quotes, `</style>`, and unquoted rule
        // breakouts remain rejected.
        assert_eq!(
            sanitize_css_declarations("content:\"Note: \";font-weight:bold"),
            "content:\"Note: \";font-weight:bold"
        );
        assert_eq!(
            sanitize_css_declarations("content:\"Note: \\\"quoted\\\"\""),
            "content:\"Note: \\\"quoted\\\"\""
        );
        assert_eq!(
            sanitize_css_declarations("content:\"Note: </style><script>\";font-weight:bold"),
            "font-weight:bold"
        );
        assert_eq!(
            sanitize_css_declarations("--caption:\"a;color:red;b\";font-weight:bold"),
            "--caption:\"a;color:red;b\";font-weight:bold"
        );
        assert_eq!(
            sanitize_css_declarations("--caption:'a\\';color:red;b';font-weight:bold"),
            "--caption:'a\\';color:red;b';font-weight:bold"
        );
        assert_eq!(
            sanitize_css_declarations("--caption:\"unclosed;color:red"),
            ""
        );
        assert_eq!(
            sanitize_css_declarations("--x:red/*;color:blue*/;font-weight:bold"),
            "--x:red;font-weight:bold"
        );
        assert_eq!(
            sanitize_css_declarations(
                "color: red /* accent */; background-color: blue /* bg */ !important"
            ),
            "color:red;background-color:blue !important"
        );
        assert_eq!(
            sanitize_css_declarations("content: \"/* literal */\""),
            "content:\"/* literal */\""
        );
        assert_eq!(
            sanitize_css_declarations(
                "background: url/*x*/(/evil.png); background: u/*x*/rl(https://evil.test)"
            ),
            ""
        );
        assert_eq!(sanitize_css_declarations("color: red /* unclosed"), "");
        assert_eq!(sanitize_css_declarations("color: green /* </style> */"), "");
        assert_eq!(sanitize_css_declarations("/* </style> */ color: red"), "");
        assert_eq!(
            sanitize_css_declarations("left: env(viewport-segment-left 0 0, 0px)"),
            "left:env(viewport-segment-left 0 0, 0px)"
        );
        assert_eq!(
            sanitize_css_declarations("color:env(📐, blue)"),
            "color:env(📐, blue)"
        );
        assert_eq!(
            sanitize_css_declarations("left: env(viewport-segment-left -1, 0px)"),
            ""
        );
        assert_eq!(
            sanitize_css_declarations(
                "left: env(viewport-segment-left 0 0, url(https://evil.test))"
            ),
            ""
        );

        // Formatted authored styles with safe quoted font names, layout functions,
        // optional trailing !important, and newlines are preserved.
        assert_eq!(
            sanitize_css_declarations("font-family:\"Fira Code\",monospace;\n  padding:1rem"),
            "font-family:\"Fira Code\",monospace;padding:1rem"
        );
        assert_eq!(
            sanitize_css_declarations(
                "color: rgb(255 0\n0);background-color: hsl(180\t50%\r\n40%)"
            ),
            "color:rgb(255 0 0);background-color:hsl(180 50% 40%)"
        );
        assert_eq!(
            normalize_safe_css_color("rgb(\n  10,\n  20,\n  30\n)").as_deref(),
            Some("rgb( 10, 20, 30 )")
        );
        assert!(is_safe_css_color("rgb(255 0\n0)"));
        let multiline_theme = HighlightTokensResult {
            tokens: vec![vec![HighlightToken {
                content: "x".to_owned(),
                offset: 0,
                color: Some("rgb(\n  10,\n  20,\n  30\n)".to_owned()),
                font_style: None,
                token_type: None,
                scope_names: None,
            }]],
            foreground: "hsl(\n  180,\n  50%,\n  40%\n)".to_owned(),
            background: "\n  #102030\t\n".to_owned(),
            theme_name: "multiline".to_owned(),
        };
        let multiline_html = render_html(&multiline_theme, &RenderOptions::default());
        assert!(
            multiline_html.contains("background-color:#102030;color:hsl( 180, 50%, 40% )"),
            "unexpected multiline root style: {multiline_html}"
        );
        assert!(
            multiline_html.contains("style=\"color:rgb( 10, 20, 30 )\""),
            "unexpected multiline token style: {multiline_html}"
        );
        let commented_theme = HighlightTokensResult {
            tokens: vec![vec![HighlightToken {
                content: "x".to_owned(),
                offset: 0,
                color: Some("rgb(255 /* red */ 0 0)".to_owned()),
                font_style: None,
                token_type: None,
                scope_names: None,
            }]],
            foreground: "hsl(180 /* hue */ 50% 40%)".to_owned(),
            background: "/* bg */ #102030".to_owned(),
            theme_name: "commented".to_owned(),
        };
        let commented_html = render_html(&commented_theme, &RenderOptions::default());
        assert!(
            commented_html.contains("background-color:#102030;color:hsl(180 50% 40%)"),
            "unexpected commented root style: {commented_html}"
        );
        assert!(
            commented_html.contains("style=\"color:rgb(255 0 0)\""),
            "unexpected commented token style: {commented_html}"
        );
        // Value length is measured in UTF-16 code units before stripping !important (matching JS).
        let cjk_200 = format!("--cjk:\"{}\"", "漢".repeat(200));
        assert_eq!(sanitize_css_declarations(&cjk_200), cjk_200);
        let cjk_513 = format!("--cjk:\"{}\"", "漢".repeat(513));
        assert_eq!(sanitize_css_declarations(&cjk_513), "");
        let over_limit_important = format!("--x:{} !important", "a".repeat(505));
        assert_eq!(sanitize_css_declarations(&over_limit_important), "");

        // Composed `light-dark(...)` from two valid <=512-char colors (e.g. 260-char var(--...))
        // survives both `is_safe_css_color` and `sanitize_css_declarations`, while an over-limit
        // or unsafe argument is rejected.
        let long_light = format!("var(--{})", "a".repeat(253));
        let long_dark = format!("var(--{})", "b".repeat(253));
        assert_eq!(long_light.len(), 260);
        let composed = format!("light-dark({long_light}, {long_dark})");
        assert!(composed.len() > MAX_CSS_VALUE_LEN);
        assert!(is_safe_css_color(&composed));
        let composed_decl = format!("color:{composed}");
        assert_eq!(sanitize_css_declarations(&composed_decl), composed_decl);
        let oversized_arg = format!("light-dark(var(--{}), #fff)", "a".repeat(510));
        assert!(!is_safe_css_color(&oversized_arg));
        let wrapped_var = format!("var(--ferriki-keyword-color, {composed})");
        assert!(is_safe_css_color(&wrapped_var));
        let token_color_decl = format!("--_ferriki-token-color:{wrapped_var}");
        assert_eq!(
            sanitize_css_declarations(&token_color_decl),
            token_color_decl
        );
        let nested_wrapped_var =
            format!("var(--ferriki-builtin-color, var(--ferriki-function-color, {composed}))");
        assert!(is_safe_css_color(&nested_wrapped_var));
        let nested_decl = format!("--_ferriki-token-color:{nested_wrapped_var}");
        assert_eq!(sanitize_css_declarations(&nested_decl), nested_decl);
        let hostile_wrapped = format!(
            "--_ferriki-token-color:var(--ferriki-keyword-color, light-dark({long_light}, url(https://evil.test/{})))",
            "x".repeat(260)
        );
        assert_eq!(sanitize_css_declarations(&hostile_wrapped), "");

        // A valid <=512-char single color (e.g. 500-char color-mix) wrapped in
        // `var(--ferriki-foreground, ...)` also survives validation even when total > 512.
        let single_500 = format!(
            "color-mix(in oklch, var(--{}) 50%, var(--{}))",
            "a".repeat(225),
            "b".repeat(234)
        );
        assert_eq!(single_500.len(), 500);
        assert!(is_safe_css_color(&single_500));
        let wrapped_single = format!("var(--ferriki-foreground, {single_500})");
        assert!(wrapped_single.len() > MAX_CSS_VALUE_LEN);
        assert!(is_safe_css_color(&wrapped_single));
        let wrapped_single_decl = format!("color:{wrapped_single}");
        assert_eq!(
            sanitize_css_declarations(&wrapped_single_decl),
            wrapped_single_decl
        );
        let single_513 = format!(
            "color-mix(in oklch, var(--{}) 50%, var(--{}))",
            "a".repeat(235),
            "b".repeat(237)
        );
        assert_eq!(single_513.len(), 513);
        assert!(!is_safe_css_color(&format!(
            "var(--ferriki-foreground, {single_513})"
        )));

        // Generated palette/custom properties (`--shiki-*`, `--custom-*`) preserve composed
        // `light-dark(...)` values, and CSS comments around property names are stripped cleanly.
        let shiki_light_decl = format!("--shiki-light:{composed}");
        assert_eq!(
            sanitize_css_declarations(&shiki_light_decl),
            shiki_light_decl
        );
        let custom_light_decl = format!("--custom-light:{composed}");
        assert_eq!(
            sanitize_css_declarations(&custom_light_decl),
            custom_light_decl
        );
        assert_eq!(
            sanitize_css_declarations("color:red; /* layout */ padding:1rem"),
            "color:red;padding:1rem"
        );
        assert_eq!(
            sanitize_css_declarations("color:red; /* note: gap */ padding /* x */ : 1rem"),
            "color:red;padding:1rem"
        );
        assert_eq!(sanitize_css_declarations("/* unclosed padding:1rem"), "");
        assert_eq!(sanitize_css_declarations("/* \x07 */ color:red"), "");
        let hostile_composed = format!(
            "light-dark({long_light}, url(https://evil.test/{}))",
            "x".repeat(260)
        );
        assert!(!is_safe_css_color(&hostile_composed));
        assert_eq!(
            sanitize_css_declarations(
                "grid-template-columns:repeat(2, 1fr);color:red !important;background:image-set(\"a.png\" 1x);width:src(\"a.png\")"
            ),
            "grid-template-columns:repeat(2, 1fr);color:red !important"
        );
        assert_eq!(sanitize_css_declarations("color:red !bogus"), "");
        assert_eq!(
            sanitize_css_declarations(
                "background:-webkit-image-set(\"a.png\" 1x);mask:-moz-element(#x);content:-webkit-cross-fade(\"a.png\", \"b.png\", 50%);--shiki-animation-duration:200ms"
            ),
            "--shiki-animation-duration:200ms"
        );
        // Image-loading functions accepting string URIs (`-moz-image-rect`, `image-rect`,
        // `paint`, `filter(...)`) are rejected, while safe `filter: blur(2px)` is preserved.
        assert_eq!(
            sanitize_css_declarations(
                "list-style-image:-moz-image-rect(\"https://evil.example/x.png\", 0, 10, 10, 0);background-image:image-rect(\"https://evil.example/x.png\", 0, 10, 10, 0);background:paint(evil);background:filter(\"https://evil.example/x.png\", blur(2px));filter:blur(2px)"
            ),
            "filter:blur(2px)"
        );
        // `var(...)` argument scanning is quote-aware so parens inside quoted strings work.
        assert_eq!(
            sanitize_css_declarations(
                "content:var(--opening-mark, \"(\");--close:var(--closing-mark, \")\")"
            ),
            "content:var(--opening-mark, \"(\");--close:var(--closing-mark, \")\")"
        );
        assert_eq!(sanitize_css_declarations("content:var(--bad, \")"), "");
        // Unbalanced brackets and unclosed quotes are rejected cleanly.
        assert_eq!(
            sanitize_css_declarations("grid-template-columns:[unclosed;padding:1rem"),
            ""
        );
        assert_eq!(
            sanitize_css_declarations("grid-template-columns:[main-start] 1fr [main-end]"),
            "grid-template-columns:[main-start] 1fr [main-end]"
        );
        assert_eq!(
            sanitize_css_declarations("grid-template-columns:];padding:1rem"),
            "padding:1rem"
        );

        // Max-length prefix (128) + max-length theme key (128) + "-text-decoration" (16) = 272
        // must survive declaration sanitization consistently with prefix/key validation.
        let long_prefix = format!("--{}", "p".repeat(126));
        let long_key = "k".repeat(128);
        assert!(is_valid_css_variable_prefix(&long_prefix));
        assert!(is_valid_css_identifier(&long_key));
        let long_decl = format!("{long_prefix}{long_key}-text-decoration:underline");
        assert_eq!(sanitize_css_declarations(&long_decl), long_decl);

        // Non-ASCII CSS custom properties survive sanitization and color var() validation,
        // while unsafe custom property names remain rejected.
        assert_eq!(
            sanitize_css_declarations("--café: red; color: var(--café)"),
            "--café:red;color:var(--café)"
        );
        assert!(is_safe_css_color("var(--café, #fff)"));
        assert_eq!(
            sanitize_css_declarations("--a}b: red; --a(b): red; --caf\u{00a0}é: red"),
            ""
        );
        assert!(!is_safe_css_color("var(--a;b)"));
        assert!(!is_safe_css_color("var(--a}b)"));
        assert!(!is_safe_css_color("var(--a(b))"));
        assert!(!is_safe_css_color("var(--caf\u{00a0}é)"));
        assert_eq!(sanitize_css_declarations("--a\u{FEFF}b: red"), "");
        assert!(!is_safe_css_color("var(--a\u{FEFF}b)"));
        assert_eq!(
            sanitize_css_declarations(
                "transform: translateX(1rem) var(--extra-transform,); color: var(--accent,)"
            ),
            "transform:translateX(1rem) var(--extra-transform,);color:var(--accent,)"
        );
        assert_eq!(
            sanitize_css_declarations("color: var(,); background: var(--,)"),
            ""
        );
        // Whitespace-only custom property values (`--decoration: `) are valid CSS and suppress
        // `var()` fallbacks, while empty custom properties and whitespace-only ordinary
        // properties remain rejected.
        assert_eq!(
            sanitize_css_declarations("--decoration: ; color: red"),
            "--decoration: ;color:red"
        );
        assert_eq!(sanitize_css_declarations("--decoration:"), "");
        assert_eq!(sanitize_css_declarations("color: "), "");

        // Valid composed colors inside `light-dark(...)` survive validation, while excess
        // nesting depth is rejected.
        let composed_light = format!(
            "var(--light-a, var(--light-b, color-mix(in oklch, var(--{}) 50%, var(--{}))))",
            "a".repeat(220),
            "b".repeat(220)
        );
        let composed_dark = format!(
            "var(--dark-a, var(--dark-b, color-mix(in oklch, var(--{}) 50%, var(--{}))))",
            "c".repeat(220),
            "d".repeat(220)
        );
        let combined = format!("light-dark({composed_light}, {composed_dark})");
        assert!(is_safe_css_color(&combined));
        let wrapped = format!("--_ferriki-token-color:var(--ferriki-keyword-color, {combined})");
        assert_eq!(sanitize_css_declarations(&wrapped), wrapped);
        let too_deep = format!(
            "light-dark(light-dark(light-dark(light-dark(light-dark({composed_light}, #000), #000), #000), #000), #000)"
        );
        assert!(!is_safe_css_color(&too_deep));
    }

    #[test]
    fn hast_node_to_html_rejects_invalid_tag_and_attribute_names() {
        let valid_custom = json!({
            "type": "element",
            "tagName": "syntax-token_v2",
            "properties": { "class": "ok" },
            "children": [{ "type": "text", "value": "x" }],
        });
        assert_eq!(
            hast_node_to_html(&valid_custom),
            "<syntax-token_v2 class=\"ok\">x</syntax-token_v2>"
        );
        let unicode_custom = json!({
            "type": "element",
            "tagName": "x-café",
            "properties": { "class": "ok" },
            "children": [{ "type": "text", "value": "x" }],
        });
        assert_eq!(
            hast_node_to_html(&unicode_custom),
            "<x-café class=\"ok\">x</x-café>"
        );
        assert!(!is_safe_decoration_tag_name("x-café"));
        let hostile_tag = json!({
            "type": "element",
            "tagName": "span><script>alert(1)</script><span",
            "properties": {},
            "children": [{ "type": "text", "value": "x" }],
        });
        assert_eq!(hast_node_to_html(&hostile_tag), "");

        let hostile_attr = json!({
            "type": "element",
            "tagName": "span",
            "properties": {
                "class": "ok",
                "x\" onclick=\"alert(1)": "bad",
                "bad name": "bad",
                "bad=name": "bad",
            },
            "children": [{ "type": "text", "value": "x" }],
        });
        assert_eq!(
            hast_node_to_html(&hostile_attr),
            "<span class=\"ok\">x</span>"
        );
    }

    #[test]
    fn css_color_and_declaration_support_valid_var_and_env_ident_escapes() {
        for valid in [
            "var(--brand\\+accent)",
            "var(--brand\\3a accent)",
            "var(--brand\\3a accent, #fff)",
            "var(--brand\\+accent, var(--fallback\\3a color, rgb(10 20 30)))",
            "color-mix(in oklch, var(--brand\\+accent) 50%, var(--brand\\3a accent))",
            "light-dark(var(--brand\\+accent, #111), var(--brand\\3a accent, #eee))",
            "env(my\\-env 0, #fff)",
            "env(my\\3a env 0, #fff)",
            "env(--custom\\+env, #123456)",
        ] {
            assert!(
                is_safe_css_color(valid),
                "expected valid escaped var/env color to be accepted: {valid}"
            );
            assert_eq!(
                sanitize_css_declarations(&format!("color:{valid}")),
                format!("color:{valid}")
            );
        }
        assert_eq!(
            sanitize_css_declarations("border-color:var(--brand\\+accent);--brand\\3a accent:#fff"),
            "border-color:var(--brand\\+accent);--brand\\3a accent:#fff"
        );
        for invalid in [
            "var(--a\\0b)",
            "var(--a\\)",
            "var(--a\\0)",
            "var(--a\\000000b)",
            "var(--a\\0a b)",
            "var(--a\\7f b)",
            "var(--a\\d800 b)",
            "var(--a\\d800x)",
            "var(--a\\110000b)",
            "var(--a+b)",
            "var(--a:b)",
            "var(--a\\;color:red)",
            "rgb(255 \\30 0)",
            "var(--a\\+b, \\30)",
            "env(my\\0env 0, #fff)",
            "env(my\\)",
        ] {
            assert!(
                !is_safe_css_color(invalid),
                "expected invalid escaped var/env color to be rejected: {invalid}"
            );
            assert_eq!(sanitize_css_declarations(&format!("color:{invalid}")), "");
        }
    }

    #[test]
    fn direct_class_mode_matches_hast_and_extract_styles_byte_for_byte() {
        let mut line = Vec::new();
        let scope_paths = [
            vec![],
            vec!["source.probe".to_owned()],
            vec![
                "source.probe".to_owned(),
                "meta.a".to_owned(),
                "meta.a".to_owned(),
                "entity.name.probe".to_owned(),
            ],
            vec![
                "source.probe".to_owned(),
                "meta.a-b".to_owned(),
                "meta.😀_\"".to_owned(),
                "entity.name.probe".to_owned(),
            ],
            vec![
                "source.probe".to_owned(),
                "meta.a-b".to_owned(),
                "keyword.control".to_owned(),
            ],
        ];
        let colors = [
            None,
            Some(""),
            Some("#81A1C1"),
            Some("rgb(12, 34, 56)"),
            Some("red;position:fixed"),
        ];
        for (i, scopes) in scope_paths.iter().enumerate() {
            for (j, color) in colors.iter().enumerate() {
                for bits in [-1, 0, 1, 2, 3, 4, 8, 12, 15, 32] {
                    line.push(HighlightToken {
                        content: format!("tok_{i}_{j}_<&\"😀"),
                        offset: 0,
                        color: color.map(str::to_owned),
                        font_style: Some(FontStyle::from_bits(bits)),
                        token_type: None,
                        scope_names: Some(scopes.clone()),
                    });
                }
            }
        }
        let result = HighlightTokensResult {
            tokens: vec![line, Vec::new()],
            foreground: "#d8dee9".to_owned(),
            background: "#2e3440".to_owned(),
            theme_name: "probe<&\"".to_owned(),
        };

        for include_root_style in [false, true] {
            for root_style in [
                None,
                Some(""),
                Some("color:#111;font-weight:bold"),
                Some("background:url(https://evil.test)"),
            ] {
                for tabindex in [None, Some(""), Some("0"), Some("-1<&\"")] {
                    let options = RenderOptions::default()
                        .with_style_mode(StyleMode::Classes)
                        .with_include_root_style(include_root_style)
                        .with_root_style(root_style.map(str::to_owned))
                        .with_tabindex(tabindex.map(str::to_owned));

                    assert_html_matches_hast(&result, &options);

                    let mut tree = render_styled_hast(&result, &options);
                    let mut rules = BTreeMap::new();
                    extract_styles(&mut tree, &mut rules);
                    let expected_css = rules.into_values().collect::<Vec<_>>().join("\n");
                    let expected_html = hast_node_to_html(&tree["children"][0]);

                    let rendered = render_html_with_css(&result, &options);
                    assert_eq!(rendered.html, expected_html, "{options:?}");
                    assert_eq!(rendered.css, expected_css, "{options:?}");
                }
            }
        }
    }

    #[test]
    fn node_class_renderer_emits_explicit_font_defaults_and_empty_root_style_fallback() {
        let result = HighlightTokensResult {
            tokens: vec![vec![
                HighlightToken {
                    content: "plain".to_owned(),
                    offset: 0,
                    color: None,
                    font_style: None,
                    token_type: None,
                    scope_names: Some(vec!["source.test".to_owned()]),
                },
                HighlightToken {
                    content: "kw".to_owned(),
                    offset: 5,
                    color: Some("#81A1C1".to_owned()),
                    font_style: Some(FontStyle::ITALIC | FontStyle::BOLD | FontStyle::UNDERLINE),
                    token_type: None,
                    scope_names: Some(vec!["source.test".to_owned(), "keyword.test".to_owned()]),
                },
                HighlightToken {
                    content: "bad".to_owned(),
                    offset: 7,
                    color: Some("url(https://evil.test)".to_owned()),
                    font_style: Some(FontStyle::STRIKETHROUGH),
                    token_type: None,
                    scope_names: Some(vec!["source.test".to_owned()]),
                },
            ]],
            foreground: "#d8dee9".to_owned(),
            background: "#2e3440".to_owned(),
            theme_name: "nord".to_owned(),
        };

        let opts = RenderOptions::default()
            .with_style_mode(StyleMode::Classes)
            .with_root_style(Some(String::new()));
        let rendered = render_html_with_css_node(&result, &opts);
        assert_eq!(rendered.html, render_html_node_classes(&result, &opts));
        assert!(
            rendered
                .css
                .contains("{background-color:#2e3440;color:#d8dee9}")
        );
        assert!(
            rendered
                .css
                .contains("{font-style:normal;font-weight:normal;text-decoration:none}")
        );
        assert!(rendered.css.contains(
            "{color:#81A1C1;font-style:italic;font-weight:bold;text-decoration:underline}"
        ));
        assert!(
            rendered
                .css
                .contains("{font-style:normal;font-weight:normal;text-decoration:line-through}")
        );
        assert!(!rendered.css.contains("url("));
    }

    #[test]
    fn html_capacity_estimates_stay_bounded_for_large_inputs() {
        // Normal files retain full 4x speculative capacity.
        assert_eq!(bounded_source_html_capacity(1024), 1024 * 4 + 128);
        // Huge 16 MiB source clamps speculative overhead to 1 MiB instead of 48 MiB.
        assert_eq!(
            bounded_source_html_capacity(16 * 1024 * 1024),
            17 * 1024 * 1024
        );
        // Token-based overhead clamps at 4 MiB while preserving full content bytes.
        assert_eq!(
            bounded_token_html_capacity(16 * 1024 * 1024, 64 * 1024 * 1024),
            20 * 1024 * 1024
        );
    }
}
