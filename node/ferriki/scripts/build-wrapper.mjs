import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { WRAPPER_RUNTIME, WRAPPER_TYPES } from "./wrapper-contents.mjs";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const nodeRoot = dirname(packageDir);
const generatedDir = join(nodeRoot, ".generated", "ferriki");
const generatedTypes = join(generatedDir, "api.d.mts");
const sourceTypes = join(packageDir, "src", "api.d.mts");

await mkdir(generatedDir, { recursive: true });

const typecheck = spawnSync(
  "pnpm",
  ["exec", "tsc", "--project", join(nodeRoot, "tsconfig.api.json")],
  {
    cwd: nodeRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
  },
);

if (typecheck.error) throw typecheck.error;
if (typecheck.status !== 0) process.exit(typecheck.status ?? 1);

await writeFile(sourceTypes, await readFile(generatedTypes));

// tsc indents its declaration output with four spaces. The checked-in copy is
// formatted by oxfmt through the workspace's managed `.oxfmtrc.json`, so format
// it here rather than let `format:check` fail on a generated file.
const format = spawnSync("pnpm", ["exec", "oxfmt", "--write", sourceTypes], {
  cwd: nodeRoot,
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (format.error) throw format.error;
if (format.status !== 0) process.exit(format.status ?? 1);

// The two wrapper files are written in the shape oxfmt produces, so that
// `pnpm run build` and `pnpm run format:check` agree on them.
await writeFile(join(packageDir, "index.mjs"), WRAPPER_RUNTIME);
await writeFile(join(packageDir, "index.d.mts"), WRAPPER_TYPES);

console.log("[ferriki] Generated public runtime wrapper and declarations");
