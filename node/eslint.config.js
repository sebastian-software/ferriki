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
      // Prepared for the org lint setup (#110). Both import
      // `eslint-config-setup`, which needs ESLint >= 10, while this workspace
      // is on the ESLint 9 catalog entry it shares with the upstream mirror.
      // Until that bump lands they are not the entry point, so they are not
      // linted either.
      "eslint.config.ts",
      "oxlint.config.ts",
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
