# Security Policy

## Supported versions

Security fixes are provided for the latest release on the default branch. Older
releases are not patched separately — upgrade to the latest version to receive a
fix.

## Reporting a vulnerability

Report suspected vulnerabilities privately. Do not open a public issue, pull
request, or discussion for a vulnerability that has not been fixed yet.

Two private channels are available:

- **GitHub private vulnerability reporting** — open this repository's
  **Security** tab and choose **Report a vulnerability**.
- **Email** — security@sebastian-software.de.

Include a concise description, the affected version or commit, reproduction
steps, the impact you expect, and any suggested fix. Leave out credentials and
data you are not allowed to share.

## Response expectations

Maintainers aim to:

- Acknowledge a private report within 7 days.
- Assess severity and affected versions within 14 days.
- Coordinate a fix and a disclosure timeline with the reporter.
- Credit the reporter when desired and appropriate.

Timing can vary for low-impact reports and for reports that depend on a fix in
an upstream dependency.

## Scope

In scope: anything in this repository that lets someone read, modify, or execute
something they should not — including the released artifacts and the build and
release automation.

Usually out of scope: reports without a concrete impact path, vulnerabilities in
third-party dependencies used as documented, and problems that require an
already-compromised machine or a deliberately corrupted local state.

## Runtime trust boundaries

Ferriki separates untrusted source text from trusted application configuration
and local host state:

- **Untrusted source text:** Code passed to highlighters is treated as untrusted
  input. Ferriki HTML-escapes token text and attribute values, bounds state
  stacks, and supports per-line time budgets (`time_limit_millis` in Rust /
  `tokenizeTimeLimit` in Node) and line-length caps (`max_line_length` in Rust /
  `tokenizeMaxLineLength` in Node, measured in UTF-16 code units; lines that
  reach `>=` the limit fall back to plain text). Per-line time budgets are
  best-effort checks between tokenizer passes rather than preemptive regex
  interrupts. Public Rust HTML convenience methods (`highlight_to_html`,
  `highlight_html_lines`, `highlight_html_with_css`) use default tokenizer
  options; tokenize with explicit `TokenizeOptions` and render separately when
  custom limits are needed.
- **Custom grammars and themes:** Runtime-registered grammars and themes are
  treated as semi-trusted configuration, not sandboxed untrusted plugins.
  Ferriki enforces nesting-depth and state-snapshot size limits and exposes
  advisory regex warnings via `backtracking_warnings`, but callers should not
  compile arbitrary untrusted TextMate grammars without external process or
  timeout isolation, and must not splice unescaped external metadata into
  generated HTML (see [Rust API](docs/rust-api.md)).
- **Standard assets and `.fkbc` sidecars:** Remote downloads and
  `from_release_manifest` sources verify `.fkgram`, `.fktheme`, and `.fkbc`
  payloads against release-pinned SHA-256 digests and byte sizes before
  decoding (`from_release_manifest` verifies against the caller-supplied
  manifest, assuming the caller trusts it; warm `.fkbc` loads can reuse a
  decoded container and its index via trusted local size/mtime receipts without
  re-hashing the container — see [ADR 0013](adr/0013-cdn-loaded-standard-assets.md),
  [ADR 0021](adr/0021-precompiled-pattern-sidecars.md), and
  [asset loading](docs/asset-loading.md)). Filename-based local and embedded
  constructors (`load_from_root`, `from_embedded`) validate asset filenames,
  binary format versions, and decoded structure without verifying release
  digests, and assume trusted application-owned files.
- **Transformers, decorations, and Shadow DOM sinks:** Built-in declarative
  decorations are validated and serialized in both the native pipeline and the
  JS HAST pipeline, including class mode
  ([ADR 0008](adr/0008-transformers-and-decorations-stay-in-js.md)). Custom
  JavaScript Shiki transformers run in the host JS runtime and can mutate HAST
  or HTML directly. Callers mounting Shadow DOM code elements or assigning
  rendered markup to raw HTML sinks
  ([ADR 0019](adr/0019-shadow-dom-code-elements.md),
  [Shadow DOM code elements](docs/shadow-code-elements.md)) are responsible for
  ensuring the final HTML — including any transformer callback output — is
  trusted or sanitized.
- **Local asset cache (`FERRIKI_CACHE_DIR`):** Downloads are verified on cache
  fill, and decoded prepared containers use `.verified` size/mtime receipts to
  detect ordinary changes across warm restarts. The local cache directory is
  inside the process trust boundary and is not authenticated against a local
  attacker with write access to `FERRIKI_CACHE_DIR`. Isolate and permission the
  cache directory per trust boundary as documented in
  [cache maintenance and permissions](docs/asset-loading.md#cache-maintenance-and-permissions).
