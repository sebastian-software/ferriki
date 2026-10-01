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
);
