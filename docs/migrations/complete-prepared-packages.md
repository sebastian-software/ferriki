# Complete prepared package cutoff

On October 26, 2026, the 94 complete version-2 prepared packages are retired
from Bunny Storage in favor of the cooperating version-3 language packages
in [ADR 0022](../../adr/0022-cooperating-prepared-language-packages.md).
The retired payloads total 274,444,043 bytes; their replacements total
35,349,207 bytes. This is a deliberate pre-adoption cutoff, including the
optional prepared sidecars referenced by Ferriki 1.2.0. It does not establish
an automatic retention limit for future releases.

Grammar, theme, original-source, and normalized-source objects remain
available. Existing local prepared caches remain usable. A 1.2.0 application
that cannot download an old optional sidecar falls back to source preparation.
The version-2 import API remains supported for directory and custom mirrors.
Repository materialization or historical release verification that requires
every old payload is no longer supported by the public CDN.

`scripts/retire-prepared-assets.mjs` derives the exact old paths from the
SHA-256-pinned before-manifest retained in the package-sharing evidence. It
requires a distinct version-3 replacement for every candidate and rejects
paths used by any current source or payload. The fixed scope is 94 objects;
it never lists or recursively deletes directories.

Run `node scripts/retire-prepared-assets.mjs --check` to inspect the paths
without credentials or network access. The manual `Publish` workflow with
`assets-only=true` and `retire-complete-prepared-assets=true` first publishes
and verifies the new catalog. Retirement then verifies every replacement and
every present old object's exact bytes before any DELETE, confirms origin
404s afterward, and rechecks the current public CDN objects. Reruns accept
already absent old objects. Ordinary publication never enables retirement.

Origin deletion does not invalidate copies already cached at CDN edges.
Purge the retired URLs or the `ferriki-assets` pull-zone cache after removal.
Do not republish a historical complete-package catalog: that would upload
the retired objects again.
