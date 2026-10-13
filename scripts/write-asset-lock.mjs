import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const file = path.join(root, "assets/catalog.json");
const old = JSON.parse(await readFile(file, "utf8"));
const { languageCatalog, themeCatalog } = await import(
  pathToFileURL(path.join(root, "assets/standard/catalog.mjs"))
);
const release = JSON.parse(
  await readFile(path.join(root, "assets/standard/release-manifest.json"), "utf8"),
);
release.storageLayout = "language-hash-v2";
const entries = (rows) =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()),
        value,
      ]),
    ),
  );
const next = {
  ...old,
  languages: { ...old.languages, entries: entries(languageCatalog) },
  themes: { ...old.themes, entries: entries(themeCatalog) },
  release,
};
await writeFile(file, JSON.stringify(next, null, 2) + "\n");
await writeFile(
  path.join(root, "assets/standard/release-manifest.json"),
  JSON.stringify(release, null, 2) + "\n",
);
console.log("Updated the reviewed catalog metadata lock.");
