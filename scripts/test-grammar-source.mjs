import assert from "node:assert/strict";
import { applyGrammarPatches, parseGrammarSource } from "./grammar-source.mjs";

assert.equal(
  parseGrammarSource('{"scopeName":"source.example"}', "grammar.json").scopeName,
  "source.example",
);
assert.equal(
  parseGrammarSource("scopeName: 'source.example'\npatterns: []", "grammar.cson").scopeName,
  "source.example",
);
assert.throws(
  () =>
    parseGrammarSource(
      "scopeName: require('node:fs').writeFileSync('/tmp/unwanted', 'code')",
      "grammar.cson",
    ),
  /Unexpected/,
);
const yaml = parseGrammarSource(
  'scopeName: source.example\nvariables:\n  word: "[a-z]+"\npatterns:\n  - match: "{{word}}"\n',
  "grammar.yaml",
);
assert.equal(yaml.patterns[0].match, "[a-z]+");
assert.equal(yaml.variables, undefined);
assert.throws(
  () =>
    parseGrammarSource(
      'scopeName: source.example\nvariables:\n  word: "{{word}}"\npatterns:\n  - match: "{{word}}"\n',
      "grammar.yaml",
    ),
  /Invalid grammar variable/,
);

function repeatedVariableGrammar(baseBytes, depth, repeated = true, matches = 1) {
  const lines = [
    "scopeName: source.example",
    "variables:",
    "  base: " + JSON.stringify("x".repeat(baseBytes)),
  ];
  let previous = "base";
  for (let index = 0; index < depth; index += 1) {
    const name = "v" + index;
    const reference = "{{" + previous + "}}";
    lines.push("  " + name + ": " + JSON.stringify(reference + (repeated ? reference : "")));
    previous = name;
  }
  lines.push("patterns:");
  for (let index = 0; index < matches; index += 1)
    lines.push("  - match: " + JSON.stringify("{{" + previous + "}}"));
  return lines.join("\n");
}

assert.throws(
  () => parseGrammarSource(repeatedVariableGrammar(1024, 14), "grammar.yaml"),
  /YAML grammar variable expansion in grammar\.yaml exceeded the intermediate variable output bytes limit \(16 MiB\)/,
);
assert.throws(
  () => parseGrammarSource(repeatedVariableGrammar(2 * 1024 * 1024, 0, false, 5), "grammar.yaml"),
  /YAML grammar variable expansion in grammar\.yaml exceeded the total expanded bytes limit \(8 MiB\)/,
);
assert.throws(
  () => parseGrammarSource(repeatedVariableGrammar(1, 17), "grammar.yaml"),
  /YAML grammar variable expansion in grammar\.yaml exceeded the substitution count limit \(100,000\)/,
);
assert.throws(
  () => parseGrammarSource(repeatedVariableGrammar(1, 65, false), "grammar.yaml"),
  /YAML grammar variable expansion in grammar\.yaml exceeded the nesting depth limit \(64\)/,
);
assert.throws(
  () => parseGrammarSource(repeatedVariableGrammar(1024 * 1024, 63, false), "grammar.yaml"),
  /YAML grammar variable expansion in grammar\.yaml exceeded the intermediate variable output bytes limit \(16 MiB\)/,
);

const plist = parseGrammarSource(
  '<?xml version="1.0"?><plist version="1.0"><dict><key>scopeName</key><string>source.example</string><key>patterns</key><array/></dict></plist>',
  "grammar.tmLanguage",
);
assert.equal(plist.scopeName, "source.example");
assert.deepEqual(plist.patterns, []);
const patch = {
  path: "/patterns/0/include",
  before: "text.html",
  after: "text.html.custom",
  reason: "Keep variant scopes separate.",
};
assert.equal(
  applyGrammarPatches({ patterns: [{ include: "text.html" }] }, [patch]).patterns[0].include,
  "text.html.custom",
);
assert.throws(
  () => applyGrammarPatches({ patterns: [{ include: "source.changed" }] }, [patch]),
  /no longer matches/,
);
console.log("Grammar source formats, variables, and patch preconditions verified.");
