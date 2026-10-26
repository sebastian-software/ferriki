# Cooperating language package sizes

The generator now delegates identical foreign scanners to the language that
defines them. Host-specific combinations stay local. This changes package
contents and downloads, independently of the earlier indexed-reader improvement.
See [ADR 0022](../../../../adr/0022-cooperating-prepared-language-packages.md).

## Measured downloads

Both columns use the same 94 grammar packages, theme data and Ferroni 2.7.2.
They preserve full static preparation across cooperating packages. All grammar
and theme descriptors are identical. Sizes below are compressed `.fkbc` payloads,
in decimal MB; they exclude HTTP headers, grammar/theme files and cache indexes.

| Package | Complete root package | Cooperating package | Reduction |
| --- | ---: | ---: | ---: |
| Markdown | 25.907 MB | 1.908 MB | 92.6% |
| Astro | 6.474 MB | 0.521 MB | 92.0% |
| HTML | 3.378 MB | 0.438 MB | 87.0% |
| TypeScript | 3.364 MB | 0.752 MB | 77.6% |
| JavaScript | 3.327 MB | 0.768 MB | 76.9% |
| All 94 packages | 274.444 MB | 35.349 MB | 87.1% |

The complete decoded catalog falls from 3,464,972,600 to 550,919,667 bytes.
This is disk-cache data size, not a process-memory target or a measured RSS claim.
Small intrinsic-only packages can remain the same size; the container marker
also changes their digests. These figures do not describe startup or execution
speed. Different hosts can still need different combined scanners.

Markdown alone does not download all optional code-fence languages. When Rust
is explicitly registered, Markdown reuses its package. Required dependencies,
such as those of Vue, load their own packages. Multiple host grammars reuse those
downloads. The total row counts each catalog package once; it is not a claim that
every application downloads the entire catalog.

## Construction and validation

`SyncRegistry::precompile_pattern_packages` collects intrinsic signatures first,
then prepares and filters one complete host at a time. Delegation requires equal
ordered serialized program keys and equal portable record bytes. Root-owned
groups never delegate; unmatched foreign contexts stay local. Retain every own
static program in both prefilter settings and all programs needed by local groups.

An independent implementation that first compressed the expanded packages
produced the same complete release descriptor set as the final implementation,
which avoids that intermediate compression. `node scripts/publish-assets.mjs
--check` verifies the resulting 506 immutable source/payload objects against the
reviewed lock. New objects use container version 3; complete version-2 imports
remain supported.

The Rust tests compare full and delegated token output and actual group loading
for host-dependent `$base` rules, both memory imports and indexed files. The
standard curated/TIOBE fixture comparison and mandatory native compatibility
gate pass with the generated catalog. Source Off/Auto/Eager remain separate
policies. Required and optional dependency planning have distinct checks.

## Retained evidence

`before-release.json.gz` and `after-release.json.gz` preserve the complete release
manifests as deterministic gzip wrappers. `sizes.json` contains every before/after
descriptor and exact totals. SHA-256 digests authenticate the original compressed
and decoded payloads. Historical timing captures remain unchanged; these new size
figures must not be presented as an update to their timing results.
