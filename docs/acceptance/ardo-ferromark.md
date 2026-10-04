# Ardo and Ferromark production acceptance

This acceptance, dated 2026-10-04, validates [Ferriki #14](https://github.com/sebastian-software/ferriki/issues/14) with published Ardo 5.0.0, Ferromark 3.1.0 and Core 0.10.0. Frozen installation, production verification, browser theme checks and a complete runtime/lock rollback passed. Measurements show a slower whole-site build and lower reported maximum RSS on this corpus; they do not isolate highlighter performance.

## Published packages

[Ferromark 3.1.0](https://github.com/sebastian-software/ferromark/releases/tag/v3.1.0) is published to npm with seven native sidecars, and both Rust crates are published. [Integration #502](https://github.com/sebastian-software/ferromark/pull/502) passed all 31 checks. Release #501 and workflow fixes #506/#508 each passed all 30 checks. The [exact-tag retry](https://github.com/sebastian-software/ferromark/actions/runs/37159413129) completed successfully, including native builds, Rust publication, exact-version npm retry handling and registry verification.

[Ardo 5.0.0](https://github.com/sebastian-software/ardo/releases/tag/ardo-v5.0.0) and [create-ardo 5.0.0](https://github.com/sebastian-software/ardo/releases/tag/create-ardo-v5.0.0) are published to npm. [Integration #322](https://github.com/sebastian-software/ardo/pull/322) and release #306 passed all four checks. Both publish workflows succeeded: [Ardo](https://github.com/sebastian-software/ardo/actions/runs/37161074865) and [create-ardo](https://github.com/sebastian-software/ardo/actions/runs/37161076113).

The candidate lock resolves `ardo@5.0.0`, `ferromark@3.1.0` and `@ferriki/core@0.10.0` from the registry with real SHA-512 integrity values. No local packages or invented resolutions are used. Ardo's registry metadata and npm-publish/SLSA subjects match the expected tarball, repository, source commit, tag and workflow; this is metadata consistency, not cryptographic signature verification. A separate `npm audit signatures --json --include-attestations` verified registry signatures and npm-publish/SLSA attestations for the four installed Ferromark/Core packages and Darwin arm64 sidecars, with no invalid or missing entries. Other platform sidecars were checked through registry integrity and attestation metadata without individual installation or cryptographic verification on this host.

The separate Ardo Pages failure is tracked in [Ardo #323](https://github.com/sebastian-software/ardo/issues/323): missing v3/v4 snapshots stop artifact preparation before deployment. It does not invalidate the successful npm releases.

## Source and production verification

Both comparison lanes use source commit `676b8e953e6597a337fc644e712a4a30e5b8bea5`, tree `126e110671d3e6fe1fbc2a41d8c7ec44498bb358`, and four-fence corpus SHA-256 `be71440bb815f448cacd039ff2909139f6b2099b7036d82fc321105122a00d04`.

The baseline changes only the homepage manifest's Ardo dependency to `^4.2.0`, retaining main's lock SHA-256 `1e00152c77342c2f6a41b77fc58f5d9a779bb63d79b91d6bb1f3d31b7a393a96`. The candidate changes only the registry lock, SHA-256 `669fd6b58290df50bc4c75b484f552cf994f35fd69976f91ff0ab24a47053c11`. That exact runtime and lock are committed at `1224a2dc3997e3666d69f66d3e0184de1da2c72a`, tree `4e735ae0b94674b1e7af158763671054a0282fb2`; all its workflows passed, including the [Linux homepage build](https://github.com/sebastian-software/ferriki/actions/runs/37164218538) and [complete CI](https://github.com/sebastian-software/ferriki/actions/runs/37164218492).

The candidate passes `pnpm install --frozen-lockfile` and full `pnpm run verify`: samples, lint, typecheck, formatting, production build, existing benchmark provenance and 10 pages/275 internal links and fragments. Browser verification passes axe's WCAG 2.1 A/AA rules on all 10 pages at desktop (1440px), phone (390px) and landscape (844px), plus mobile-menu keyboard navigation and focus return. SSR checks preserve focusable Markdown tables and code blocks through the component provider after the old rehype hook was removed.

The baseline passes the same sample, lint, type, format, underlying build and browser checks. Its original verifier fails specifically at the new native-output title assertion. A second pass omits only that assertion, retains all existing provenance/link/page gates and the new table/pre focus checks, and immediately restores the verifier bytes. The measurement command excludes these separate correctness checks in both lanes.

For a fresh checkout, build the local native addon through the repository setup before running the homepage's frozen installation and full verification.

## Output and failure review

The fixed production corpus covers TypeScript, TSX, HTML with embedded CSS/JavaScript, unknown-language fallback, escaping, titles/labels, line numbers and highlighted lines. Both outputs match all four source samples. The native output retains highlights at TypeScript line 2, TSX line 3 and HTML lines 3/7. The unknown fence stays escaped plain text with no token styling and gains a visible title.

The HTML is intentionally different. Native supported-language output preserves the terminal LF, adding one empty numbered line (4, 5 and 9); Ardo 4.2 omitted it. Token-span counts change from 17/31/28 to 22/39/30, while light/dark token color pairs remain equivalent. Native classes and metadata attributes also differ. Acceptance checks source text, styling, metadata and annotations rather than byte identity.

Separate browser checks confirm computed native TypeScript colors `#CF222E` in light mode and `#FF7B72` in dark mode, visible line numbers, a visible 3px highlight border and all four titles. The light highlight fill uses 3% brand color to pass contrast checks without changing token colors; dark fill remains unchanged. The corresponding screenshots were inspected.

A published Ferromark 3.1/Core 0.10 smoke test starts with an empty local cache and remote assets disabled. It reports the actual `GenericFailure` for a missing GitHub light-theme asset. A new `JsxCompiler` with `assets.remote=true` in the same process and cache then fetches seven release-pinned CDN assets and passes the four-fence checks. Every downloaded payload matches the published Core manifest by SHA-256 and size. Unknown-language fallback reports `ShikiError` through `onHighlightError`. This is asset-failure recovery evidence, not cold-CDN performance.

## Build time and memory

The host is an Apple M1 Ultra (20 logical CPUs), macOS 27.0 arm64, Node 24.21.0 and pnpm 10.34.5. Both lanes inherit `NODE_OPTIONS="--max-old-space-size=16384 --no-deprecation"` and use the same installed pnpm store. Exact direct dependency versions match except for Ardo; 156 transitive package-version differences are recorded in the evidence.

Five serial alternating warm pairs follow one unmeasured warm-up per lane. Each lane has a separate identical manifest-verified cache: 325 payloads, 9,006,563 bytes, remote assets disabled. Only `homepage/build` is removed between invocations; dependencies, store and asset caches remain installed. The timed command from each `homepage/` directory is:

```sh
/usr/bin/time -l -o <sample>/time.txt pnpm exec react-router build
```

Installation, semantic validation and browser checks are outside the timer. Every build exits successfully and retains all 11 HTML outputs (ten pages and the SPA fallback); independent review verifies the archived bytes against their hashes. All ten measured native compatibility outputs also pass the native-output assertions after timing.

Values are median (min–max; median absolute deviation). RSS is converted from the macOS timer's bytes to MiB. This is its reported maximum resident set size, not aggregate simultaneous memory of all child processes or isolated native allocations.

| Series | Elapsed seconds | Maximum RSS MiB |
| --- | --- | --- |
| Warm Ardo 4.2.0 | 7.87 (7.65–8.01; MAD 0.14) | 1610.55 (1428.38–1637.58; MAD 27.03) |
| Warm Ardo 5.0.0 native path | 9.90 (9.82–9.94; MAD 0.02) | 1275.38 (1266.16–1318.88; MAD 9.22) |
| Native empty local cache | 10.24 (10.18–11.70; MAD 0.05) | 1295.22 (1276.55–1341.52; MAD 18.67) |

The warm native median is 25.8% slower and its reported maximum RSS median is 20.8% lower in this series. No speed threshold or causal renderer claim is used. Whole-build profiling is tracked in [Ardo #324](https://github.com/sebastian-software/ardo/issues/324).

The five first-use native builds each start with a new empty local asset cache, remote loading enabled and `FERRIKI_ASSETS_BASE_URL=https://assets.ferriki.dev`. Each receives ten identical manifest-verified payloads (673,795 bytes). This series has no baseline comparison and does not represent a cold CDN, network, host, page cache, dependency install or pnpm store. The 11.70-second first sample is retained.

For reproduction, use two checkouts at the common source above. Keep the baseline main lock and set only its Ardo dependency to `^4.2.0`; copy the real candidate lock from `1224a2dc` into the candidate. Complete frozen installs and separate correctness checks first. For warm caches, verify every `assets/shiki/release-manifest.json` payload's digest and size, then copy its bytes into each cache under its SHA-256 filename. Set `FERRIKI_CACHE_DIR` to the respective cache and `FERRIKI_ASSETS_REMOTE=0`; perform the warm-ups and five alternating pairs. For first use, assign a new empty cache to each native build and enable remote assets. Preserve every raw timer/log and HTML output, and summarize all five samples per measured lane.

The final provider path-normalization fix was added after this series. Its paths are identical on the measured macOS host; it preserves the self-import exemption on Windows, where Vite normalizes separators. The measurement source remains the explicit common-source commit above.

## Rollback

The complete runtime/registry-lock input at `1224a2dc` was reversed in a fresh clone. Its proposed index matched that commit's exact tree `4e735ae0b94674b1e7af158763671054a0282fb2`. Reversing all migration paths, including the actual new lock, ADR, providers, CSS, fixture and verifier, restored main commit `e0e05c8f378e5afffa95159a6125c11044aae163` and exact tree `9c3be58e1ed76fd62f35494faa1a6f8eece2506e`. Both index and worktree matched that tree, with no nonignored untracked files.

The restored lock has the baseline hash above and installs Ardo 4.2.0 with frozen installation. The native build and normal `pnpm run build` pass: ten pages, 274 internal links/fragments and the existing benchmark provenance gates. The original receipt retains the initial sandbox-only loopback permission failure and successful rerun of the same command.

For rollback, revert the complete adoption PR, including final acceptance documents and path normalization. Restore both manifest and matching lock; downgrading only Ardo while retaining native-output assertions is incomplete. Build the local native addon through the repository setup, then run the restored homepage's frozen installation and normal build.

## Retained evidence

[ardo-ferromark.json](ardo-ferromark.json) stores source/lock/corpus identities, runtime, dependency differences, hashed correctness/theme/HTML/rollback receipts, every raw timer including warm-ups, archived HTML hashes and summaries. Full build logs, HTML archives, screenshots and original receipts are retained with the dated local runs. The JSON preserves the measured values without publishing private host paths.
