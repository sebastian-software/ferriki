import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(new URL("../assets/catalog.json", import.meta.url), "utf8"));
const source = lock.languages.source;

function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${script} failed (${result.status ?? result.error})`);
}

// Source materialization uses pinned digests; generated payloads need not exist
// on the CDN yet. Never rewrite the reviewed lock to match a local producer.
run("scripts/materialize-assets.mjs", ["--sources", "--metadata-only"]);
const args = ["--source-name", source.upstream];
if (source.version) args.push("--source-version", source.version);
if (source.commit) args.push("--source-commit", source.commit);
run("scripts/generate-ferriki-assets.mjs", args);
run("scripts/publish-assets.mjs", ["--check"]);
// Generation writes its own indexes; restore the reviewed release metadata only
// after every generated payload matches the trusted lock's digest and size.
run("scripts/materialize-assets.mjs", ["--metadata-only"]);
