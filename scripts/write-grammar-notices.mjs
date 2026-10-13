import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const { languages } = JSON.parse(
  await readFile(new URL("assets/grammars/sources.json", root), "utf8"),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(new URL("assets/standard", root), { recursive: true });
const notices = [
  "# Third-party grammar notices",
  "",
  "Ferriki standard grammars come from the following pinned sources. The notices below apply to grammar data, separately from Ferriki's own license.",
  "",
];
for (const file of [...new Set(languages.map((entry) => entry.license_file))].sort()) {
  const text = await readFile(new URL(file, root), "utf8");
  if (!file.endsWith(`${digest(text)}.txt`)) throw new Error(`License notice drift: ${file}`);
  const entries = languages.filter((entry) => entry.license_file === file);
  notices.push(`## ${entries.map((entry) => entry.id).join(", ")}`, "");
  for (const entry of entries)
    notices.push(`- [${entry.id}](${entry.source}) — [${entry.license}](${entry.license_url})`);
  notices.push("", text.trim(), "");
}
const noticeFile = new URL("assets/standard/GRAMMAR-NOTICES.md", root);
const noticeText = `${notices.join("\n")}\n`;
await writeFile(noticeFile, noticeText);
