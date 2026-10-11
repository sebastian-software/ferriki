# ADR 0019: Present Prepared React Code in a Shadow DOM Element

## Status

Accepted

Last updated: 2026-10-11

## Context

Ferriki prepares HTML plus optional CSS. An ordinary custom element can own
that finished markup while React manages its empty host. A reference registry
keeps the HTML outside React props, and a separate server HTML stage can
populate the shadow root before JavaScript without a JSX token serializer.

The initial template-based implementation retained React HTML injection and
repeated local CSS in each root. A direct property interface is simpler and
allows all code instances to adopt one constructed stylesheet. That property
path still serializes the complete HTML as an escaped SSR attribute. A short
reference avoids that transport, while Declarative Shadow DOM restores
highlighted output before JavaScript through the document parser.

## Decision

- The Web Component is the single built-in React presentation. We do not
  maintain a second light-DOM React renderer or a presentation-mode option.
  The `render` callback remains an application-owned escape hatch. HTML
  generation remains the component's input and a public highlighter contract;
  it is independent of this browser presentation choice.
- `@ferriki/core/web-component` is a framework-free presentation entry. It
  exports `FERRIKI_CODE_TAG`, `codeElementSizing`, `codeElementStyles`, and `defineCodeElement` and
  imports neither the native highlighting runtime nor React.
- `defineCodeElement({ css, themeAliases, blocks })` explicitly registers
  `<ferriki-code>`, trusted HTML by ID, and shared CSS. Registration is safe on a server
  and returns `undefined` without browser custom-element APIs. It is idempotent
  for Ferriki's definition and rejects a foreign definition of the same tag.
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
- Inline-mode colors remain in the prepared HTML's style attributes. Shared
  CSS supplies base presentation, line annotations, and multi-theme switching
  selectors; it does not repeat an inline color palette. In classes mode,
  resolved token and theme rules from descriptor CSS are shared as well.
- All instances within one document adopt the same constructed stylesheet.
  CSS chunks and overlapping rules are deduplicated, and new rules reach
  existing roots. One tag definition uses one theme alias configuration;
  conflicting alias sets fail. Additional CSS must use that same theme mapping
  and compatible presentation rules. Rules last for the definition's lifetime,
  including unused rules from hot updates until a reload.
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
- The React `Code` macro returns an empty custom-element JSX host with
  `code-ref={codeRef}`. Module-level descriptors and HTML registration stay
  outside React props. Content-derived IDs share identical prepared results;
  the module registers once on its first default render. It uses no React
  HTML injection, hooks, portals, or hydration suppression. React owns the host; the element owns
  the highlighted shadow contents. Runtime `className` and `theme` apply to
  the host. Module-level styles reserve space from the build-known source line
  count and optional cap, including trailing blank lines; empty source reserves
  one line. Runtime `className`, `theme`, and `maxLines` apply to the host. Theme
  aliases are validated as CSS-safe identifiers at build time.
- `@ferriki/core/web-component/server` exports the framework-free
  `renderCodeElementShadows(markup, { blocks, stylesheetHref })` helper. It
  fills eligible empty reference hosts in complete, well-formed server HTML
  with Declarative Shadow DOM, a reference marker, and an optional link to
  one CSS asset. It skips manual/property hosts and inert contexts, rejects
  unknown eligible references, and is idempotent. This stage runs outside React.
- Register after the browser has parsed the DSD HTML. Upgrade reuses the root
  and retains nodes for a matching reference marker. React hydrates the empty
  light-DOM host. Marked CSS links are removed after that block is registered
  and the shared sheet adopted; unresolved blocks keep their links so partial
  registration preserves SSR styling. Class-mode CSS must be supplied with or
  before its blocks: ID registration signals style readiness. The generated
  Vite helper supplies both together. Without this server stage, reference
  hosts are empty before JavaScript. The direct property interface can still
  use escaped-attribute SSR and caller-supplied plain fallback children.
  Ordinary complete-page `renderToString` hydration is verified. Parser-time
  predefinition, streaming SSR, and React Server Components are outside the
  verified contract.
- Each transformed React module contributes its combined descriptor CSS to
  registration. Default-only React output requires no page CSS asset.
  `code()` and React calls with a declared `render` prop keep ordinary Vite CSS
  delivery and the unchanged HTML-backed descriptor. A runtime absent or
  `undefined` renderer selects the default; a callback's result is returned
  unchanged. Custom renderers do not reserve the tag unless they use it.
- The Vite plugin API exposes `renderCodeElements`, `codeElementBlocks`, and
  `codeElementCss` for already transformed React modules. Applications install
  their SSR HTML stage and shared CSS route explicitly. Production builds can
  save the registry and CSS for the standalone helper. Client and server
  preparation must use identical options for matching content-derived IDs.
- The browser HTML parser remains necessary inside the element. Source is
  escaped by Ferriki, while custom transformer markup is trusted caller code.
  Shadow DOM is not a sanitizer or security boundary. String sinks can be
  rejected by strict Trusted Types policies; no policy or `TrustedHTML` hook
  is provided. Inline token output still requires CSP permission for style
  attributes; classes output avoids token style attributes. Automatic SSR
  sizing uses host style attributes in both modes and needs the corresponding
  permission too. Shared constructed CSS replaces per-root style tags and
  per-block nonce handling.

## Consequences

- Consumers can use `<ferriki-code code-ref="…" />` directly in React 19 and
  register prepared HTML separately. The `highlightedCode` property remains
  available for direct string transport. There is no token-component output
  variant or React HTML injection in the default presentation. The browser
  runtime only presents prepared code.
- Shared CSS reduces repeated declarations. Reference SSR carries only IDs;
  DSD adds raw prepared HTML outside React and highlights before JavaScript.
  The default client module still carries prepared HTML for registration and
  updates. The registry can also be delivered separately by a consumer.
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

## History

- 2026-10-11: Accepts the Web Component as the single built-in React presentation,
  with reference registration, shared styles, line caps, and optional complete-HTML
  DSD. Preserves the HTML API and custom-render escape hatch; records measurement
  boundaries and the limits of CSS isolation.
