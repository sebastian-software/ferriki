export type GrammarGroup = {
  id: string;
  title: string;
  description: string;
  languages: string[];
};

export const standardGroups: GrammarGroup[] = [
  {
    id: "documents",
    title: "Documents and configuration",
    description:
      "Documentation, content, package metadata, application settings, and data exchange.",
    languages: ["json", "jsonc", "json5", "markdown", "mdx", "yaml", "toml", "ini", "xml"],
  },
  {
    id: "web",
    title: "Web languages and components",
    description: "Browser and server JavaScript, React syntax, PHP, and component frameworks.",
    languages: [
      "javascript",
      "typescript",
      "jsx",
      "tsx",
      "html",
      "php",
      "angular-ts",
      "vue",
      "svelte",
      "astro",
      "glimmer-js",
      "glimmer-ts",
    ],
  },
  {
    id: "styles",
    title: "Styles and templates",
    description:
      "Stylesheets, preprocessors, Handlebars and Liquid templates, CSS-in-JS, and Lit HTML/SVG templates.",
    languages: [
      "css",
      "scss",
      "sass",
      "less",
      "pug",
      "handlebars",
      "liquid",
      "es-tag-css",
      "es-tag-html",
    ],
  },
  {
    id: "programming",
    title: "General-purpose programming",
    description:
      "Backend services, systems software, desktop and mobile apps, scripting, and scientific computing.",
    languages: [
      "c",
      "cpp",
      "csharp",
      "java",
      "python",
      "ruby",
      "go",
      "rust",
      "kotlin",
      "scala",
      "swift",
      "dart",
      "clojure",
      "haskell",
      "elixir",
      "gleam",
      "zig",
      "julia",
      "r",
      "lua",
      "perl",
    ],
  },
  {
    id: "infrastructure",
    title: "Infrastructure and automation",
    description:
      "Shell scripts, build files, containers, infrastructure definitions, and code changes.",
    languages: [
      "shellscript",
      "powershell",
      "docker",
      "make",
      "cmake",
      "hcl",
      "terraform",
      "nix",
      "diff",
    ],
  },
  {
    id: "games",
    title: "Game scripting",
    description: "GDScript for Godot and Luau for Roblox and other Luau runtimes.",
    languages: ["gdscript", "luau"],
  },
  {
    id: "queries",
    title: "Queries and patterns",
    description: "Database queries, GraphQL operations and schemas, and regular expressions.",
    languages: ["sql", "graphql", "regexp"],
  },
  {
    id: "gpu",
    title: "WebAssembly and graphics",
    description: "WebAssembly text and WGSL shaders for WebGPU.",
    languages: ["wasm", "wgsl"],
  },
];

export const supportGroups: GrammarGroup[] = [
  {
    id: "component-support",
    title: "Component and template support",
    description:
      "Expressions, directives, embedded markup, styles, and template syntax used by host grammars.",
    languages: [
      "angular-expression",
      "angular-html",
      "angular-inline-style",
      "angular-inline-template",
      "angular-let-declaration",
      "angular-template",
      "angular-template-blocks",
      "html-derivative",
      "markdown-vue",
      "vue-directives",
      "vue-interpolations",
      "vue-sfc-style-variable-injection",
      "haml",
      "postcss",
      "css-styled",
      "liquid-injection",
    ],
  },
  {
    id: "language-support",
    title: "Programming language support",
    description:
      "C++ macros, Liquid Haskell annotations, Elixir EEx templates, JavaScript regular expressions, and documentation comments.",
    languages: [
      "cpp-macro",
      "annotation-liquidhaskell-haskell",
      "eex",
      "js-regexp",
      "jsdoc",
      "sassdoc",
    ],
  },
  {
    id: "yaml-support",
    title: "YAML versions and embeddings",
    description: "Version-specific rules and embedded syntax selected by the YAML host grammar.",
    languages: ["yaml-1-0", "yaml-1-1", "yaml-1-2", "yaml-1-3", "yaml-embedded"],
  },
];

export const labels: Partial<Record<string, string>> = {
  "es-tag-css": "CSS-in-JS and CSS tagged templates",
  "es-tag-html": "HTML/SVG tagged templates (Lit)",
  "css-styled": "CSS-in-JS declarations and interpolation",
  "liquid-injection": "Liquid embedded expressions",
  "angular-expression": "Angular expressions",
  "angular-inline-style": "Angular inline styles",
  "angular-inline-template": "Angular inline templates",
  "angular-let-declaration": "Angular @let declarations",
  "angular-template": "Angular template expressions",
  "angular-template-blocks": "Angular control-flow blocks",
  "html-derivative": "Embedded HTML",
  "markdown-vue": "Markdown in Vue",
  "vue-directives": "Vue directives",
  "vue-interpolations": "Vue interpolations",
  "vue-sfc-style-variable-injection": "Vue style variables",
  "cpp-macro": "C++ macros",
  eex: "EEx templates in Elixir",
  "annotation-liquidhaskell-haskell": "Liquid Haskell annotations",
  "js-regexp": "JavaScript regular expressions",
  jsdoc: "JSDoc comments",
  sassdoc: "SassDoc comments",
  "yaml-1-0": "YAML 1.0",
  "yaml-1-1": "YAML 1.1",
  "yaml-1-2": "YAML 1.2",
  "yaml-1-3": "YAML 1.3",
  "yaml-embedded": "Embedded YAML syntax",
};
