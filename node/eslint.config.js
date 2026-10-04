// @ts-check
import antfu from "@antfu/eslint-config";

export default antfu(
  {
    type: "lib",
    pnpm: true,
    // oxfmt is the formatter (`.oxfmtrc.json` next to this file), so ESLint
    // checks correctness only.
    stylistic: false,
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.d.mts",
      "compat/upstream/**",
      "pnpm-workspace.yaml",
    ],
  },
  {
    rules: {
      "no-restricted-syntax": "off",
      "ts/no-invalid-this": "off",
      // Owned by oxfmt, which sorts package.json keys and lowercases numeric
      // literals; keeping the lint rules on would fight the formatter.
      "jsonc/sort-keys": "off",
      "unicorn/number-literal-case": "off",
    },
  },
  {
    files: ["vite/package.json"],
    rules: {
      // Core follows the shared product version, not an external catalog.
      "pnpm/json-enforce-catalog": ["error", { ignores: ["@ferriki/core"] }],
    },
  },
  {
    files: ["examples/inline-macro/package.json"],
    rules: {
      // This fixture is installed outside the workspace to verify packed
      // consumers; its reproducible dependency pins cannot use our catalog.
      "pnpm/json-enforce-catalog": "off",
    },
  },
);
