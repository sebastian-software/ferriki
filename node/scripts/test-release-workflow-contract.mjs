import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertReleaseWorkflow } from "./check-release-workflow.mjs";

const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = join(nodeRoot, "..");
const workflowPath = join(repoRoot, ".github", "workflows", "publish.yml");
const workflow = await readFile(workflowPath, "utf8");
const checklist = await readFile(join(repoRoot, "docs", "release-checklist.md"), "utf8");
const releaseConfig = JSON.parse(
  await readFile(join(repoRoot, ".release-please-config.json"), "utf8"),
);
const nodePackage = JSON.parse(await readFile(join(nodeRoot, "package.json"), "utf8"));

assert.doesNotThrow(() =>
  assertReleaseWorkflow({ workflow, checklist, releaseConfig, nodePackage }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace("          persist-credentials: false\n", ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /persist-credentials: false/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "pnpm install --frozen-lockfile --ignore-scripts",
        "pnpm install --frozen-lockfile",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "pnpm install --frozen-lockfile --ignore-scripts",
        "pnpm install --frozen-lockfile --ignore-scripts=false",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "pnpm install --frozen-lockfile --ignore-scripts",
        "pnpm install --frozen-lockfile=false --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--frozen-lockfile/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "pnpm install --frozen-lockfile --ignore-scripts",
        "pnpm install --frozen-lockfile --ignore-scripts --no-ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "pnpm install --frozen-lockfile --ignore-scripts",
        "pnpm i --frozen-lockfile",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "pnpm install --frozen-lockfile --ignore-scripts",
        "pnpm -C node i",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--frozen-lockfile/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "pnpm install --frozen-lockfile --ignore-scripts",
        "pnpm add left-pad",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not run pnpm add/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        'run: "pnpm install --frozen-lockfile"',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: 'pnpm i --frozen-lockfile'",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm install --frozen-lockfile # --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        '      npm_config_ignore_scripts: "true"\n',
        '      npm_config_ignore_scripts: "false"\n',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /npm_config_ignore_scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: if true; then pnpm install --frozen-lockfile; fi",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: (pnpm install --frozen-lockfile)",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: env CI=1 pnpm i --frozen-lockfile",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm install --frozen-lockfile --ignore-scripts\n      - run: corepack pnpm install --frozen-lockfile",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: echo skipped-install",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        '          retention-days: "1"\n',
        '          retention-days: "1"\n          command: pnpm install --frozen-lockfile\n',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        '          retention-days: "1"\n',
        '          retention-days: "1"\n          test-command: pnpm install\n',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--frozen-lockfile/,
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow.replace(
      "run: pnpm install --frozen-lockfile --ignore-scripts",
      "run: pnpm install --frozen-lockfile --ignore-scripts\n      - run: echo 'Lockfile is stale; pnpm install locally to refresh it'",
    ),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        'run: pnpm --dir "my node dir" install --frozen-lockfile',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        'run: pnpm --dir "my node dir" install --frozen-lockfile --ignore-scripts',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow.replace(
      "run: pnpm install --frozen-lockfile --ignore-scripts",
      'run: pnpm install --frozen-lockfile --ignore-scripts\n      - run: pnpm --dir "my node dir" install --frozen-lockfile --ignore-scripts',
    ),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        if: inputs.force-publish\n        run: pnpm install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        'run: |\n          docker run --rm node:22-alpine sh -euc "pnpm install --frozen-lockfile"\n          pnpm install --frozen-lockfile --ignore-scripts',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow.replace(
      "run: pnpm install --frozen-lockfile --ignore-scripts",
      'run: pnpm install --frozen-lockfile --ignore-scripts\n      - run: docker run --rm -e npm_config_ignore_scripts=true node:22-alpine sh -euc "pnpm install --frozen-lockfile --ignore-scripts"',
    ),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        'run: bash -c "pnpm install"',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--frozen-lockfile/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: bash -euo pipefail -c 'pnpm i --frozen-lockfile'",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        'run: /bin/sh -lc "pnpm install --frozen-lockfile"',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow.replace(
      "run: pnpm install --frozen-lockfile --ignore-scripts",
      'run: pnpm install --frozen-lockfile --ignore-scripts\n      - run: bash -c "pnpm install --frozen-lockfile --ignore-scripts"',
    ),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "        uses: ./node/node_modules/ferramenta-native/actions/release-native\n",
        '        uses: ./node/node_modules/ferramenta-native/actions/release-native\n        env:\n          npm_config_ignore_scripts: "false"\n',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not override npm_config_ignore_scripts/,
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow.replace(
      "run: pnpm install --frozen-lockfile --ignore-scripts",
      "run: pnpm install --frozen-lockfile --ignore-scripts\n      - run: |\n          cat <<'EOF' > /dev/null\n          pnpm install\n          EOF",
    ),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: |\n          cat <<-EOF > /dev/null\n          \tpnpm install --frozen-lockfile --ignore-scripts\n          \tEOF",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: |\n          bash <<'EOF'\n          pnpm install\n          EOF\n          pnpm install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--frozen-lockfile/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: |\n          /usr/bin/env sh <<-EOF\n          \tpnpm install --frozen-lockfile\n          \tEOF\n          pnpm install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow.replace(
      "run: pnpm install --frozen-lockfile --ignore-scripts",
      "run: pnpm install --frozen-lockfile --ignore-scripts\n      - run: |\n          printf 'Run:\n          pnpm install\n          '",
    ),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: |\n          cat <<<EOF > /dev/null\n          pnpm install\n          pnpm install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--frozen-lockfile/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow
        .replace(
          "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n\n      # OIDC dist-tag promotion",
          "      # OIDC dist-tag promotion",
        )
        .replace(
          "          prepare-command: |\n            pnpm run build",
          "          prepare-command: |\n            pnpm install --frozen-lockfile --ignore-scripts\n            pnpm run build",
        ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /publish-npm must run a checked unconditional node-workspace pnpm install step before invoking \.\/node\/node_modules\/ferramenta-native\/actions\/release-native/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: false && pnpm install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: if false; then pnpm install --frozen-lockfile --ignore-scripts; fi",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm install --frozen-lockfile --ignore-scripts --prod",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm install --frozen-lockfile --ignore-scripts --lockfile-only",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm install --frozen-lockfile --ignore-scripts --filter @ferriki/core",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: |\n          cd ../homepage\n          pnpm install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: env -C ../homepage pnpm install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm recursive install",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--frozen-lockfile/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm m install --frozen-lockfile",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /--ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        continue-on-error: true\n        run: pnpm install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        `      - name: Install dependencies\n        continue-on-error: \${{ inputs.force-publish }}\n        run: pnpm install --frozen-lockfile --ignore-scripts`,
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: NODE_ENV=production pnpm install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        env:\n          NODE_ENV: production\n        run: pnpm install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        '      npm_config_ignore_scripts: "true"\n',
        '      npm_config_ignore_scripts: "true"\n      npm_config_production: "true"\n',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm install --frozen-lockfile --ignore-scripts ./some-package",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow pnpm install must not pass positional package operands/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm --dir /node install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: /usr/local/bin/pnpm install",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow pnpm install must effectively enable --frozen-lockfile/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm install --frozen-lockfile --ignore-scripts --help",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          persist-credentials: false",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Prune to production deps\n        run: pnpm install --frozen-lockfile --ignore-scripts --prod",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Prune deps\n        run: pnpm prune --prod",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Prune from workspace member\n        working-directory: ./node/ferriki/\n        run: pnpm install --frozen-lockfile --ignore-scripts --prod",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Combined install and test\n        run: pnpm install-test --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run pnpm install-test/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Combined install and test alias\n        run: pnpm it --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run pnpm it/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Update deps\n        run: pnpm update",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run pnpm update/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Rebuild deps\n        run: pnpm rebuild\n      - name: Reinstall dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run pnpm rebuild/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: `${workflow}\n      - name: Rebuild after action\n        run: pnpm rebuild\n`,
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run pnpm rebuild/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Rebuild alias\n        run: pnpm rb",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run pnpm rb/,
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow.replace(
      "run: pnpm install --frozen-lockfile --ignore-scripts",
      "run: pnpm install --frozen-lockfile --ignore-scripts > install.log 2>&1",
    ),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow.replace(
      "run: pnpm install --frozen-lockfile --ignore-scripts",
      "run: < /dev/null pnpm install --frozen-lockfile --ignore-scripts >| install.log 2>> err.log",
    ),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Pack with scripts enabled\n        run: npm pack --ignore-scripts=false",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow npm pack must effectively enable --ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Publish with scripts enabled\n        run: npm publish --ignore-scripts false",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow npm publish must effectively enable --ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Pack with pnpm scripts enabled\n        run: pnpm pack --no-ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow pnpm pack must effectively enable --ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Publish with pnpm scripts enabled\n        run: pnpm publish --ignore-scripts=false",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow pnpm publish must effectively enable --ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Update via npm short alias\n        run: npm u",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run npm update/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Unknown npm subcommand\n        run: npm audit fix",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run unrecognized npm subcommand audit/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Verify public npm packages, provenance, and install\n        run: node ./node/scripts/verify-npm-publish.mjs",
        "      - name: Clean install alias without ignore-scripts\n        run: npm clean-install\n      - name: Verify public npm packages, provenance, and install\n        run: node ./node/scripts/verify-npm-publish.mjs",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow npm ci must effectively enable --ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Workspace clean install alias\n        run: npm clean-install --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Forbidden clean-install-test alias\n        run: npm clean-install-test --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run npm install-ci-test/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        '      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Mutate GITHUB_ENV\n        run: echo "npm_config_ignore_scripts=false" >> "$GITHUB_ENV"',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not mutate GITHUB_ENV/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Verify public npm packages, provenance, and install\n        run: node ./node/scripts/verify-npm-publish.mjs",
        "      - name: Install via npm with cache flag\n        run: npm --cache /tmp/cache install\n      - name: Verify public npm packages, provenance, and install\n        run: node ./node/scripts/verify-npm-publish.mjs",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow npm install must effectively enable --ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Workspace npm install with cache flag\n        run: npm --cache /tmp/cache install --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Unknown npm global flag\n        run: npm --bogus-flag /tmp/x install",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /unrecognized pre-subcommand option --bogus-flag/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Pin global npm with scripts enabled\n        run: npm install -g --ignore-scripts false npm@11.12.1",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow npm install must effectively enable --ignore-scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Non-global npm install via boolean false\n        run: npm install --global false --ignore-scripts npm@11.12.1",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow.replace(
      "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
      "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Pin global npm\n        run: npm install -g --ignore-scripts npm@11.12.1",
    ),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Export disable ignore-scripts\n        run: |\n          export npm_config_ignore_scripts=false\n          pnpm run build:native",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not override npm_config_ignore_scripts away from "true"/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Unset ignore-scripts\n        run: |\n          unset npm_config_ignore_scripts\n          pnpm run build:native",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not override npm_config_ignore_scripts away from "true"/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Conditional operator restore\n        run: |\n          unset npm_config_ignore_scripts\n          false && export npm_config_ignore_scripts=true\n          pnpm run build:native",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not override npm_config_ignore_scripts away from "true"/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Conditional if-block restore\n        run: |\n          export NPM_CONFIG_IGNORE_SCRIPTS=false\n          if false; then export npm_config_ignore_scripts=true; fi\n          pnpm run build:native",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not override npm_config_ignore_scripts away from "true"/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Conditional mutation\n        run: |\n          if false; then export npm_config_ignore_scripts=true; fi\n          pnpm run build:native",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not conditionally mutate npm_config_ignore_scripts/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Wrapped conditional restore\n        run: sh -c 'unset npm_config_ignore_scripts; false && export npm_config_ignore_scripts=true; pnpm run build:native'",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not override npm_config_ignore_scripts away from "true"/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Weakening before arbitrary script\n        run: |\n          unset npm_config_ignore_scripts\n          node scripts/custom.mjs",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not override npm_config_ignore_scripts away from "true"/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Remote runner via pnpm dlx\n        run: pnpm dlx create-something",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run pnpm dlx/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Remote runner via npm exec\n        run: npm exec -- some-pkg",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run npm exec/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Remote runner via npm x\n        run: npm x some-pkg",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run npm x/,
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow.replace(
      "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
      "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Run local workspace tool\n        run: pnpm exec tsc --version",
    ),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Prune with npm\n        run: npm prune --omit=dev",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Prune with npm after cd\n        working-directory: .\n        run: cd node && npm prune --omit=dev",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Rebuild with npm\n        run: npm rebuild",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow must not run npm rebuild/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Wrapped override\n        run: NPM_CONFIG_IGNORE_SCRIPTS=false sh -c 'pnpm install --frozen-lockfile --ignore-scripts'",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not override npm_config_ignore_scripts away from "true"/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Wrapped unset\n        run: env -u npm_config_ignore_scripts sh -c 'pnpm run build:native'",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not override npm_config_ignore_scripts away from "true"/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Container build without env forward\n        run: docker run --rm node:22-alpine sh -c 'pnpm run build:native'",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not override npm_config_ignore_scripts away from "true"/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        '      - name: Install dependencies\n        env:\n          NPM_CONFIG_IGNORE_SCRIPTS: "false"\n        run: pnpm install --frozen-lockfile --ignore-scripts',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not override npm_config_ignore_scripts away from "true"/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: NPM_CONFIG_IGNORE_SCRIPTS=false pnpm install --frozen-lockfile --ignore-scripts",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must not override npm_config_ignore_scripts away from "true"/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Prune after cd\n        working-directory: .\n        run: cd node && pnpm prune --prod",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts",
        '      - name: Install dependencies\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Prune after dynamic cd\n        working-directory: .\n        run: cd "$TARGET" && pnpm prune --prod',
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm install --frozen-lockfile --ignore-scripts --dev",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm install --frozen-lockfile --ignore-scripts --dev=true",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm install --frozen-lockfile --ignore-scripts -D",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /build-native must run a checked unconditional node-workspace pnpm install step before invoking/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: pnpm install --frozen-lockfile --ignore-scripts",
        "run: pnpm install --frozen-lockfile --ignore-scripts > install.log foo",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release workflow pnpm install must not pass positional package operands/,
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow.replace("persist-credentials: false", 'persist-credentials: "false"'),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow
      .replace("jobs:\n", "defaults:\n  run:\n    working-directory: node\n\njobs:\n")
      .replace("    defaults:\n      run:\n        working-directory: node\n", ""),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow: workflow.replace(
      "run: pnpm install --frozen-lockfile --ignore-scripts",
      "run: pnpm i --frozen-lockfile=true --ignore-scripts=true\n      - run: if true; then (pnpm i --frozen-lockfile=true --ignore-scripts=true); fi",
    ),
    checklist,
    releaseConfig,
    nodePackage,
  }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(/ {6}- verify-release-source\n(?= {4}if:)/, ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /publish-crates must depend on exact-release verification/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        /ref: \$\{\{ needs\.verify-release-source\.outputs\.release_sha \}\}/,
        "ref: github.sha",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /publish-crates must check out the verified release SHA/,
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow,
    checklist,
    releaseConfig,
    nodePackage: { ...nodePackage, packageManager: "pnpm@10.29.0" },
  }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow,
      checklist,
      releaseConfig,
      nodePackage: { ...nodePackage, packageManager: "pnpm@11.0.0" },
    }),
  /workspace must use pnpm 10/,
);

assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: node scripts/rebuild-locked-assets.mjs",
        "run: node --version",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /asset rebuild must verify the reviewed lock before upload/,
);

const concurrencyGroup = `  group: publish-\${{ github.repository }}\n`;
assert.equal(workflow.split(concurrencyGroup).length - 1, 1);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        concurrencyGroup,
        `  group: publish-\${{ github.repository }}-\${{ github.ref }}\n`,
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /one non-canceling concurrency group/,
);

const nativeAction = "        uses: ./node/node_modules/ferramenta-native/actions/release-native\n";
assert.equal(workflow.split(nativeAction).length - 1, 1);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(nativeAction, "        run: npm publish\n"),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must use the shared native release action/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace('          publish: "true"', '          publish: "false"'),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /enable publication explicitly/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace("            pnpm run check:packed-vite\n", ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /packed Vite consumer check/,
);

const withoutViteReleaseFiles = {
  ...releaseConfig,
  packages: {
    ".": {
      ...releaseConfig.packages["."],
      "extra-files": releaseConfig.packages["."]["extra-files"].filter(
        (file) => file.path !== "/node/vite/package.json",
      ),
    },
  },
};
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow,
      checklist,
      releaseConfig: withoutViteReleaseFiles,
      nodePackage,
    }),
  /must update the Vite integration version/,
);

for (const crate of ["ferriki-textmate", "ferriki-asset-gen"]) {
  const requiredSelector = `$.package[?(@.name.value=='${crate}' && !@.source)].version`;
  const withoutCrateLockEntry = {
    ...releaseConfig,
    packages: {
      ".": {
        ...releaseConfig.packages["."],
        "extra-files": releaseConfig.packages["."]["extra-files"].filter(
          (file) => file.jsonpath !== requiredSelector,
        ),
      },
    },
  };
  assert.throws(
    () =>
      assertReleaseWorkflow({
        workflow,
        checklist,
        releaseConfig: withoutCrateLockEntry,
        nodePackage,
      }),
    new RegExp(`must update ${crate} in the separate fuzz lockfile`),
  );
}

const broadFuzzLockSelector = {
  ...releaseConfig,
  packages: {
    ".": {
      ...releaseConfig.packages["."],
      "extra-files": releaseConfig.packages["."]["extra-files"].map((file) =>
        file.jsonpath === "$.package[?(@.name.value=='ferriki-textmate' && !@.source)].version"
          ? { ...file, jsonpath: "$.package[?(@.name.value=='ferriki-textmate')].version" }
          : file,
      ),
    },
  },
};
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow,
      checklist,
      releaseConfig: broadFuzzLockSelector,
      nodePackage,
    }),
  /must update ferriki-textmate in the separate fuzz lockfile/,
);

const crateOrder =
  "          crates: |\n" +
  "            ferriki-textmate\n" +
  "            ferriki-asset-gen\n" +
  "            ferriki\n";
assert.equal(workflow.split(crateOrder).length - 1, 1);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        crateOrder,
        "          crates: |\n" +
          "            ferriki\n" +
          "            ferriki-textmate\n" +
          "            ferriki-asset-gen\n",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /dependency order/,
);

const sidecarDownload = "          pattern: native-*\n          path: native-sidecars\n";
const sidecarSizeEnv = "          NATIVE_SIDECARS_DIR: native-sidecars\n";
assert.equal(workflow.split(sidecarDownload).length - 1, 1);
assert.equal(workflow.split(sidecarSizeEnv).length - 1, 1);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(sidecarDownload, "          name: native-linux-x64-gnu\n"),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release-summary must download every native sidecar artifact/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(sidecarSizeEnv, ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release-summary must report addon sizes/,
);

const cratesDependency = "      - verify-crates-publish\n";
const cratesResult = `          CRATES_RESULT: \${{ needs.publish-crates.result }}\n`;
assert.equal(workflow.split(cratesDependency).length - 1, 1);
assert.equal(workflow.split(cratesResult).length - 1, 1);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(cratesDependency, ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /summary must wait for Rust verification/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(cratesResult, ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /CRATES_RESULT/,
);
const cratesGateGuard = "needs.verify-release-source.result == 'success' && ";
const cratesJobIndex = workflow.indexOf("\n  verify-crates-publish:\n");
assert(cratesJobIndex >= 0);
assert(workflow.slice(cratesJobIndex).includes(cratesGateGuard));
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow:
        workflow.slice(0, cratesJobIndex) +
        workflow.slice(cratesJobIndex).replace(cratesGateGuard, ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /crates verification must not check out an unverified release source/,
);

const fixtureRoot = await mkdtemp(join(tmpdir(), "ferriki-publish-contract-"));
const fixturePackage = join(fixtureRoot, "fixture");
const fixturePack = join(fixtureRoot, "packed");
const fixtureManifest = {
  name: "@ferriki/publish-contract-fixture",
  version: "0.0.0-test.0",
  files: ["package.json"],
  dependencies: { "magic-string": "catalog:integrations" },
};
try {
  await mkdir(fixturePackage, { recursive: true });
  await mkdir(fixturePack);
  await writeFile(
    join(fixtureRoot, "package.json"),
    JSON.stringify({ private: true, packageManager: nodePackage.packageManager }),
  );
  await writeFile(
    join(fixtureRoot, "pnpm-workspace.yaml"),
    "packages:\n  - fixture\ncatalogs:\n  integrations:\n    magic-string: ^0.30.21\n",
  );
  await writeFile(join(fixturePackage, "package.json"), JSON.stringify(fixtureManifest));

  const packEnv = { ...process.env, npm_config_ignore_scripts: "true" };
  const packResult = JSON.parse(
    execFileSync(
      "pnpm",
      ["--dir", fixturePackage, "pack", "--pack-destination", fixturePack, "--json"],
      { cwd: fixtureRoot, encoding: "utf8", env: packEnv },
    ),
  );
  const packedManifest = JSON.parse(
    execFileSync("tar", ["-xOf", packResult.filename, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(packedManifest.name, fixtureManifest.name);
  assert.equal(packedManifest.version, fixtureManifest.version);
  assert.deepEqual(packedManifest.dependencies, { "magic-string": "^0.30.21" });

  // The recovery publisher uses this exact pnpm JSON shape for every product
  // package, then passes the resulting tarball to npm.
  for (const [directory, expectedName] of [
    ["ferriki", "@ferriki/core"],
    ["platforms/linux-x64-gnu", "@ferriki/linux-x64-gnu"],
    ["vite", "@ferriki/vite"],
  ]) {
    const packageDirectory = join(nodeRoot, directory);
    const result = JSON.parse(
      execFileSync(
        "pnpm",
        ["--dir", packageDirectory, "pack", "--pack-destination", fixturePack, "--json"],
        { cwd: nodeRoot, encoding: "utf8", env: packEnv },
      ),
    );
    const sourceManifest = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    );
    assert.equal(result.name, expectedName);
    assert.equal(result.version, sourceManifest.version);
    assert(result.filename.startsWith(`${fixturePack}/`));
    const productManifest = JSON.parse(
      execFileSync("tar", ["-xOf", result.filename, "package/package.json"], {
        encoding: "utf8",
      }),
    );
    assert.equal(productManifest.name, expectedName);
    assert.equal(productManifest.version, sourceManifest.version);
    assert.doesNotMatch(JSON.stringify(productManifest), /\b(?:catalog|workspace):/);
  }

  const npmCache = join(fixtureRoot, "npm-cache");
  const npmUserConfig = join(fixtureRoot, "npmrc");
  const npmEnv = {
    ...process.env,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_cache: npmCache,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    npm_config_userconfig: npmUserConfig,
    NPM_CONFIG_OFFLINE: "true",
    npm_config_offline: "true",
    NPM_CONFIG_LOGLEVEL: "silent",
    npm_config_loglevel: "silent",
  };
  delete npmEnv.NODE_AUTH_TOKEN;
  const publishResult = JSON.parse(
    execFileSync(
      "npm",
      [
        "publish",
        packResult.filename,
        "--dry-run",
        "--json",
        "--access",
        "public",
        "--provenance",
        "--tag",
        "next",
      ],
      { cwd: fixtureRoot, encoding: "utf8", env: npmEnv },
    ),
  );
  // npm 11.19 keys publish results by package name; earlier npm 11 returns
  // the package object directly. Both must identify the one packed fixture.
  const publishedPackage = publishResult[fixtureManifest.name] ?? publishResult;
  if (publishedPackage !== publishResult)
    assert.deepEqual(Object.keys(publishResult), [fixtureManifest.name]);
  assert.equal(publishedPackage.id, `${fixtureManifest.name}@${fixtureManifest.version}`);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("Ferriki release workflow command and order contract verified");
