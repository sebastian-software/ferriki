import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  discoverRepository,
  grammarChanges,
  parseSubmodules,
  rawUrl,
  resolveRepositorySnapshots,
  selectCandidate,
} from "./grammar-repositories.mjs";

const first = "a".repeat(40);
const second = "b".repeat(40);
const child = "c".repeat(40);
const calls = [];
const apiValues = {
  "repos/example/editor/commits/HEAD": { sha: first },
  [`repos/example/editor/git/trees/${first}?recursive=1`]: {
    tree: [{ type: "blob", path: "extensions/demo/package.json" }],
  },
  "repos/example/collection/commits/HEAD": { sha: second },
  [`repos/example/collection/git/trees/${second}?recursive=1`]: {
    tree: [{ type: "commit", path: "vendor/grammars/demo", sha: child }],
  },
  [`repos/example/demo/git/trees/${child}?recursive=1`]: {
    tree: [
      { type: "blob", path: "grammars/demo.cson" },
      { type: "blob", path: "grammars/tree-sitter.cson" },
      { type: "blob", path: "tests/fixture.json" },
    ],
  },
};
const files = {
  [`example/editor@${first}/extensions/demo/package.json`]: JSON.stringify({
    scripts: { postinstall: 'throw new Error("never execute")' },
    contributes: {
      grammars: [
        { language: "demo", scopeName: "source.demo", path: "./syntaxes/demo.tmLanguage.json" },
        { language: "demo-alt", scopeName: "source.demo", path: "./syntaxes/demo.tmLanguage.json" },
      ],
    },
  }),
  [`example/collection@${second}/.gitmodules`]:
    '[submodule "demo"]\n path = vendor/grammars/demo\n url = https://github.com/example/demo.git\n',
  [`example/demo@${child}/grammars/demo.cson`]: "scopeName: 'source.special'\npatterns: []",
  [`example/demo@${child}/grammars/tree-sitter.cson`]:
    "scopeName: 'source.unsupported'\ntype: 'tree-sitter'",
};
const reader = {
  async api(endpoint) {
    calls.push(endpoint);
    assert(Object.hasOwn(apiValues, endpoint), endpoint);
    return apiValues[endpoint];
  },
  async read(repository, commit, file) {
    const key = `${repository}@${commit}/${file}`;
    assert(Object.hasOwn(files, key), key);
    return Buffer.from(files[key]);
  },
};
const editor = {
  id: "editor",
  repository: "example/editor",
  ref: "HEAD",
  adapter: "vscode",
  license: { id: "MIT", path: "LICENSE" },
};
const collection = {
  id: "collection",
  repository: "example/collection",
  ref: "HEAD",
  adapter: "linguist",
  modules: ["vendor/grammars/demo"],
  paths: { "vendor/grammars/demo": ["grammars/"] },
  module_licenses: { "vendor/grammars/demo": { id: "MIT", path: "LICENSE" } },
};
const config = { repositories: [editor, collection] };
const snapshots = await resolveRepositorySnapshots(config, reader);
assert.equal(snapshots.editor.commit, first);
assert.equal(snapshots.collection.modules["vendor/grammars/demo"].commit, child);
assert.equal(calls.filter((call) => call.includes("/commits/")).length, 2);
calls.length = 0;
assert.deepEqual(await resolveRepositorySnapshots(config, reader, snapshots), snapshots);
assert(
  !calls.some((call) => call.includes("/commits/")),
  "locked replay never resolves a moving ref",
);
const candidates = await discoverRepository(editor, snapshots.editor, reader);
assert.equal(candidates.length, 1, "one file shared by two editor IDs is not ambiguous");
assert.equal(candidates[0].path, "extensions/demo/syntaxes/demo.tmLanguage.json");
const special = await discoverRepository(collection, snapshots.collection, reader);
assert.equal(special.length, 1, "Tree-sitter descriptors are not TextMate grammars");
assert.equal(special[0].scope, "source.special");
assert.equal(
  selectCandidate(special, { module: "vendor/grammars/demo", scope: "source.special" }).commit,
  child,
);
assert.throws(
  () => selectCandidate(special, { module: "vendor/grammars/demo", scope: "source.missing" }),
  /found 0/,
);
assert.throws(() => rawUrl("example/demo", child, "../outside"), /Unsafe/);
assert.equal(
  parseSubmodules(files[`example/collection@${second}/.gitmodules`]).get("vendor/grammars/demo"),
  "example/demo",
);
const wrongLock = structuredClone(snapshots);
wrongLock.collection.modules["vendor/grammars/demo"].commit = first;
await assert.rejects(resolveRepositorySnapshots(config, reader, wrongLock), /lock drift/);
await assert.rejects(
  resolveRepositorySnapshots({ repositories: [{ ...editor, ref: "release" }] }, reader, snapshots),
  /configuration drift/,
);
calls.length = 0;
await assert.rejects(
  resolveRepositorySnapshots(
    { repositories: [...config.repositories, { ...editor, id: "added" }] },
    reader,
    snapshots,
  ),
  /configuration drift/,
);
assert.equal(calls.length, 0, "locked replay rejects a new source before resolving any moving ref");
await assert.rejects(
  resolveRepositorySnapshots(
    { repositories: [editor, { ...collection, modules: [] }] },
    reader,
    snapshots,
  ),
  /configuration drift/,
);
const unchanged = {
  id: "demo",
  sha256: "normalized",
  upstream_sha256: "raw",
  upstream_commit: first,
  repository_id: "editor",
  upstream_path: "grammar.json",
  license: "MIT",
};
assert.deepEqual(
  grammarChanges([unchanged], [{ ...unchanged, upstream_commit: second }]),
  [],
  "unrelated branch movement creates no payload update",
);
assert.equal(
  grammarChanges([unchanged], [{ ...unchanged, license: "BSD-3-Clause" }]).length,
  1,
  "license changes remain reviewable",
);
assert.equal(
  grammarChanges([unchanged], [{ ...unchanged, upstream_path: "renamed.json" }]).length,
  1,
  "source relocation updates provenance",
);
assert.equal(
  grammarChanges([unchanged], [])[0].removed,
  true,
  "removing the only selected language still creates an update",
);
apiValues[`repos/example/editor/git/trees/${first}?recursive=1`].truncated = true;
await assert.rejects(discoverRepository(editor, snapshots.editor, reader), /Truncated/);
console.log(
  "Repository snapshots, manifest discovery, aggregate pins, and locked replay verified.",
);
