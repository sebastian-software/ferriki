# ADR 0019: Present Prepared React Code in a Shadow DOM Element

## Status

Accepted

Last updated: 2026-10-12

## Context

Ferriki prepares HTML plus optional CSS. An ordinary custom element can own
that finished markup while React manages its host. A reference registry keeps
HTML outside React props. During SSR, the macro can put prepared HTML inside
Declarative Shadow DOM (DSD) through a server-only HTML sink; in the browser it
returns an empty reference host and registers the same block for later client
navigation. The document parser creates the shadow root before custom-element
upgrade, which preserves the server nodes without a JSX token serializer.

A direct property interface remains useful for consumers who need to transport
HTML themselves, but it serializes the complete value as an escaped SSR
attribute. A short reference avoids that transport. Every root can carry the
small base rules it needs for layout, scrolling, line annotations, and inline
theme switching. Classes mode loads its generated rules from one external CSS
asset.
The [lifecycle diagram](../docs/shadow-code-elements.md#react-ssr-and-declarative-shadow-dom)
and [ownership diagram](../docs/shadow-code-elements.md#dom-and-module-ownership)
show the build, parser, upgrade, hydration, and later client-rendered paths.

## Decision

- The Web Component is the single built-in React presentation. We do not
  maintain a second light-DOM React renderer or a presentation-mode option.
  The `render` callback remains an application-owned escape hatch. HTML
  generation remains the component's input and a public highlighter contract;
  it is independent of this browser presentation choice.
- `@ferriki/core/web-component` is a framework-free presentation entry. It
  exports `FERRIKI_CODE_TAG`, `codeElementSizing`, `codeElementStyles`, and
  `defineCodeElement` and imports neither the native highlighting runtime nor
  React.
- `defineCodeElement({ css, stylesheetHref, themeAliases, blocks })` explicitly
  registers `<ferriki-code>` and trusted HTML by ID. Its optional `css` value
  adds manually supplied local rules; `stylesheetHref` loads generated
  class-mode CSS. Registration is safe on a server and returns `undefined`
  without browser custom-element APIs. It is idempotent for Ferriki's definition
  and rejects a foreign definition of the same tag.
- The element accepts trusted prepared HTML through its `highlightedCode`
  property or `highlighted-code` attribute. It parses only inside an open
  shadow root and never moves or replaces light-DOM children. Equal strings
  retain the root and token nodes. Content updates replace root contents;
  theme and parent updates retain them.
- The default content interface is `code-ref`, with an optional reflecting
  `codeRef` property. IDs contain only ASCII letters, digits, underscores, and
  hyphens. Identical ID/HTML registration is idempotent; conflicting HTML
  throws. A changed reference clears stale content even if its block has not
  arrived yet. Late registration updates connected hosts waiting for that ID.
  The latest explicit property or observed attribute write selects the source.
- Inline-mode colors remain in the prepared HTML's style attributes. Each root
  gets a small `<style data-ferriki-code-base>` element for layout, scrolling,
  line annotations, and multi-theme switching; it has no external CSS asset or
  URL requirement. In classes mode, one aggregated external asset contains the
  resolved token and theme rules. Each root links that asset before JavaScript,
  and the link remains after upgrade. Client-created roots add the same link.
- No constructed or adopted stylesheet is required. One tag definition uses
  one theme alias configuration; conflicting alias sets fail. Manual local CSS
  must use that same theme mapping and compatible presentation rules. External
  class rules are shared by URL, and stylesheet links remain in the roots.
- Public semantic color custom properties inherit from normal page CSS on
  `:root`, a theme container, or the host. `--ferriki-foreground` and
  `--ferriki-background-color` are the root controls. Category overrides follow
  the documented fallback chains and then use each token's resolved theme color.
  The foreground sets the block's default text color; it does not flatten
  themed token colors. The finite category palette does not replace nested scope
  selectors. The guide documents the full catalog; internal per-token variables
  are not public overrides.
- Shadow DOM isolates inner code nodes from page selectors and keeps component
  stylesheet rules inside their roots. It does not guarantee identical pixels
  across documents: page CSS can style the host, and inherited values, custom
  properties, root-relative units, and available fonts can affect presentation.
  The default font size and line height use `rem`; the inner `pre` inherits its
  font family from the host.
- `codeElementSizing(lineCount, maxLines?)` supplies host styles that reserve
  space before JavaScript. The optional cap and line count must be positive safe
  integers; omitted or `undefined` `maxLines` means unlimited. Invalid helper
  arguments and invalid property assignments throw. Reservation uses the smaller
  of the count and cap and includes block padding. The helper uses content-box
  host sizing and shares `--ferriki-code-line-height` and
  `--ferriki-code-padding-block` length variables with the shadow `pre`, which
  defaults to `1.3125rem` and `0px`. Nonwrapping preformatted output is the
  estimate's baseline; custom layout can require application-specific sizing.
- The element's `maxLines` property accepts a positive safe integer, `null`, or
  `undefined`; nullish values mean unlimited. The canonical `max-lines`
  attribute stays `max-lines`; React SSR may lowercase a JSX `maxLines` property
  to the `maxlines` alias. It accepts valid caps and ignores invalid values. A
  cap limits the visible viewport, not its contents: all code remains in the
  root and longer blocks scroll vertically. Short blocks stay short. The shared
  `pre` cap uses `--ferriki-code-max-block-size`. The capped `pre` gets a managed
  `tabindex="0"` unless it has an authored `tabindex`, so keyboard users can
  scroll it. The default `Code` macro applies both the cap and matching
  no-JavaScript reservation; manual hosts supply the attribute and
  `codeElementSizing(lineCount, maxLines)` themselves.
- The React `Code` macro produces a custom-element host with
  `code-ref={codeRef}`. Module-level descriptors and HTML registration stay
  outside React props. Content-derived IDs share identical prepared results;
  the client module registers once on its first default render. The helper uses
  `import.meta.env.SSR` to select its output. The server branch passes the DSD
  template through server-only `dangerouslySetInnerHTML`; the client branch
  returns an empty reference host after registering prepared HTML, theme
  aliases, and the optional class stylesheet URL. This trusted HTML boundary
  does not create token JSX or use hydration
  suppression. React owns the host; the element owns the highlighted shadow
  contents. Runtime `className` and `theme` apply to the host. Module-level
  styles reserve space from the build-known source line count and optional cap,
  including trailing blank lines; empty source reserves one line. Theme aliases
  are validated as CSS-safe identifiers at build time.
- `@ferriki/core/web-component/server` exports the framework-free
  `renderCodeElementShadows(markup, { blocks, themeAliases, stylesheetHref })`
  helper. It fills eligible empty reference hosts in complete, well-formed
  server HTML with Declarative Shadow DOM, a reference marker, the matching
  local base-style element, and an optional class CSS link. It skips
  manual/property hosts and inert contexts, rejects unknown eligible references,
  and is idempotent. This stage runs outside React.
- Register after the browser has parsed the DSD HTML and before hydration.
  Upgrade reuses the parser-created root and retains nodes for a matching
  reference marker. React hydrates the host without moving shadow nodes. The
  local base-style element stays in the root, and any class CSS link remains
  there after upgrade so the browser can load the external asset. Class-mode
  CSS must be deployed with the SSR output. Client and SSR build graphs can
  produce different asset hashes; the SSR output's stylesheet must be served
  for its markup.
  Ordinary complete-page `renderToString` hydration is verified. Defining the
  element before the parser reaches DSD, streaming SSR, and React Server
  Components are outside the verified contract.
- Each root receives the component's small base and theme-switching rules in a
  local style element. Inline mode uses no external CSS asset and imposes no
  Vite `base` restriction. In classes mode, Vite combines descriptor rules into
  one aggregated asset; the DSD template links it before JavaScript, and CSR
  roots link it after registration. `code()` and React calls with a declared
  `render` prop keep ordinary Vite CSS delivery and the unchanged HTML-backed
  descriptor. A runtime absent or `undefined` renderer selects the default; a
  callback's result is returned unchanged. Custom renderers do not reserve the
  tag unless they use it.
- In classes mode, the Vite adapter serves the aggregated CSS at
  `${base}@ferriki/code-elements.css` in development and emits a hashed
  `assets/ferriki-code-*.css` file in production. The SSR build re-emits that
  asset even when Vite suppresses ordinary SSR assets; applications deploy the
  CSS emitted by the SSR build because client and server graphs can use
  different hashes. Direct class-mode macro SSR requires an absolute path or URL
  `base`; relative bases are rejected because the DSD URL would be ambiguous on
  nested routes.
- The Vite plugin API exposes `renderCodeElements`, `codeElementBlocks`, and
  `codeElementCss` for already transformed React modules. `renderCodeElements`
  remains an explicit complete-HTML path for manually authored reference hosts;
  default macro SSR needs no post-render rewrite. Production builds can save
  the registry and, in classes mode, the CSS asset for the standalone helper.
  Client and server preparation must use identical options for matching
  content-derived IDs.
- The browser HTML parser remains necessary inside the element. Source is
  escaped by Ferriki, while custom transformer markup is trusted caller code.
  Shadow DOM is not a sanitizer or security boundary. The component's client
  HTML sink can be rejected by strict Trusted Types policies; no policy or `TrustedHTML` hook is
  provided. The local base-style element needs CSP permission in both modes.
  Inline token output also uses style attributes; automatic SSR sizing uses
  host style attributes in both modes. Classes mode needs its external
  stylesheet allowed by the application's stylesheet policy.

## Consequences

- Consumers can use `<ferriki-code code-ref="…" />` directly in React 19 and
  register prepared HTML separately. The `highlightedCode` property remains
  available for direct string transport. The default presentation uses a
  server-only raw HTML sink to serialize DSD; it does not create a token JSX
  tree. The browser runtime only presents prepared code.
- Server HTML contains DSD with the prepared block inside the host; each root
  has its local base rules, and classes mode adds a link to the aggregated CSS
  asset. The client render carries only the reference host and registers HTML
  plus the optional class asset URL for hydration and later navigation. The
  registry can also be delivered separately by a consumer.
- The Node highlighter remains HTML-only. The root API, `code()` descriptor,
  theme preparation, and native renderer retain their existing contracts.
- CSS isolation and ownership are the primary benefits; no general performance
  improvement is claimed. The small construction overhead observed in the
  focused client-only fixture is an acceptable tradeoff for those benefits;
  it does not justify maintaining two built-in React renderers. The earlier
  [React-host report](../node/benchmarks/shadow-dom-spike/REPORT.md) and
  [template-component report](../node/benchmarks/shadow-dom-spike/WEB-COMPONENT-REPORT.md)
  are historical measurements of different implementations. The
  [property-component report](../node/benchmarks/shadow-dom-spike/PROPERTY-COMPONENT-REPORT.md)
  records the earlier property runtime and shared stylesheet. It shows higher SSR
  and initial hydration costs for these workloads; it is not a speedup claim.
- The [reference and DSD report](../node/benchmarks/shadow-dom-spike/REFERENCE-DSD-REPORT.md)
  compares all four renderers on 2026-10-11. References avoid escaped-HTML SSR
  transport; DSD preserves pre-JavaScript highlighting and reduces setup and
  hydration commit intervals relative to the property adapter in these fixtures.
  Client-only mount costs remain similar, and light DOM has a shorter measured
  hydration call-to-commit interval.
  Document parsing and asset loading are outside the measured intervals, so
  the results do not establish complete-startup or isolated React CPU costs.
- The [hydration breakdown](../node/benchmarks/shadow-dom-spike/HYDRATION-BREAKDOWN.md)
  attributes most of the inline reference interval to pending browser rendering
  after registration. The light-DOM trace performs similar work before its
  timer starts. React hydrates the outer hosts without walking shadow tokens;
  the interval difference does not establish corresponding React overhead.

## Release scope

Ship this first default React presentation transition as Ferriki 1.1.0. This
is a one-time exception during the initial 1.x adoption period, limited to the
macro's generated DOM and CSS scoping. Existing `<Code />` calls, the HTML API,
the `code()` descriptor, and custom `render` callbacks retain their contracts.
Consumers that style or inspect the previous light-DOM contents must follow
the [migration guide](../docs/shadow-code-elements.md#migrate-existing-react-macros).
This does not relax the published Rust semver gate or future compatibility
guarantees for stable APIs.

The integration commit carries `Release-As: 1.1.0`; the PR's commit override
carries the same version for squash merges. This overrides the earlier major
marker for this transition without changing global Release Please versioning
or keeping a persistent `release-as` configuration. Release Please continues
to own the synchronized package and crate version updates.

## History

- 2026-10-11: Accepts the Web Component as the single built-in React presentation,
  with reference registration, shared styles, line caps, and optional complete-HTML
  DSD. Preserves the HTML API and custom-render escape hatch; records measurement
  boundaries and the limits of CSS isolation.
- 2026-10-11: Makes direct macro-generated DSD the default React SSR path and
  reserves the complete-HTML helper for manually authored reference hosts.
  Records Vite's one shared development/production stylesheet asset and the
  absolute-base requirement for direct SSR URLs.
- 2026-10-11: Targets 1.1.0 with a one-time release override for the initial
  React macro presentation transition; retains the migration guidance and all
  other stable API and Rust semver guarantees (#263).
- 2026-10-12: Uses per-root base styles and an optional external class CSS asset
  instead of a constructed shared sheet; allows inline mode without a CSS URL
  or base restriction and documents inherited category color overrides and
  block-level foreground/background defaults (#263).
