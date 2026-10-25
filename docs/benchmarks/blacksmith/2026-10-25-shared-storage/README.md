# Shared prepared-archive loading on Blacksmith

Measured October 25, 2026 at `0477eed2bd6f7a7e3fdf148937fd6dde42e7b3d8` in
[the successful workflow](https://github.com/sebastian-software/ferriki/actions/runs/40235606997).
All six timing jobs and both evidence merges passed. Every native build uses registry
Ferroni 2.7.2.

The standard loader consumes each decoded container and retains shared program/group
views. It combines the size/mtime cache from #334 with the owned importer from #336.
Source Off, source Auto, source Eager, Prepared, Shiki WASM, Shiki JS and Prism retain
their existing identities and output gates. Only requested roots and dependencies load.

## Repository results

Milliseconds; lower is faster. Reused values sum per-document medians for the same
fourteen-file corpus on one VM. First use includes imports, highlighter setup and a
complete first render in ten fresh processes. The decoded cache is populated before
timing. Downloads, first cache fill and process creation are excluded.

| Host / phase | Source Off | Source Auto | Source Eager | Prepared | Shiki WASM |
| --- | ---: | ---: | ---: | ---: | ---: |
| Linux x86-64 / reused | 120.028 | 84.023 | 84.410 | 79.956 | 297.829 |
| Linux x86-64 / first use | 215.555 | 357.030 | 446.017 | 469.832 | 947.019 |
| macOS ARM64 / reused | 121.731 | 82.331 | 82.833 | 78.525 | 338.214 |
| macOS ARM64 / first use | 242.731 | 369.427 | 452.502 | 277.198 | 1224.893 |

Prepared first use is **38.7% lower than source Eager on macOS** and **5.3% higher on
Linux** in this capture. Source Off still starts faster on both profiles. Reused
Prepared rendering is about **5% faster than source Eager**, and **3.7× / 4.3× faster
than Shiki WASM** on Linux/macOS. First use is **2.0× / 4.4× faster than Shiki WASM**.
These describe this corpus and these VMs, not total build time or universal speedups.

Shiki JS remains unsupported for the complete corpus because of its YAML conversion
limit. Supported native/Shiki cases pass exact HTML agreement, actual prepared-group use
and zero invalid groups or assembly-error fallbacks. Prism uses independent grammars.
The full timing corpus retains SQL; no new SQL investigation is included.

## Historical comparison

The [previous decoded-cache capture](../2026-10-25-decoded-cache/README.md) used Ferroni
2.7.0, before its portable-prefilter fix, file-state verification reuse and
shared-container imports. Its tables and raw samples remain unchanged. Prepared first
use is 954.952 → 469.832 ms on Linux and 501.929 → 277.198 ms on macOS across these
captures. Those differences do not isolate one optimization.

The controls also move: Linux source Eager first use is 558.463 → 446.017 ms and Shiki
WASM is 1170.832 → 947.019 ms; macOS source Eager is 404.824 → 452.502 ms and Shiki WASM
is 1102.931 → 1224.893 ms. These are different VMs, even where CPU model names agree.
The repository corpus reads current source: `src/highlighter.rs` changes from 59,032 to
59,026 bytes and `Cargo.toml` retains 4,951 bytes with a new Ferroni requirement. The
other twelve repository input hashes and all 156 curated/TIOBE input hashes across both
profiles match the previous capture.

These measurements do not establish a source-path regression against a released version.
The [controlled local comparison](../../precompiled-patterns/shared-storage/README.md)
retains frozen inputs and separates the API, copying importer and safe owned importer.
Its noisy first capture and dedicated replication remain separate.

## Evidence and website

Each profile retains all thirteen original merged files: raw reports, machine/build
contexts, process logs, validation, summary and SHA-256 records. Reports and logs are losslessly gzipped; the original checksums refer to uncompressed bytes. Each
corpus has its own VM; no timing aggregate crosses corpus VMs. Every context records
registry Ferroni 2.7.2, Shiki 4.5.0 and Prism 1.30.0.

The website timing overview and all 156 curated/TIOBE language/size rows now use this
capture. Historical memory tables retain their original workflow and labels. No new
memory measurement or memory target is implied.

Run `node scripts/publish-decoded-cache-evidence.mjs --check` to validate original
checksums, complete output gates, version/source provenance and generated timings. The
homepage build runs this check. Repeat the workflow with suite `timings` and platform
`both`.
