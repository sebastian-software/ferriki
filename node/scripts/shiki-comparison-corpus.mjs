const fixtures = "node/compat/upstream/vscode-textmate/test-cases/themes/tests";

// Real files from this repository and its pinned upstream mirrors: large
// source files for throughput, small editor fixtures for per-call overhead.
export const comparisonCorpus = [
  ["rust", "src/highlighter.rs"],
  ["typescript", "node/ferriki/src/api.mts"],
  ["javascript", "node/ferriki/src/index.mjs"],
  ["markdown", "docs/ferriki-api.md"],
  ["yaml", ".github/workflows/ci.yml"],
  ["css", "node/compat/upstream/shiki/packages/twoslash/style-rich.css"],
  ["json", "node/package.json"],
  ["toml", "Cargo.toml"],
  ["python", `${fixtures}/test.py`],
  ["html", `${fixtures}/test.html`],
  ["go", `${fixtures}/test.go`],
  ["php", `${fixtures}/test.php`],
  ["shellscript", `${fixtures}/test.sh`],
  ["sql", `${fixtures}/test.sql`],
];
