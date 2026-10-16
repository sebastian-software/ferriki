import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packages = { shiki: "shiki-benchmark", prismjs: "prismjs" };

export function installedComparators() {
  return Object.fromEntries(
    Object.entries(packages).map(([name, alias]) => [
      name,
      JSON.parse(
        readFileSync(new URL(`../node_modules/${alias}/package.json`, import.meta.url), "utf8"),
      ).version,
    ]),
  );
}

export async function checkCurrentComparators(installed, fetchVersion = fetch) {
  const versions = await Promise.all(
    Object.keys(packages).map(async (name) => {
      const response = await fetchVersion(`https://registry.npmjs.org/${name}/latest`, {
        signal: AbortSignal.timeout(30_000),
      });
      assert.ok(response.ok, `Cannot check current ${name}: HTTP ${response.status}`);
      const { version } = await response.json();
      assert.match(version, /^\d+\.\d+\.\d+$/, `No stable ${name} release returned`);
      assert.equal(
        installed[name],
        version,
        `Benchmark comparator ${name} is outdated; update its exact catalog pin and lockfile before measuring`,
      );
      return [name, version];
    }),
  );
  return Object.fromEntries(versions);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkCurrentComparators(installedComparators())));
}
