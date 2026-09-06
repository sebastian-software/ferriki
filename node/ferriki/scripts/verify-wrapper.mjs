import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WRAPPER_RUNTIME, WRAPPER_TYPES } from "./wrapper-contents.mjs";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const required = [
  join(pkgDir, "index.mjs"),
  join(pkgDir, "native.mjs"),
  join(pkgDir, "src", "api.mts"),
  join(pkgDir, "src", "api.d.mts"),
  join(pkgDir, "src", "index.mjs"),
];

for (const file of required) await access(file);

const [runtime, types] = await Promise.all([
  readFile(join(pkgDir, "index.mjs"), "utf8"),
  readFile(join(pkgDir, "index.d.mts"), "utf8"),
]);

if (runtime !== WRAPPER_RUNTIME || types !== WRAPPER_TYPES) {
  throw new Error(
    "Generated Ferriki wrapper files are stale; run `pnpm run build` and commit the result.",
  );
}
