# Legacy CDN cutoff

On October 16, 2026, `assets.ferriki.dev` retired the commit-based
`/<commit>/assets/shiki/<path>` route and its GitHub origin (#267). The cutoff
was moved ahead of the in-progress Ferriki 1.1.0 publication. There is no
extended compatibility window.

The public CDN supports only immutable Storage objects:

- `/<language-id>/<8-character-Base62-hash>`
- `/themes/<theme-id>/<8-character-Base62-hash>`

Ferriki 1.0.0 and older releases can no longer download missing standard
grammars or themes from the default CDN. Already verified local cache entries
continue to work. Update to `@ferriki/core` or the `ferriki` crate version 1.1.0
or later once publication completes. Until then, keep a populated cache or
configure `FERRIKI_ASSETS_BASE_URL` to a custom mirror serving the old catalog's
commit-based paths. The historical manifest resolver remains available for
custom mirrors; the hosted route is gone.

The pull zone now uses Storage Zone `ferriki-assets` (`1987400`) directly. The
GitHub origin and Storage origin override are removed, and the allowlist and
immutable response-header rule accept only the two short-hash path shapes. A
cache purge completes the cutoff. Published immutable Storage objects remain
available with SHA-256 integrity checks.
