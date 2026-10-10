import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const resultRoot = join(repoRoot, "node/benchmarks/curated/results/prism-investigation");
const privateOriginals = join(resultRoot, "private-originals");
const manifestPath = join(resultRoot, "path-redactions.json");
const capturedContext = readFileSync(join(resultRoot, "profiles/window-context.txt"), "utf8");
const capturedHost = capturedContext.match(/^host=Darwin ([^ ]+)/m)?.[1];

if (!capturedHost) throw new Error("Could not identify the captured host name.");
if (existsSync(manifestPath))
  throw new Error(
    `${relative(repoRoot, manifestPath)} already exists; refusing to overwrite its mapping.`,
  );

const replacements = [
  { label: "worktree checkout prefix", from: `${repoRoot}${sep}`, to: "/WORKTREE/ferriki/" },
  { label: "captured Cargo registry prefix", from: `${homedir()}/.cargo/`, to: "$CARGO_HOME/" },
  { label: "captured host name", from: capturedHost, to: "<capture-host>" },
];
const textExtensions = new Set([".json", ".log", ".txt"]);
const manifestRows = [];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (fullPath === privateOriginals) return [];
      return walk(fullPath);
    }
    return [fullPath];
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function redact(text) {
  let result = text;
  for (const replacement of replacements)
    result = result.split(replacement.from).join(replacement.to);
  return result;
}

function backupOriginal(fullPath, bytes) {
  const backupPath = join(privateOriginals, relative(resultRoot, fullPath));
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(fullPath, backupPath, 0);
  if (sha256(readFileSync(backupPath)) !== sha256(bytes))
    throw new Error(`Private original verification failed: ${relative(resultRoot, fullPath)}`);
}

for (const fullPath of walk(resultRoot).sort()) {
  if (fullPath === manifestPath || !textExtensions.has(fullPath.slice(fullPath.lastIndexOf("."))))
    continue;
  const original = readFileSync(fullPath);
  const originalText = original.toString("utf8");
  const publishedText = redact(originalText);
  if (publishedText === originalText) continue;
  backupOriginal(fullPath, original);
  writeFileSync(fullPath, publishedText);
  manifestRows.push({
    path: relative(resultRoot, fullPath),
    originalSha256: sha256(original),
    publishedSha256: null,
  });
}

const publicIndexPath = join(resultRoot, "profiles/current/index.json");
if (existsSync(publicIndexPath)) {
  const index = JSON.parse(readFileSync(publicIndexPath, "utf8"));
  for (const capture of index.captures ?? []) {
    for (const artifact of capture.artifacts ?? []) {
      const artifactPath = join(dirname(publicIndexPath), artifact.path);
      if (!existsSync(artifactPath))
        throw new Error(`Indexed artifact is missing: ${artifact.path}`);
      const bytes = readFileSync(artifactPath);
      artifact.bytes = bytes.byteLength;
      artifact.sha256 = sha256(bytes);
    }
  }
  index.pathRedactionsManifest = "../../path-redactions.json";
  index.publicationRedaction = {
    normalizer: "node/scripts/normalize-prism-artifacts.mjs",
    scope:
      "Generated JSON, log, and text artifacts only; samples, timings, symbols, UUIDs, and binary/fixture identities are retained.",
    replacements: replacements.map(({ label, to }) => ({ label, to })),
    originals:
      "Private pre-normalization copies are retained in the locally ignored private-originals/ directory.",
  };
  writeFileSync(publicIndexPath, `${JSON.stringify(index, null, 2)}\n`);
  const indexRow = manifestRows.find((row) => row.path === "profiles/current/index.json");
  if (indexRow) indexRow.publishedSha256 = sha256(readFileSync(publicIndexPath));
}

for (const row of manifestRows) {
  if (row.publishedSha256 === null)
    row.publishedSha256 = sha256(readFileSync(join(resultRoot, row.path)));
}

const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
const absoluteExcludePath = resolve(repoRoot, excludePath);
const ignorePattern = "/node/benchmarks/curated/results/prism-investigation/private-originals/";
const excludeText = existsSync(absoluteExcludePath)
  ? readFileSync(absoluteExcludePath, "utf8")
  : "";
if (!excludeText.split(/\r?\n/).includes(ignorePattern)) {
  writeFileSync(
    absoluteExcludePath,
    `${excludeText}${excludeText.endsWith("\n") || excludeText.length === 0 ? "" : "\n"}${ignorePattern}\n`,
  );
}

const privateMarker = join(privateOriginals, ".keep");
if (!existsSync(privateMarker))
  writeFileSync(
    privateMarker,
    "Private pre-normalization originals for the local investigation only.\n",
  );
const ignored = execFileSync(
  "git",
  ["check-ignore", "--quiet", relative(repoRoot, privateMarker)],
  { cwd: repoRoot, stdio: "ignore" },
);
void ignored;

const manifest = {
  schema: 1,
  normalizer: "node/scripts/normalize-prism-artifacts.mjs",
  rules: replacements.map(({ label, to }) => ({ label, to })),
  files: manifestRows.sort((a, b) => a.path.localeCompare(b.path)),
  preservation:
    "Only exact local path/host strings were replaced. Profile samples, timing samples, symbols, UUIDs, source fixtures, and binary identities were retained; artifact hashes distinguish captured originals from published normalized files.",
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Path-redacted ${manifest.files.length} artifacts; original copies are ignored under ${relative(repoRoot, privateOriginals)}.`,
);
