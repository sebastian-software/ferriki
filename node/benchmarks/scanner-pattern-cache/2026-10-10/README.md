# Scanner pattern cache evidence

This dated report compares Ferriki at `6521b1be906e5a2711cddb15164e3ed2bd4a9af8` with the issue #230 candidate at `19a363a20927ad52c5222daa16d86796056ce2ce`. Both builds use Ferroni 2.1.0, the same Cargo.lock fingerprint (`c0fc5ff0f9698b0c9571f2ade9a68b87ba46976f36f7e391e523504197cf0e33`), the same standard asset manifest, and the same curated fixture manifest. The candidate runtime/ADR diff from the baseline is SHA-256 `241f84426aa53ae23110cacacc59c1299fdd3f274f7ebf6db4bcfcfae2a516bb` (26,437 bytes); the raw JSON includes both native build receipts and the Rust source hash.

## Results

The table reports medians across nine fresh-process samples per language and revision. First use measures native addon require through first HTML output. Warm HTML reports the median of 30 calls after five warmups in each worker.

| Language   | First HTML, base | First HTML, candidate | Change | Warm HTML, base | Warm HTML, candidate |
| ---------- | ---------------: | --------------------: | -----: | --------------: | -------------------: |
| C++        |        417.95 ms |             407.98 ms |  −2.4% |        0.561 ms |             0.574 ms |
| TypeScript |        142.50 ms |              40.85 ms | −71.3% |        0.501 ms |             0.492 ms |
| TSX        |        120.53 ms |              36.67 ms | −69.6% |        0.576 ms |             0.556 ms |
| JSON       |          3.57 ms |               3.48 ms |  −2.6% |        0.219 ms |             0.219 ms |
| Astro      |        209.65 ms |              78.70 ms | −62.5% |        1.161 ms |             1.162 ms |

Warm HTML medians remain within 3.4% across these samples. This change primarily reduces repeated pattern compilation during grammar setup; it does not materially change the measured warmed render path in this fixture set.

Five paired fresh-process memory runs each created one highlighter/registry and loaded/highlighted all five grammars. The median RSS snapshot after the fifth grammar was 102.4 MiB for base and 67.6 MiB for the candidate. Median Node `external` memory at that checkpoint was 2.43 MiB for both. These are coarse whole-process snapshots after GC where available, not cache-allocation measurements or peak-memory proof. RSS can fluctuate between checkpoints; the raw JSON preserves every observation.

Ferroni's current cache API applies to the full pattern list passed to one scanner; it does not let Ferriki cache only the static members of a mixed list. To bound resolved end/while backreferences, Ferriki bypasses shared caching for the entire scanner list when any member contains a backreference. This also skips reuse of any static members in that list and is a candidate Ferroni API follow-up. C++'s near-flat first-use result is consistent with this limitation, but these measurements do not isolate its cause.

All base and candidate HTML SHA-256 values match for each fixture across the timed and memory samples. Fixture bytes, the manifest, and the standard asset manifest were also checked for equality before measurement.

## Method and provenance

- Host: Apple M1 Ultra, 20 logical CPUs, macOS arm64; Node.js v24.21.0.
- Nine serial rounds cover C++, TypeScript, TSX, JSON, and Astro. Base/candidate order alternates by round and language.
- Each timed worker is a fresh process. The first-use timer starts before native addon require and stops after first HTML. Fixture reads and process startup are outside the timer.
- Each timed worker makes five warmup calls followed by 30 individually timed warm HTML calls. Output hashes must remain equal to first use.
- Five additional paired rounds use a fresh process per revision, load one theme and the five grammars in fixed order, and record process RSS, V8 heap, and external-memory snapshots.
- Native addon hashes: base `e7d8f43a405966627e6f7dbafd3777d082f3e4afe59ebc29f166df692bc62b15`; candidate `70481219b25aa0117c2e5e4d0abe17c4cb44c9563749aefdf3e608d25522cae3`.
- Fixture manifest SHA-256: `4c0c2f8bfa535d7f6fc3397a0585e3e6d66c1509d5341d7022ced20303cd175e`; standard asset manifest SHA-256: `30ca207f07ee8616369ffb8e5c6456195abca74d56de6a106a87cf99cd83debf`.
- The complete per-sample measurements and receipts are in [`results.json`](results.json). The exact pre-format capture is preserved as [`results.raw.json.gz`](results.raw.json.gz); its uncompressed SHA-256 is `f56ab1c770367aa536dd0aed7853e03020f121615ad3634775a0feb7f367df86`. The harness is [`measure.mjs`](measure.mjs).

These results describe one local host and these five fixtures; they are not a cross-platform benchmark or a claim about every grammar. No Ferroni microbenchmark result is reused here. The Ferroni guide/API follow-up remains outside this Ferriki change.
