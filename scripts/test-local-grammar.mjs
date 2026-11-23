import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digest } from "./grammar-repositories.mjs";
import { localGrammarPath, readLocalGrammar, validateLocalGrammarEntry } from "./local-grammar.mjs";

const root = await mkdtemp(path.join(tmpdir(), "ferriki-local-grammar-"));
try {
  const file = "assets/grammars/local/example.tmLanguage.json";
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  const bytes = Buffer.from('{"scopeName":"source.example","patterns":[]}\n');
  await writeFile(path.join(root, file), bytes);
  assert.deepEqual(await readLocalGrammar(root, file, digest(bytes)), bytes);
  await assert.rejects(readLocalGrammar(root, file, "0".repeat(64)), /digest mismatch/);
  for (const invalid of [
    "../x",
    "assets/grammars/local/../outside.tmLanguage.json",
    "/tmp/a",
    "assets/grammars/local/a.json",
  ])
    assert.throws(() => localGrammarPath(invalid), /Invalid local grammar path/);
  const entry = {
    id: "example",
    repository_id: "local",
    source: file,
    upstream_path: file,
    license: "MIT",
    license_url: "LICENSE-MIT",
  };
  validateLocalGrammarEntry(entry);
  assert.throws(
    () => validateLocalGrammarEntry({ ...entry, upstream_commit: "0".repeat(40) }),
    /provenance/,
  );
  assert.throws(
    () => validateLocalGrammarEntry({ ...entry, source: "https://example.com" }),
    /provenance/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("First-party grammar paths, provenance and digest checks verified.");
