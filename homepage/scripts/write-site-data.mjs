/* eslint-disable security/detect-non-literal-fs-filename -- Fixed repository reports and the release manifest are local build inputs. */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { format } from "oxfmt";

const manifest = JSON.parse(
  await readFile(new URL("../../node/ferriki/package.json", import.meta.url), "utf8"),
);
// The minimum toolchains: Cargo.toml's workspace rust-version and the npm engines field.
const cargo = await readFile(new URL("../../Cargo.toml", import.meta.url), "utf8");
const rustVersion = /^rust-version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
const nodeVersion = /^>=\s*(\S+)$/.exec(manifest.engines?.node ?? "")?.[1];
if (rustVersion === undefined || nodeVersion === undefined) {
  throw new Error("Cargo.toml and the npm manifest must state a minimum Rust and Node.js version");
}
// The standard theme catalog the release ships.
const catalog = JSON.parse(
  await readFile(new URL("../../assets/catalog.json", import.meta.url), "utf8"),
);
const themeCount = catalog.theme_sources.length;
await writeFile(
  new URL("../app/data/site.json", import.meta.url),
  `${JSON.stringify({ version: manifest.version, rustVersion, nodeVersion, themeCount }, null, 2)}\n`,
);

// Keep browser modules inside the documentation package. These snapshots are
// generated from the same verified reports the evidence publishers own.
const reports = [
  "blacksmith-comparison",
  "shiki-comparison",
  "regex-modes-comparison",
  "blacksmith-memory",
];
const destination = new URL("../app/data/evidence/", import.meta.url);
await mkdir(destination, { recursive: true });
await Promise.all(
  reports.map(async (name) => {
    const source = new URL(`../../docs/benchmarks/${name}.json`, import.meta.url);
    const result = await format(`${name}.json`, await readFile(source, "utf8"));
    if (result.errors.length > 0) throw new Error(`Cannot format the verified ${name} report`);
    await writeFile(new URL(`${name}.json`, destination), result.code);
  }),
);

// The lifecycle illustration remains authored in docs; mirror it for Ardo's package boundary.
await copyFile(
  new URL("../../docs/assets/code-element-lifecycle-v2.png", import.meta.url),
  new URL("../app/data/code-element-lifecycle-v2.png", import.meta.url),
);
