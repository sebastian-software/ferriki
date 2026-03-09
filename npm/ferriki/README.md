# ferriki

Canonical Node package location for Ferriki.

Phase 1 status:

- this package is the new top-level npm entrypoint target
- its runtime imports resolve from the local `dist` bundle
- native builds go directly against `crates/ferriki-core`

The intent is to converge on:

- `npm/ferriki` as the only npm package
- `crates/ferriki-core` as the runtime behind it
- `crates/ferroni` as the regex engine dependency
