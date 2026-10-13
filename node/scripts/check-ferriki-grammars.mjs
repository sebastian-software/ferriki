import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { languageCatalog } from "../ferriki/assets/standard/catalog.mjs";
import { bundledLanguages, createHighlighter } from "../ferriki/index.mjs";
import { createEngine, validateOutput } from "./tiobe-benchmark.mjs";
import "./test-asset-env.mjs";

const sources = JSON.parse(
  await readFile(new URL("../../assets/grammars/sources.json", import.meta.url), "utf8"),
);
assert.deepEqual(
  languageCatalog.map((entry) => entry.id),
  sources.languages.map((entry) => entry.id),
);
for (const id of [
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "javascript",
  "typescript",
  "php",
  "ruby",
  "sql",
  "html",
  "css",
  "vue",
  "svelte",
  "astro",
  "markdown",
  "json",
  "yaml",
  "toml",
  "shellscript",
  "docker",
  "hcl",
  "zig",
  "elixir",
  "gleam",
  "luau",
  "nix",
  "gdscript",
])
  assert(Object.hasOwn(bundledLanguages, id), `${id} must work out of the box`);
assert(
  !Object.hasOwn(bundledLanguages, "ada"),
  "grammars with GPL or missing licensing are external inputs",
);

const highlighter = await createHighlighter({
  langs: languageCatalog.map((entry) => entry.id),
  themes: ["nord"],
});
try {
  for (const entry of languageCatalog) {
    const html = highlighter.codeToHtml("TODO 123", { lang: entry.id, theme: "nord" });
    assert.match(html, /TODO/);
    assert.match(html, /123/);
  }
} finally {
  highlighter.dispose();
}

// Exercise language features and automatic dependencies, rather than accepting
// a grammar that merely compiles or silently falls back to uncolored text.
const examples = {
  zig: `const std = @import("std");
pub fn main() !void {
    const answer: u32 = 42;
    std.debug.print("Answer: {d}\\n", .{answer});
}`,
  elixir: `defmodule Greeter do
  def greet(name), do: "Hello #{name}"
end
template = ~E"""
<section><%= Greeter.greet("World") %></section>
"""`,
  gleam: `import gleam/io
pub fn main() {
  let greeting = "Hello <World> & friends"
  io.println(greeting)
}`,
  luau: `type Greeting = { message: string }
local function greet(name: string): Greeting
  return { message = "Hello " .. name }
end
print(greet("World").message)`,
  nix: `{ pkgs, ... }:
let
  greeting = "Hello";
in {
  environment.systemPackages = with pkgs; [ git ];
  environment.variables.MESSAGE = "\${greeting} <World>";
}`,
  gdscript: `extends Node
@export var speed: float = 10.0
func _ready() -> void:
    print("Hello <World> & friends")`,
};
for (const [textmate, code] of Object.entries(examples)) {
  const native = await createEngine("ferriki", { textmate });
  let reference;
  try {
    reference = await createEngine("shiki-wasm", { textmate });
    const expected = reference.html(code);
    const actual = native.html(code);
    const validation = validateOutput("ferriki", code, actual, { html: expected });
    assert.equal(validation.sourcePreserved, true, textmate);
    assert.equal(validation.highlighted, true, textmate);
    assert.deepEqual(validation.referenceParity, { html: true }, textmate);
  } finally {
    native.dispose();
    reference?.dispose();
  }
}
const aliasHighlighter = await createHighlighter({ langs: ["ex", "gd"], themes: ["nord"] });
try {
  for (const [id, aliases] of [
    ["elixir", ["ex", "exs"]],
    ["gdscript", ["gd"]],
  ]) {
    const expected = aliasHighlighter.codeToHtml(examples[id], { lang: id, theme: "nord" });
    for (const alias of aliases)
      assert.equal(
        aliasHighlighter.codeToHtml(examples[id], { lang: alias, theme: "nord" }),
        expected,
      );
  }
} finally {
  aliasHighlighter.dispose();
}

const directory = await mkdtemp(join(tmpdir(), "ferriki-grammar-"));
const grammar = JSON.stringify({
  name: "A human-readable upstream name",
  scopeName: "source.external-example",
  $schema: "https://example.invalid/schema",
  patterns: [{ match: "\\bTODO\\b", name: "keyword.control" }],
});
const digest = createHash("sha256").update(grammar).digest("hex");
const server = createServer((request, response) => {
  if (request.url === "/grammar.json") response.end(grammar);
  else {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const input = `http://127.0.0.1:${server.address().port}/grammar.json`;
const cli = fileURLToPath(new URL("../ferriki/grammar.mjs", import.meta.url));
const run = promisify(execFile);
try {
  const output = join(directory, "external.json");
  await run(process.execPath, [
    cli,
    "grammar",
    "fetch",
    input,
    "--name",
    "external-example",
    "--aliases",
    "external",
    "--sha256",
    digest,
    "--output",
    output,
  ]);
  const registration = JSON.parse(await readFile(output, "utf8"));
  const lock = JSON.parse(await readFile(`${output}.lock.json`, "utf8"));
  assert.equal(lock.sha256, digest);
  assert.equal(lock.source, input);
  assert.equal(registration.$schema, undefined);
  assert.equal(registration.name, "external-example");
  const custom = await createHighlighter({ langs: [registration], themes: ["nord"] });
  try {
    assert.match(custom.codeToHtml("TODO", { lang: "external", theme: "nord" }), /color:/);
  } finally {
    custom.dispose();
  }
  await assert.rejects(
    run(process.execPath, [
      cli,
      "grammar",
      "fetch",
      input,
      "--name",
      "example",
      "--sha256",
      "0".repeat(64),
    ]),
    /SHA-256 mismatch/,
  );
  await assert.rejects(
    run(process.execPath, [
      cli,
      "grammar",
      "fetch",
      input,
      "--name",
      "example",
      "--output",
      output,
    ]),
    /EEXIST/,
  );
  const blocked = join(directory, "blocked.json");
  await writeFile(`${blocked}.lock.json`, "existing provenance");
  await assert.rejects(
    run(process.execPath, [
      cli,
      "grammar",
      "fetch",
      input,
      "--name",
      "example",
      "--output",
      blocked,
    ]),
    /EEXIST/,
  );
  await assert.rejects(access(blocked), /ENOENT/);
  assert.equal(await readFile(`${blocked}.lock.json`, "utf8"), "existing provenance");
  await assert.rejects(
    run(process.execPath, [
      cli,
      "grammar",
      "fetch",
      "github:owner/repo@main/grammar.json",
      "--name",
      "example",
    ]),
    /40-character-commit/,
  );
  const invalid = join(directory, "invalid.json");
  await writeFile(
    invalid,
    JSON.stringify({ scopeName: "source.invalid", patterns: [{ match: "(", name: "keyword" }] }),
  );
  await assert.rejects(
    run(process.execPath, [cli, "grammar", "fetch", invalid, "--name", "example"]),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
console.log(
  `Ferriki grammar coverage and external imports verified: ${languageCatalog.length} grammars`,
);
