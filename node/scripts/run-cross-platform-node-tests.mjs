import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { coreCompatSupportedHtmlTests } from "../compat/harness/core-compat-manifest.mjs";
import "./test-asset-env.mjs";

const nodeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestBin = path.join(nodeRoot, "node_modules/vitest/vitest.mjs");
// Without `build:compat`, `@shikijs/langs/cpp` resolves via Ferriki's curated
// catalog loader (ADR 0020, no `glsl`), so skip `requires nested lang` here;
// the full `build:compat` upstream suite still runs in `core-compat` on Ubuntu.
const coreCompatTestPattern =
  "^(?!.*(?:should have correct offset|requires nested lang))(should|langAlias|getSingletonHighlighter)";

function runStep(label, command, args, options = {}) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: nodeRoot,
    env: {
      ...process.env,
      FERRIKI_HONEST_ALIAS: "1",
    },
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runVitest(label, args) {
  // Invoke Vitest directly with Node (shell: false) so regex characters in `-t`
  // patterns are never interpreted by cmd.exe on Windows.
  runStep(label, process.execPath, [vitestBin, "run", ...args]);
}

runStep("Asset hardening and protected asset tests", process.execPath, [
  "--test",
  "./scripts/test-asset-hardening.mjs",
  "./scripts/test-protected-assets.mjs",
]);

runStep("Remote asset cache, locking, and download concurrency checks", process.execPath, [
  "./scripts/check-ferriki-remote-assets.mjs",
]);

for (const script of [
  "./scripts/check-ferriki-catalog.mjs",
  "./scripts/check-ferriki-exports.mjs",
  "./scripts/check-ferriki-api-contract.mjs",
  "./scripts/check-native-boundary.mjs",
  "./scripts/check-native-results.mjs",
  "./scripts/check-ferriki-errors.mjs",
  "./scripts/check-ferriki-registrations.mjs",
  "./scripts/check-ferriki-transformers.mjs",
  "./scripts/check-native-decorations.mjs",
  "./scripts/check-native-declarative-render.mjs",
  "./scripts/check-class-highlighting.mjs",
  "./scripts/check-ferriki-token-state.mjs",
]) {
  runStep(`Node runtime check: ${script}`, process.execPath, [script]);
}

runVitest("Mirrored compatibility honest-alias sentinel", [
  "compat/harness/honest-alias.test.ts",
  "--maxWorkers",
  "1",
  "--no-file-parallelism",
]);

runVitest("Mirrored core compatibility tests", [
  "compat/upstream/shiki/packages/core/test/core-sync.test.ts",
  "compat/upstream/shiki/packages/core/test/core.test.ts",
  "compat/upstream/shiki/packages/core/test/get-singleton.test.ts",
  "compat/upstream/shiki/packages/shiki/test/alias.test.ts",
  "-t",
  coreCompatTestPattern,
  "--maxWorkers",
  "1",
  "--no-file-parallelism",
]);

for (const test of coreCompatSupportedHtmlTests) {
  runVitest(`Mirrored HTML compatibility: ${test.path}`, [
    test.path,
    "-t",
    test.testNamePattern,
    "--maxWorkers",
    "1",
    "--no-file-parallelism",
  ]);
}

runStep("Web component and SSR tests", process.execPath, [
  "--test",
  "./scripts/test-web-component.mjs",
  "./scripts/test-web-component-server.mjs",
]);

runVitest("Vite adapter tests", ["vite/test"]);

console.log(`\nFerriki cross-platform Node suite passed on ${process.platform}/${process.arch}`);
