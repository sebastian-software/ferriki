/* eslint-disable no-template-curly-in-string -- Source fixtures intentionally contain JavaScript template interpolation. */
import { readFileSync } from "node:fs";

// Freeze tasks and split before comparing output models. These are targeted
// examples, not a sample of real users; percentages apply only to this catalog.
export const tasks = [
  ["strings", "Style all strings", ".tok-string"],
  ["comments", "Style all comments", ".tok-comment"],
  ["keywords", "Style all keywords", ".tok-keyword"],
  ["numbers", "Style numeric literals", ".tok-constant-numeric"],
  ["functions", "Style function names", ".tok-entity-name-function"],
  ["types", "Style type names", ".tok-entity-name-type"],
  ["parameters", "Style function parameters", ".tok-variable-parameter"],
  [
    "escapes",
    "Override escape sequences inside strings",
    ".tok-string.tok-constant-character-escape",
  ],
  ["json-keys", "Style JSON property names", ".tok-support-type-property_2d_name-json"],
  [
    "json-values",
    "Style JSON string contents inside objects",
    ".ctx-meta-structure-dictionary-json.leaf-string-quoted-double-json",
  ],
  [
    "template-variables",
    "Style variables inside template strings",
    ".ctx-string-template.tok-variable",
  ],
  ["html-tags", "Style HTML tag names", ".tok-entity-name-tag-html"],
  ["html-attributes", "Style HTML attribute names", ".tok-entity-other-attribute_2d_name-html"],
  [
    "embedded-js",
    "Style JavaScript keywords embedded in HTML",
    ".ctx-text-html.ctx-source-js.tok-keyword",
  ],
  ["css-classes", "Style CSS class selectors", ".tok-entity-other-attribute_2d_name-class"],
  ["markdown-heading", "Style Markdown headings", ".tok-markup-heading"],
  ["python-docstring", "Style Python docstrings", ".tok-string-quoted-docstring"],
  [
    "regex-escapes",
    "Style escapes in regular expressions",
    ".ctx-string-regexp.tok-constant-character-escape",
  ],
  ["scope-order", "Distinguish reversed ancestor order", null],
  ["scope-repetition", "Distinguish repeated ancestor scopes", null],
].map(([id, title, flatSelector], index) => ({
  id,
  title,
  flatSelector,
  split: index < 14 ? "development" : "holdout",
}));

export const syntheticGrammar = {
  name: "class-probe",
  scopeName: "source.class-probe",
  patterns: [
    { match: "AB", name: "meta.a meta.b entity.name.probe" },
    { match: "BA", name: "meta.b meta.a entity.name.probe" },
    { match: "AA", name: "meta.a meta.a entity.name.probe" },
    { match: "A!", name: "meta.a entity.name.probe" },
  ],
};

export const syntheticTheme = {
  name: "class-probe-context",
  fg: "#111111",
  bg: "#ffffff",
  settings: [
    { settings: { foreground: "#111111" } },
    { scope: "meta.a meta.b entity.name.probe", settings: { foreground: "#ff0000" } },
    { scope: "meta.b meta.a entity.name.probe", settings: { foreground: "#0000ff" } },
    { scope: "meta.a > meta.a entity.name.probe", settings: { foreground: "#008000" } },
    {
      scope: "source.class-probe > meta.a > entity.name.probe",
      settings: { foreground: "#ff00ff" },
    },
  ],
};

export function loadCorpus(root) {
  const cases = [
    [
      "ts-basics",
      "typescript",
      "const greet = (name: string) => `Hello ${name}!`;\nfunction add(left: number, right: number): number { return left + right; }\n// A comment\nconst text = 'line\\n😀';",
    ],
    ["json-root", "json", '"hello"'],
    [
      "json-object",
      "json",
      '{"message":"hello","nested":{"value":"world"},"array":["item"],"escaped":"a\\nb"}',
    ],
    [
      "html-embedded",
      "html",
      '<section class="sample"><script>const label = "hello"; function run() { return label; }</script><style>.sample { color: red; }</style></section>',
    ],
    [
      "css-selectors",
      "css",
      '.card:hover, #app > button { color: red; transform: translateX(10px); --accent: "x"; }',
    ],
    [
      "python-context",
      "python",
      'class Greeter:\n    """A docstring with \\n escape."""\n    def greet(self, name):\n        # Comment\n        return f"Hello {name}!"',
    ],
    [
      "js-regexp",
      "javascript",
      "const pattern = /a\\/\\d+(?<name>\\w+)/gi;\nconst text = `first ${value} then ${other}`;",
    ],
    [
      "md-embedded",
      "markdown",
      "# Heading\n\nA **bold** word and `inline`.\n\n```typescript\nconst answer: number = 42;\n```",
    ],
    ["scope-context", "class-probe", "AB BA AA A!"],
  ].map(([id, lang, code], index) => ({
    id,
    lang,
    code,
    split: index < 7 ? "development" : "holdout",
    source: "authored probe",
  }));
  const fixtureRoot = "node/compat/upstream/vscode-textmate/test-cases/themes/tests";
  const files = [
    ["rust", "src/highlighter.rs"],
    ["typescript", "node/ferriki/src/api.mts"],
    ["javascript", "node/ferriki/src/index.mjs"],
    ["markdown", "docs/ferriki-api.md"],
    ["yaml", ".github/workflows/ci.yml"],
    ["css", "node/compat/upstream/shiki/packages/twoslash/style-rich.css"],
    ["json", "node/package.json"],
    ["toml", "Cargo.toml"],
    ["python", `${fixtureRoot}/test.py`],
    ["html", `${fixtureRoot}/test.html`],
    ["go", `${fixtureRoot}/test.go`],
    ["php", `${fixtureRoot}/test.php`],
    ["shellscript", `${fixtureRoot}/test.sh`],
    ["sql", `${fixtureRoot}/test.sql`],
  ];
  for (const [index, [lang, path]] of files.entries()) {
    cases.push({
      id: `file-${lang}`,
      lang,
      code: readFileSync(`${root}/${path}`, "utf8")
        .replaceAll("\r\n", "\n")
        .split("\n")
        .slice(0, 24)
        .join("\n"),
      source: `${path} (first 24 lines)`,
      split: index < 7 ? "development" : "holdout",
    });
  }
  return cases;
}
