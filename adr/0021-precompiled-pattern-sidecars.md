# ADR 0021: Ship Optional Precompiled Pattern Sidecars

## Status

Accepted

Last updated: 2026-10-26

## Context

Standard grammars currently require regex compilation in every fresh registry.
Ferroni 2.5 introduced validated, lazily decoded program archives; 2.7 stabilizes
portable prepared Eager groups through `precompiled-eager`. Issue
[#325](https://github.com/sebastian-software/ferriki/issues/325) tracks moving
static compilation to asset generation. Rust consumers may resolve a newer
compatible Ferroni, so archived programs cannot be required for correctness.

## Decision

- `ferriki-textmate::precompile_grammar_patterns` prepares static patterns
  using the runtime's normalization, capture options and four anchor variants,
  for both prefilter settings. It visits nested rules, captures, repositories
  and injections. End/while patterns resolved from begin captures stay dynamic.
- `ferriki-asset-gen` writes a deterministic, checksummed Zstd level-19 `.fkbc`
  beside each `.fkgram`, matching Ferroni's transport choice. Its window is capped
  at 8 MiB and its decoded payload at 512 MiB. A fixed-width length header pairs
  the grammar scope, programs and portable Eager groups without postcard byte
  vector encoding or duplicate program indexing. Zstd adds a native C build
  dependency. Ferroni validates indexes on opening and requested records lazily.
- The release manifest pins the compressed bytes by SHA-256, size and
  `PRECOMPILED_PATTERNS_VERSION`, independently of the postcard asset version.
  Its 8/12/12-bit fields identify the container, program and Eager group formats,
  so a change to any component triggers regeneration.
  Objects reuse `<language-id>/<short-hash>` in the existing immutable CDN
  namespace; their complete digests distinguish bytecode from grammar data.
  The postcard grammar and catalog schemas stay at format 3.
  An additive `decoded` descriptor also pins the uncompressed container's
  SHA-256 and size. Node and Rust remote catalogs persist it on first load in
  the shared asset cache. A local verification receipt records the file's size
  and modification time. Fresh processes compare this state before and after
  reading and open unchanged
  bytes without repeating SHA-256, transport decompression or compressed-file
  verification. Changed/unrecorded files require SHA-256 before receipt renewal.
  The cache directory and its receipts are trusted local state, not a boundary
  against malicious local modification; engine validation remains unchanged.
  A derived, versioned local index records the offsets of every program and
  static group in the complete decoded container. Verified disk caches attach
  an open file and this small index instead of reading the full container.
  Scanner construction reads only its requested records into owned buffers,
  remaps the selected program IDs and rebinds a reduced portable pair. Ferroni
  checks this pair and validates its requested bytecode/instructions normally.
  This adapter interprets only the stable v2 program/v3 portable envelopes and
  their binding checksum; unsupported formats retain the owned-import path.
  Both cache files use size/mtime receipts; changed or missing indexes are
  rebuilt from the verified container. File state is checked before and after
  record reads, with source fallback on changes or I/O errors. No file mapping,
  unsafe code, archive pruning, new CDN objects or format migration is needed.
  Borrowed/owned imports, embedded assets, legacy manifests and unwritable
  caches retain their shared-allocation behavior through Ferroni 2.7.2.
  Old manifests remain supported. A damaged decoded entry is rebuilt from the
  verified compressed payload, and cache write failures remain optional.
- Catalog loading attaches the matching sidecar to the registry's pattern
  cache. Programs decode only on a cache miss. Prepared group sources are bound
  to the root grammar: Ferroni selects one group source per cache, so switching
  roots switches that source while retaining shared programs and decoded groups.
  Only explicitly requested roots download/open sidecars: each root pair already
  includes its dependencies. Off mode skips opening Eager archives, and the Node
  planner skips their download. Disposal releases archives and decoded programs. Runtime-resolved scanners keep their existing
  cache bypass ([ADR 0010](0010-mechanical-vscode-textmate-port.md)).
- Bytecode is optional. Missing downloads, integrity failures, unsupported
  versions, malformed archives and missing individual entries fall back to
  source compilation. Required grammar and theme failures still propagate.
  Offline caches and embedded catalogs may omit sidecars. If mixed source/decoded
  programs fail scanner assembly, retry the complete list from source; an optional
  archive must not turn source-valid patterns into a load error.
- Only trusted producers may supply bytecode: structural validation cannot
  prove that an executable program implements its claimed source pattern.
  Verified sources use the same release trust and digest boundary as grammars.
- Grammar updates regenerate sidecars with their payloads. Dependency and
  tokenizer changes also trigger the updater; a missing sidecar or changed
  bytecode format forces regeneration even when grammar sources are unchanged.
  Publication follows the existing append-only upload and review workflow.
- Standard sidecars contain programs and prepared Eager groups. The producer
  resolves the catalog's includes and external injections, then uses runtime
  scanner-list construction for every statically known rule and anchor variant.
  Pattern order, duplicates and end placement are preserved. Captured end/while
  expansions remain dynamic and keep their cache bypass.
- `SyncRegistry::precompile_patterns(scope, samples)` prepares all static lists
  when samples are empty; nonempty samples prepare only encountered lists.
  Attaching a pair selects Eager for that root when prefiltering is enabled;
  missing groups use ordinary Eager fallback. Off remains Off. Program and group
  types stay private behind stable `PrecompiledEager` APIs. The registry importer
  also retains ordinary raw-program archives and the existing `Into<Arc<[u8]>>`
  signature, raw format constant, export method and full-scanner preparation API.
- The objective is to reuse Eager preparation across fresh registries and
  processes, including successive builds and deployments. Generation performs
  reusable optimization once; a new consumer restores the prepared data instead
  of rebuilding those automata. A persistent digest-addressed asset cache also
  reuses the downloaded packages across processes.
- Acceptance compares startup with source Eager and execution with ordinary
  Eager. Restoration, validation and allocation remain expected startup costs.
  Source Off is a useful lower-cost reference, without requiring loading parity.
  Existing in-process scanner caches already reuse preparation across repeated
  highlights and edits; archives extend that reuse across process boundaries.
  Measure setup, first document and execution independently. The
  [diagnostic](../docs/benchmarks/precompiled-patterns/prepared-eager.md) shows
  lower startup cost than source Eager and comparable execution on the measured
  workloads. Network/file I/O and complete deployment builds remain outside its
  measured boundary.

## Consequences

Consumers download extra bytes for a language in exchange for less first-use
compilation. Compression and index loading still cost time. Indexed disk access
avoids reading unused records; shared owned imports avoid section copies.
Neither path eliminates runtime restoration.
Prepared instructions avoid rebuilding group automata;
per-pattern helpers, scratch and input-dependent search caches remain local.
Custom grammars continue to compile from source.

Keep the asset cache between builds to reuse both downloaded and decoded data.
Decoded files use more disk space than compressed downloads. Each new
process reads the local index, checks file state and restores requested records. Prepared
assets remain valid while their content and format are compatible; editing the
highlighted document does not require regenerating the grammar package.

`cargo test --test precompiled_assets` compares prepared and source-only
highlighting on all 20 curated fixtures and the 12 TIOBE fixtures in the standard
catalog, with both prefilter settings. It also covers unavailable, tampered,
malformed and incompatible sidecars. The other TIOBE grammars use the custom
grammar API and have no standard sidecars. The native compatibility gate remains
mandatory. A reproducible fresh-registry comparison is available through the
`ferriki-textmate` example `precompiled_startup`.

## Regex-mode isolation (October 25, 2026)

`regexMode` selects source Off, source Auto (lazy DFA), source Eager, or
Prepared. Prepared remains the default; the existing `regexPrefilter` option
keeps its behavior. Source policies skip standard sidecar planning and opening.
The Node options are mutually exclusive; Rust builder setters use the last
choice. `RegexMode` and `RegexDiagnostics` are owned, non-exhaustive tokenizer
extensions. Diagnostics count construction and actual archive-group decoding,
not search calls or complete archive coverage; ordinary missing-group fallback
is not an assembly-error retry.

The benchmark gives these policies separate contenders. Historical captures
are retained with their original meaning: the October 24 standard "on" lane
used prepared packages and is not a source-Auto regression baseline. New mode
reports record configuration and runtime diagnostic snapshots outside timers;
source contenders must not open archives. Comparisons preserve identical input
and output checks, with no merging of timings across corpus VMs.

## History

- 2026-10-26: Add indexed, on-demand reads from verified decoded containers.
  Preserve every static program/group on disk and let Ferroni validate reduced
  pairs; keep existing imports, source fallback and CDN formats unchanged.

- 2026-10-25: Require published Ferroni 2.7.2 and consume decoded containers
  through its shared byte views. Keep existing formats, cache verification,
  complete static coverage and source fallback; add no file mapping.

- 2026-10-25: Remove repeated SHA-256 from unchanged decoded-cache reads. Persist
  a verified file stamp and rehash only changed/unrecorded files; retain engine
  validation, optional fallback and complete static coverage.

- 2026-10-25: Require Ferroni 2.7.1 for portable prefilter efficiency fallback
  after the isolated runtime regression in upstream #465. Keep the existing
  archive format and downloaded packages; retain the dependency comparison in
  [the 2.7.1 evidence](../docs/benchmarks/precompiled-patterns/ferroni-2.7.1/README.md).

- 2026-10-25: Persist decoded containers with release-pinned identities, verify
  them once on actual use, and avoid the temporary whole-container Arc copy.
  Retain compressed transport and complete static coverage.

- 2026-10-25: Separate source Off/Auto/Eager from Prepared in configuration and
  benchmark contenders; retain default and legacy boolean behavior. Record
  policy and archive-use diagnostics without claiming complete coverage.

- 2026-10-24: Clarify acceptance as cheaper startup than source Eager with Eager
  execution and reusable packages across processes. Accept restoration overhead;
  retain source Off as a diagnostic reference rather than a parity requirement.

- 2026-10-24: Correct the objective to source-Off loading plus Eager execution.
  Replace the program-only default and gzip/postcard container with prepared
  static groups, Zstd transport and one matched-pair open. Earlier Auto and gzip
  diagnostics remain historical rather than policy evidence.

- 2026-10-24: Separate warm tokenizer execution from startup; retain the standard
  policy after two seven-grammar comparisons with actual group-load and active
  prefilter observations. Preserve raw samples and limit claims to that boundary.

- 2026-10-24: Adopt Ferroni 2.7's stable Eager pair API as an explicit Rust
  preparation path, version the bound container, and retain program-only CDN
  defaults after measuring larger/slower prepared C++ archives.

- 2026-10-24: Accepted. Move standard static regex compilation into optional,
  compressed, release-pinned sidecars using Ferroni's stable archive API (#325).
