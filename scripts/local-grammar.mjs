import { readFile } from "node:fs/promises";
import path from "node:path";
import { digest } from "./grammar-repositories.mjs";

// Local grammars are reviewed source, not generated artifacts or repository pins.
export function localGrammarPath(file) {
  if (!/^assets\/grammars\/local\/[a-z0-9-]+\.tmLanguage\.json$/.test(file))
    throw new Error(`Invalid local grammar path: ${file}`);
  return file;
}

export async function readLocalGrammar(root, file, expected) {
  const bytes = await readFile(path.join(root, localGrammarPath(file)));
  if (bytes.length > 8 * 1024 * 1024) throw new Error(`Local grammar exceeds 8 MiB: ${file}`);
  if (expected && digest(bytes) !== expected)
    throw new Error(`Local grammar digest mismatch: ${file}`);
  return bytes;
}

export function validateLocalGrammarEntry(entry) {
  if (
    entry.repository_id !== "local" ||
    entry.source !== localGrammarPath(entry.upstream_path) ||
    entry.license !== "MIT" ||
    entry.license_url !== "LICENSE-MIT" ||
    entry.module ||
    entry.upstream_commit ||
    entry.upstream_repository
  )
    throw new Error(`Invalid local grammar provenance: ${entry.id}`);
}
