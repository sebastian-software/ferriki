# ADR 0022: Delegate Prepared Scanners to Their Language Packages

## Status

Accepted

Last updated: 2026-10-26

## Context

The complete root packages in [ADR 0021](0021-precompiled-pattern-sidecars.md)
repeat prepared scanners for embedded languages. Markdown carries preparation
for optional code-fence languages even when an application never registers them.
Astro and HTML also repeat their dependencies' scanners. The
[record comparison](../docs/benchmarks/precompiled-patterns/indexed-cache-2026-10-26/README.md#identical-data-across-language-packages)
found 218 MiB of identical Markdown group records in dependency packages.

Indexed reads reduce process I/O but cannot reduce compressed downloads.
Removing grammar features or sampling documents reduces coverage. Blindly
assigning every foreign rule to its defining language also loses prepared
coverage: `$base`, injections and host end patterns can change ordered lists.

## Decision

- Generate cooperating language packages. Keep intrinsic scanners and
  host-specific combinations locally. Delegate a foreign group only when the
  defining language's intrinsic package contains identical ordered serialized
  program keys and portable record bytes. Compile settings, environment,
  duplicates and order participate in the comparison.
- Record origin from the port's existing rule source scope. Prefer a root's
  intrinsic rule when the same list also occurs in an included grammar.
  Intrinsic groups never delegate, so package cycles do not create recursive
  record references without a concrete owner.
- Retain the source grammar's own static programs in both prefilter settings,
  plus programs needed by retained groups. Mixed scanners can still need
  foreign programs locally. This does not promise global deduplication of every
  byte or change Ferroni's group representation.
- `SyncRegistry::precompile_pattern_packages` first collects compact intrinsic
  signatures, then prepares and filters one complete host at a time. Do not
  retain every expanded host or compress data that will be omitted. Existing
  standalone and sample-based preparation APIs remain available.
- Mark cooperating containers with `FKBC003` and container version 3; retain
  the program/group envelope layout. Accept complete `FKBC002` version-2
  packages with matching engine formats. Raw imports remain unchanged.
  Release digests identify new objects; publish them append-only.
- Plan packages for requested languages and required registered dependencies.
  Optional languages stay optional: Markdown alone does not download Rust;
  explicitly registering Rust makes its package available to Markdown. Legacy
  complete roots retain root-only sidecar planning.
- Prefer a matching host group, then the defining language's group. This
  preserves host-dependent `$base` cases for indexed files and owned imports.
  Keep shared compiled programs, decoded groups, ordinary Eager fallback and
  dynamic-capture bypass.
- Preserve Source Off/Auto/Eager. Missing packages, incompatible formats and
  invalid records remain optional optimizations with source fallback.

## Consequences

The generated catalog's compressed prepared payloads fall from about 274 MB to
35 MB. Markdown falls from 25.9 MB to 1.9 MB, Astro from 6.5 MB to 0.52 MB and HTML
from 3.4 MB to 0.44 MB. Grammars and themes are byte-identical. Exact identities
and sizes belong to the reviewed catalog and measurement evidence.

Applications reuse one language package across hosts. Required dependency
packages now open separately, so archive counts can exceed requested root
counts. This does not load the entire catalog. Indexes keep restoration
demand-driven. Combined scanners and intrinsic shared syntax can still duplicate
data; further deduplication requires separate evidence.

Tests compare full and delegated output and actual prepared-group loads,
including host-dependent `$base`, later contexts, memory and indexed files.
Planner tests cover required dependencies, optional fences and legacy roots.
The native compatibility gate and standard fixture comparisons remain required.

## History

- 2026-10-26: Accepted. Delegate identical foreign scanners while retaining
  intrinsic owners, host contexts, optional languages and legacy reads.
