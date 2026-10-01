# Class-based highlighting

HTML is Ferriki's primary Node output. `codeToHtml` keeps inline styles as its
default; use `styleMode: "classes"` or `codeToHtmlWithCss` when the page should
style nested grammar scopes with CSS. HAST and token outputs remain available
for consumers that need structured results. Class-based output is available in
the current repository build and will ship in the next release.

## Inspiration

This mode was inspired by [GitHub's PrettyLights](https://github.com/wooorm/starry-night#what-is-prettylights)
and [wooorm's starry-night](https://github.com/wooorm/starry-night), which recreates
PrettyLights-style class-based highlighting. Starry-night was the starting point
for exploring CSS classes and stylesheet-driven themes in Ferriki.

Ferriki implements the idea on its existing native TextMate runtime, preserving
full nested scope paths and extracting CSS from resolved theme styles.

## Use your own CSS

Select `styleMode: "classes"` on `codeToHtml` or `codeToHast`. Use `theme: "none"`
when your stylesheet owns all colors:

```ts
import { codeToHtml } from "@ferriki/core";

const html = await codeToHtml('const message = "hello";', {
  lang: "javascript",
  theme: "none",
  styleMode: "classes",
});
```

```css
.ferriki {
  color: #24292f;
  background: #ffffff;
}
.ferriki .tok-string {
  color: #0a3069;
}
.ferriki .tok-keyword,
.ferriki .tok-storage {
  color: #cf222e;
}
.ferriki .tok-comment {
  color: #57606a;
  font-style: italic;
}
```

Each grammar scope becomes a nested `span`. Adjacent tokens share ancestor
wrappers when their paths agree. Scope order and repeated scopes remain visible;
wrappers are closed at each line. Empty lines are retained. CRLF is normalized
to LF, as with the default renderer.

| Class     | Meaning                                         | Example                                 |
| --------- | ----------------------------------------------- | --------------------------------------- |
| `ferriki` | Code-block root (or `code` in inline structure) | `.ferriki`                              |
| `token`   | Source token                                    | `.token`                                |
| `tok-*`   | Any scope prefix in the token's path            | `.tok-string`                           |
| `leaf-*`  | Prefix of the token's innermost scope           | `.leaf-variable-parameter`              |
| `scope-*` | Prefix of this ancestor wrapper's scope         | `.scope-meta-structure-dictionary-json` |
| `exact-*` | This wrapper's complete scope                   | `.exact-string-quoted-double-json`      |

Scopes come from the grammar, so their names and detail depend on the language.
Dots become hyphens; literal hyphens, underscores, and other characters are
encoded as `_hex_` (Unicode code point, lowercase hexadecimal). For example,
`support.type.property-name.json` becomes `support-type-property_2d_name-json`.
This keeps distinct scopes distinct without CSS escaping.

Simple selectors apply to tokens. Context selectors combine wrappers and leaves:

```css
/* String contents inside JSON dictionaries. */
.ferriki .scope-meta-structure-dictionary-json .leaf-string-quoted-double-json {
  color: #8250df;
}

/* Escapes anywhere inside strings. */
.ferriki .tok-string.tok-constant-character-escape {
  color: #cf222e;
}

/* Scope order and repetition can use child combinators. */
.ferriki .exact-meta-a > .exact-meta-a > .exact-entity-name-probe > .token {
  color: #008000;
}
```

## Reuse existing themes

TextMate/Shiki theme JSON files work unchanged. The native engine still resolves
selectors, ancestor context, priorities, and inherited styles. `codeToHtmlWithCss`
returns `{ html, css }` and always selects classes mode:

```ts
import { codeToHtmlWithCss } from "@ferriki/core";

const { html, css } = await codeToHtmlWithCss('{"message":"hello"}', {
  lang: "json",
  theme: "monokai",
});
```

Put `html` into the page and `css` into a stylesheet. Combine the CSS from **all**
rendered blocks; it contains only styles used by those results. Identical rules
can be deduplicated. It is not a general theme stylesheet that covers arbitrary
future code. Adding code or changing a theme requires regenerating its HTML and
CSS. The browser needs no grammar, theme JSON, or highlighting engine.

The renderer moves resolved declarations into deterministic `ferriki-style-*`
classes. Their full SHA-256 names are implementation details: author selectors
against the readable scope classes. Generated rules use `:where(...)` with zero
specificity, so ordinary scope selectors override theme styles without
`!important`. These generated classes also retain styling when decorations add
wrappers around tokens.

For example, Monokai gives a standalone JSON `"hello"` color `#E6DB74`, and the
same text inside `{"message":"hello"}` color `#CFCFC2`. Both retain their scope
paths and their different resolved styles in classes mode.

## Switch themes without highlighting again

Prepare a theme map once:

```ts
const { html, css } = await codeToHtmlWithCss(source, {
  lang: "typescript",
  themes: { light: "github-light", dark: "github-dark" },
});
```

The returned CSS includes variables and switching rules for all supplied themes.
Set `data-ferriki-theme="dark"` on the code-block root or an ancestor; change it
to `light` to switch back. A root attribute takes precedence over an ancestor.
The token elements stay the same. Use a root attribute for per-block overrides
inside containers that already select another theme. You can connect this
attribute to your site's existing theme control, or select the attribute in a
server-rendered page.

`defaultColor` selects the initial theme. With `defaultColor: false`, no palette
is selected until `data-ferriki-theme` chooses one. With
`defaultColor: "light-dark()"`, the generated CSS follows
`prefers-color-scheme` until an explicit attribute selects a theme. Theme map keys
must match `[a-z_][a-z0-9_-]*` (case insensitive); a custom `cssVariablePrefix`
must start with `--` and use the same identifier characters.

Your own CSS themes can switch through the site's classes or attributes directly:
no TextMate theme registration is required. Use `theme: "none"` for that route.

## Integration contract

- Classes mode uses `.ferriki` instead of `.shiki` on its root so existing
  Shiki-specific site rules do not select the new structure.
- `styleMode: "inline"` and omitted `styleMode` retain the existing output.
- Classes mode preserves grammar boundaries and scope paths. Whitespace and
  equal-style merging are skipped even if the merge options are enabled.
- `codeToTokens` exposes `scopeNames` in classes mode. Normal token output is
  unchanged.
- Token/span transformers still run on individual source tokens. Scope nesting
  and style extraction run after HAST hooks and decorations. Transformers that
  depend on the default flat DOM must be adapted; transformer-created tokens
  should retain `scopeNames` to keep context styling.
- Transformer-added styles are extracted too. A `postprocess` hook runs last and
  owns any HTML changes it makes, including additional inline styles.
- `rootStyle: false` suppresses root theme declarations. An explicit `rootStyle`
  is moved into CSS. Inline structure uses a `code.ferriki` container with `br`
  separators so theme CSS has a stable root.
- The returned CSS is stylesheet content. Save it as CSS; do not interpolate
  untrusted theme or transformer values into an unescaped HTML `style` element.

## Rust

```rust
use std::path::Path;
use ferriki::{Highlighter, RenderOptions, StandardAssetCatalogs};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let assets = StandardAssetCatalogs::load_from_root(Path::new("assets/shiki"))?;
    let mut highlighter = Highlighter::builder().with_assets(assets).build()?;
    let output = highlighter.highlight_html_with_css(
        "const answer = 42;", "javascript", "nord", &RenderOptions::default(),
    )?;
    // output.html contains nested classes; output.css contains resolved styles.
    Ok(())
}
```

For token-level use, enable
`TokenizeOptions::with_preserve_scope_boundaries(true)`, then render with
`RenderOptions::with_style_mode(StyleMode::Classes)` or `render_html_with_css`.
The Node API additionally supports theme maps and JavaScript transformers.

The [experiment report](experiments/class-highlighting.md) describes the corpus,
original comparison, and its limits. Those results measure the tested examples,
not a population-level claim that 95% of user requests are covered.
