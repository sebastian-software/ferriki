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
