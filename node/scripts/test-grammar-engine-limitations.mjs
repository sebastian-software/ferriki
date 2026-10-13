import assert from "node:assert/strict";
import { engineUnsupportedReason } from "./tiobe-benchmark.mjs";

const unsupported = new Error('Incomplete or invalid escape "\\x{FEFF FFFE FFFF}"');
assert.match(
  engineUnsupportedReason("shiki-js", { textmate: "yaml" }, unsupported),
  /multi-codepoint/,
);
assert.equal(engineUnsupportedReason("ferriki", { textmate: "yaml" }, unsupported), undefined);
assert.equal(engineUnsupportedReason("shiki-wasm", { textmate: "yaml" }, unsupported), undefined);
assert.equal(
  engineUnsupportedReason("shiki-js", { textmate: "javascript" }, unsupported),
  undefined,
);
assert.equal(
  engineUnsupportedReason(
    "shiki-js",
    { textmate: "yaml" },
    new Error("unexpected renderer defect"),
  ),
  undefined,
);
console.log("Only the known external YAML conversion limit is classified as unsupported.");
