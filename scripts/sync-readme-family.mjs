// The family block in the npm package README is generated from the pinned
// Family2 Markdown frame. The root README has its own mdtheme frame and pin in
// mdtheme.yaml; this script checks only the npm README's compact link list.
//
// The frame is plain Markdown fetched from the exact Family commit. It is
// parsed as data; no code from the Family repository is executed.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The registry pin for the npm package README. The root README has its own
// Ferramenta ref in mdtheme.yaml. Bump this pin to adopt registry changes,
// then rerun the script without `--check` and commit the regenerated block.
const REGISTRY_PIN = "a15da378c7898af2bbcac9a2233601bfe057aa0d";
const FRAME_PATH = "packages/family/markdown/ferriki/footer.md";
const FRAME_URL = `https://raw.githubusercontent.com/sebastian-software/ferramenta/${REGISTRY_PIN}/${FRAME_PATH}`;
const TOOL = "ferriki";
const START = "<!-- ferramenta-family:start -->";
const END = "<!-- ferramenta-family:end -->";
const TARGETS = ["node/ferriki/README.md"];
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function readFamilyFrame(frame) {
  const familyLine = frame.match(/^\[Ferramenta\]\((https?:\/\/[^)]+)\) — (.+)$/mu);
  if (!familyLine) throw new Error("Pinned Family2 frame has no Ferramenta intro line.");

  const siblings = [
    ...frame.matchAll(/^\| \[([^\]]+)\]\((https?:\/\/[^)]+)\) \| ([^|]+) \|$/gmu),
  ].map(([, name, href, job]) => ({ name, href, job: job.trim() }));
  const names = siblings.map(({ name }) => name);
  if (siblings.length === 0 || new Set(names).size !== names.length || names.includes(TOOL)) {
    throw new Error(
      "Pinned Family2 frame has an empty, duplicate, or self-referential sibling list.",
    );
  }

  return {
    familyUrl: familyLine[1],
    familyDescription: familyLine[2],
    siblings,
  };
}

function renderBlock({ familyUrl, familyDescription, siblings }) {
  const siblingLinks = siblings
    .map(({ name, href, job }) => `[${name}](${href}) — ${job}`)
    .join(" · ");

  return [
    START,
    "",
    `**${TOOL}** is part of the [Ferramenta](${familyUrl}) family — ${familyDescription}`,
    "",
    `Siblings: ${siblingLinks}.`,
    END,
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--check" && arg !== "--write");
  if (unknown.length > 0) {
    console.error(`[sync-readme-family] unknown argument: ${unknown.join(" ")}`);
    console.error("usage: node scripts/sync-readme-family.mjs [--check | --write]");
    process.exitCode = 2;
    return;
  }

  const mode = args.includes("--check") ? "--check" : "--write";
  const response = await fetch(FRAME_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(
      `Could not read pinned Family2 frame: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const family = readFamilyFrame(await response.text());
  const replacement = renderBlock(family);
  let failed = false;

  for (const target of TARGETS) {
    const path = join(repoRoot, target);
    const readme = await readFile(path, "utf8");
    const blocks = [
      ...readme.matchAll(
        /<!-- ferramenta-family:start -->[\s\S]*?<!-- ferramenta-family:end -->/gu,
      ),
    ];
    if (blocks.length !== 1)
      throw new Error(`${target} must have exactly one Ferramenta family block.`);

    const updated = readme.replace(blocks[0][0], replacement);
    if (updated === readme) continue;

    failed = true;
    if (mode === "--write") await writeFile(path, updated);
    else
      console.error(
        `[sync-readme-family] ${target} is out of date — rerun \`node scripts/sync-readme-family.mjs\``,
      );
  }

  if (failed && mode === "--check") {
    process.exitCode = 1;
    return;
  }

  console.log(
    `[sync-readme-family] ${mode === "--check" ? "verified" : "wrote"} ${TARGETS.length} npm README family block from registry pin ${REGISTRY_PIN.slice(0, 7)}`,
  );
}

main().catch((error) => {
  console.error(`[sync-readme-family] ${error.message}`);
  process.exitCode = 2;
});
