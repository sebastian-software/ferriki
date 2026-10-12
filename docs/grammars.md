# Standard and External Grammars

Ferriki maintains its own standard catalog, with primary languages and support
grammars for embedded languages and injections. They load on demand through
the existing release-pinned CDN and cache. First use needs network access or a
prepared cache; see [asset loading](asset-loading.md).

The catalog covers:

- Application and backend languages: C, C++, C#, Java, JavaScript, TypeScript,
  JSX, TSX, Python, Rust, Go, PHP, Ruby, SQL, R, Julia, Lua, Perl, Swift, Kotlin,
  Scala, Dart, Clojure, Haskell, Elixir, Gleam, and Zig.
- Game scripting: GDScript for Godot and Luau for Roblox and other Luau runtimes.
- Web languages: HTML, CSS, SCSS, Sass, Less, Pug, Vue, Svelte, Astro, Angular
  TypeScript, Glimmer JS/TS, Handlebars, Liquid, GraphQL, CSS-in-JS, and tagged
  HTML/SVG/CSS template injections for Lit.
- Documents and configuration: Markdown, MDX, JSON, JSONC, JSON5, YAML, TOML,
  INI, XML, shell scripts, PowerShell, Dockerfiles, Make, CMake, HCL, Terraform,
  Nix, diffs, regular expressions, WebAssembly text, and WGSL.

[`assets/grammars/catalog.json`](../assets/grammars/catalog.json) owns IDs,
aliases, dependencies, and source selectors.
[`repositories.json`](../assets/grammars/repositories.json) configures the
maintained collections and justified exceptions. The generated
[`sources.json`](../assets/grammars/sources.json) locks repository commits,
individual files, hashes, and license notices.
`bundledLanguages` and `bundledLanguagesAlias` expose the available keys at
runtime. These names remain compatible with the existing API even though the
package bundles metadata rather than grammar payloads.

The curated catalog replaces the larger catalog shipped in Ferriki 1.0.
This initial transition ships in 1.1.0 as the one-time exception documented in
[ADR 0020](../adr/0020-curated-grammar-sources.md#release-scope).
Applications using an ID outside this set must register an external grammar.
Future removals of documented standard IDs or aliases follow the normal
major-release policy.

```js
import { createHighlighter } from "@ferriki/core";

const highlighter = await createHighlighter({
  langs: ["rust", "typescript", "yaml"],
  themes: ["nord"],
});
const html = highlighter.codeToHtml("fn main() {}", { lang: "rust", theme: "nord" });
highlighter.dispose();
```

Required embedded grammars load with their host. Markdown, MDX, and optional
Vue/Svelte embeddings use languages that the application loads explicitly.
The standard set does not include every language mentioned by an upstream
grammar. In particular, GLSL embedded in C++ needs an external registration
with scope `source.glsl`; the former source had no license notice. Unregistered
external scopes receive the host grammar's fallback styling.

Elixir loads its EEx template grammar and HTML support automatically. Zig uses
the TextMate grammar shipped by its upstream project; its separate Sublime
context-stack grammar does not need conversion. These languages, along with
Gleam, Luau, Nix, and GDScript, follow the existing Linguist collection pin.

JavaScript, TypeScript, JSX, and TSX automatically load HTML/SVG and CSS
injections. This covers Lit's `html`, `svg`, and `css` tags, Styled Components,
Emotion's tagged templates and CSS prop, and Styled JSX. Declaration-only CSS
bodies and JavaScript interpolation use the Styled Components helper grammar.
Ordinary object styles use the host JavaScript/TypeScript grammar.
Handlebars (`handlebars`, `hbs`, `hjs`), Liquid (`liquid`), and Glimmer components
(`glimmer-js`/`gjs`, `glimmer-ts`/`gts`) are standard language IDs.

## Import a language from an external source

After installing `@ferriki/core`, use its CLI to import a JSON TextMate grammar
from a local file, an HTTP(S) URL, or a commit-pinned GitHub file:

```sh
pnpm exec ferriki grammar fetch ./example.tmLanguage.json \
  --name example --aliases example-syntax --output ./example.ferriki.json
```

The GitHub source syntax is `github:owner/repo@<40-character-commit>/path`.
An HTTPS URL can point directly to a grammar in an author's repository or in a
VS Code extension. The importer accepts grammar data; it does not execute
extension code. YAML, PLIST, and CSON inputs must first be converted to JSON.

`--name` chooses the Ferriki language ID independently of the upstream display
name. `--aliases`, `--embedded`, and `--inject-to` accept comma-separated values.
`--embedded` lists language IDs; `--inject-to` lists target TextMate scopes.
Load external dependency grammars as separate registrations. A grammar's
scope name must match the scope referenced by its host's `include` rules.

The importer validates registration and initial compilation with Ferriki's
native engine. This catches malformed grammars and invalid regexes encountered
during compilation; it is not an exhaustive lint of every deferred embedded
rule. Imports have an 8 MiB limit and downloads have a 60-second timeout.
`--sha256 <digest>` verifies the original downloaded or local bytes.

With `--output`, the importer creates the registration and an accompanying
`.lock.json` containing the source and its SHA-256. It refuses to overwrite
existing files. Without `--output`, it prints the registration to stdout.
Review the source's license before redistributing an external grammar.

```js
import { createHighlighter } from "@ferriki/core";
import grammar from "./example.ferriki.json" with { type: "json" };

const highlighter = await createHighlighter({
  langs: [grammar],
  themes: ["nord"],
});
const html = highlighter.codeToHtml("example source", { lang: "example-syntax", theme: "nord" });
highlighter.dispose();
```

The registration can also be passed to `highlighter.loadLanguage(grammar)`.
No change to Ferriki's standard catalog is needed. Rust applications can read
the same JSON and call `Highlighter::register_language_json`, or use a typed
`LanguageRegistration` with `register_language`.

## Maintain the standard catalog

The maintenance unit is a repository snapshot. VS Code provides the main
TextMate collection; GitHub Linguist provides additional grammars through its
own pinned submodules. Ferriki follows the Linguist collection pin instead of
tracking every specialist repository's branch independently. Angular, Vue,
Svelte, Astro, HTML/SVG tagged templates, and CSS-in-JS are the six explicit
exceptions. Handlebars comes from VS Code; Liquid and Glimmer follow Linguist.

The importer discovers VS Code grammars from `contributes.grammars` without
executing package scripts. Linguist's submodule commits come from the pinned
aggregate tree and `.gitmodules`. Inputs in JSON, YAML, XML PLIST, and data-only
CSON are converted to normalized TextMate JSON. Tree-sitter descriptors and
Sublime `.sublime-syntax` state machines are outside this converter.

The existing raw-source directory name and `assets/shiki/` CDN path remain for
distribution stability. The source pipeline does not read Shiki modules.

### Prepare and validate a local update

Start with the [contributor prerequisites](../CONTRIBUTING.md#prerequisites),
a working checkout, and GitHub CLI authentication or a `GH_TOKEN`/`GITHUB_TOKEN`
that can read the source repositories. Run these commands from the repository
root. Choose a new candidate directory; preparation refuses an existing one.

```sh
pnpm -C node install --frozen-lockfile --ignore-scripts
pnpm -C node run build:native
node scripts/prepare-grammar-update.mjs --output-dir /tmp/ferriki-candidate
node scripts/validate-grammar-candidate.mjs /tmp/ferriki-candidate
node scripts/apply-grammar-update.mjs /tmp/ferriki-candidate
pnpm -C node run test:ferriki-compat:core
pnpm -C node run check:bench-curated
pnpm -C node run check:bench-tiobe
node scripts/sync-grammars.mjs --check
```

Preparation resolves each repository's configured ref once, writes a separate
candidate, computes all hashes, archives license notices, and emits `report.json`.
The report lists source changes, newly discovered grammars, added dependencies,
external scopes, and patches already fixed upstream. Unknown new languages are
reported rather than silently becoming defaults. Required supported scope
dependencies are included transitively; document and component embeddings
retain their explicit lazy policy.

`--locked` prepares the same snapshot again without resolving moving refs.
`sync-grammars.mjs` without flags reproduces normalized files from their locked
original URLs; `--check` verifies committed data without network access.
No maintainer edits commit or file hashes manually. Selection and adapter
configuration changes remain explicit edits in the two configuration files.

The initial native build supplies the candidate validator. After application,
the mandatory core gate rebuilds the addon and seeds its cache from the new
assets before testing. Review the candidate's `report.json` and resulting diff
before committing an update.

### Automatic update pull requests

The [**Grammar updates** workflow](../.github/workflows/grammar-updates.yml)
runs every Monday at 06:00 UTC, starting from the repository's default branch.
Each run resolves the configured repository heads and Linguist module pins,
prepares a separate candidate, and generates hashes and license notices. An
unchanged accepted snapshot finishes without creating a PR. Otherwise it
compiles every grammar natively, applies the candidate in the runner, runs
the mandatory core compatibility gate (including frontend embeddings and
external imports), and checks both correctness corpora. Only a passing
candidate is pushed.

The workflow owns `codex/grammar-updates` and creates one draft PR against the
default branch. Later runs refresh that branch and the open PR's report instead
of accumulating PRs. Identical candidate trees do not produce another push.
The branch is rebuilt from the current default branch with a push lease to
reject concurrent changes. A manual commit on the bot branch stops replacement;
make selection or patch changes in a separate PR against the default branch.

To activate the schedule, merge the workflow and its scripts onto the default
branch. Under **Settings → Actions → General → Workflow permissions**, enable
**Allow GitHub Actions to create and approve pull requests** if it is disabled.
The workflow declares `contents: write` and `pull-requests: write` and uses the
repository's automatic `GITHUB_TOKEN`; no additional token secret is required.
See [GitHub's workflow permission documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).

After activation, use **Actions → Grammar updates → Run workflow** to request
an immediate check, or run:

```sh
gh workflow run grammar-updates.yml --repo sebastian-software/ferriki
gh run list --workflow grammar-updates.yml --repo sebastian-software/ferriki
```

Review the source pins, changed grammar IDs, license notices, and generated
asset diff in the PR. GitHub puts `pull_request` CI runs triggered by
`GITHUB_TOKEN` in an approval-required state; select **Approve workflows to run**
on the PR when shown. The update workflow already runs its grammar validation
before pushing, but the PR's regular required checks must also pass before
merge. See [GitHub's token-trigger behavior](https://docs.github.com/en/actions/concepts/security/github_token).
Merge after review; assets reach consumers through the normal release and CDN
publication process. The updater does not merge PRs or publish a release.

### Recover a failed update

A missing source, ambiguous selector, changed patch precondition, unsupported
license, or failed validation stops the workflow before it pushes a candidate.
The **grammar-candidate** artifact retains available candidate files and reports
for 14 days, including `failure.json` for preparation errors. Download it from
the failed Actions run and inspect the failing step. An existing PR keeps its
previous passing candidate.

Fix the selection or reviewed patch on a separate branch, run the local update
checks, merge the fix into the default branch, and rerun **Grammar updates**.
If the updater reports a manual commit on its branch, preserve and review that
work before removing the bot branch or restarting the updater. To pause
automatic proposals, disable the workflow in GitHub Actions.

The native compatibility gate compiles every selected grammar and exercises
external importing. Advisory backtracking warnings are available through the
Rust APIs; a complete static grammar lint remains outside this importer.
The grammar notices ship as `assets/shiki/GRAMMAR-NOTICES.md`.
