import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const candidate = path.resolve(process.argv[2]);
const report = JSON.parse(await readFile(path.join(candidate, "report.json"), "utf8"));
const output = path.join(candidate, "diffs");
await mkdir(output, { recursive: true });
const empty = path.join(output, "empty");
await writeFile(empty, "");
for (const change of report.changes) {
  const relative = `assets/upstream/curated/grammars/${change.id}.json`;
  const result = spawnSync(
    "git",
    [
      "diff",
      "--no-index",
      "--",
      change.added ? empty : path.join(root, relative),
      change.removed ? empty : path.join(candidate, relative),
    ],
    { encoding: "utf8" },
  );
  if (![0, 1].includes(result.status)) throw new Error(`Cannot generate review diff: ${change.id}`);
  await writeFile(path.join(output, `${change.id}.diff`), result.stdout);
}
console.log(`Wrote ${report.changes.length} normalized grammar review diffs.`);
