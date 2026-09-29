# ADR 0015: Encode Binary Assets With Postcard, Format Version First

## Status

Accepted

Last updated: 2026-09-30

## Context

The standard grammars and themes are stored as binary `.fkgram` and `.fktheme`
payloads with a `.fkindex` manifest per catalog
([ADR 0006](0006-lazy-shiki-asset-loading.md)). The format is internal and
versioned by `FORMAT_VERSION`; a runtime must never decode a payload written
for another version ([ADR 0012](0012-publishable-rust-highlighter.md),
[ADR 0013](0013-cdn-loaded-standard-assets.md)).

Format 2 used `bincode` 1.x. RustSec lists it as unmaintained
(RUSTSEC-2025-0141), and it sat in the published dependency graph of `ferriki`,
so downstream crates such as Ferromark failed their `cargo deny` gate unless
they added an exception for our dependency. With bincode, a file from another
format version also failed somewhere inside its payload instead of with a clear
version error.

## Decision

- Assets and manifests are encoded with `postcard` 1.x through serde. Its wire
  format is documented and stable within 1.x: unsigned integers and lengths are
  LEB128 varints, strings are length-prefixed UTF-8, and `Option` is a `0`/`1`
  tag followed by the value.
- Every encoded value starts with its `format_version`. The decoder reads that
  varint first and rejects another version with
  `unsupported asset format version N` before it decodes the payload. A format
  2 file starts with the same leading byte and is reported the same way.
- Bytes left over after the encoded value are an error.
- Any change to a schema struct's fields, their order or their meaning bumps
  `FORMAT_VERSION`; the generator, the Rust decoder and the manifest reader in
  `scripts/generate-ferriki-catalog.mjs` change together, and the assets are
  regenerated.
- The format stays internal, not a public interchange format.
  [`docs/asset-format.md`](../docs/asset-format.md) documents the details.

## Considered options

- **`bincode` 2.x**: the advisory covers every bincode version, so it does not
  remove the finding.
- **`wincode` or `bitcode`**: listed as alternatives by the advisory, but
  younger, with less settled wire formats than postcard's documented 1.x
  format.
- **JSON or CBOR**: self-describing and easy to inspect, but larger and slower
  to decode. The payloads already embed grammar JSON, and a release manifest
  in JSON covers the part that humans and tools need to read.
- **`rkyv`**: zero-copy decoding, but its own derive model and alignment
  rules would add complexity the lazy, cached decoding does not need.

## Consequences

- `ferriki` no longer carries an unmaintained dependency, and `deny.toml` needs
  no advisory exception for it.
- Format 3 replaced format 2 in 0.6.0; older asset files fail with a version
  error and must be regenerated. Language payloads shrank slightly
  (8.08 → 8.03 MB).
- The Node catalog generator depends on the postcard wire format and has to
  follow every schema change.
- Reordering struct fields is a format change, even when no field is added or
  removed.

## History

- 2026-09-30: Accepted. Format 3, shipped in 0.6.0 (#135, #159).
