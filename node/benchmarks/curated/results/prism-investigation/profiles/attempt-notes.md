# Profile capture notes

The first wrapper invocation failed before starting any worker: macOS has no
`/usr/bin/mkdir`, and the pnpm script wrapper forwarded an extra `--` to the
argument parser. No profiler started and no capture artifact was written by
that attempt. The corrected direct Node invocation was run from `node/`:

```sh
node scripts/capture-prism-profiles.mjs --seconds 8 --sample-seconds 6
```

It completed 17 serial jobs successfully: five Prism Inspector profiles, six
Ferriki facade Inspector profiles, and six Ferriki native `sample` reports.
The Prism Astro cell was recorded as unsupported because Prism 1.30.0 has no
Astro component. Every worker and native sampler exited successfully. The
capture window and machine context are recorded in `window-context.txt`; the
JSON index lists artifact hashes and workload/source identities.

The published profile artifacts use exact path redactions to remove the
checkout prefix, Cargo registry prefix, and local host name. Their retained
original and published SHA-256 pairs are in `../path-redactions.json`; local
originals are ignored and are not part of the pull request. Sample arrays,
native symbols, sample counts, timings, binary UUIDs, and fixture identities
remain unchanged.
