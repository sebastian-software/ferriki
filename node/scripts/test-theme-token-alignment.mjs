import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Exercise the private alignment function without adding it to the public API.
const source = await readFile(new URL("../ferriki/src/index.mjs", import.meta.url), "utf8");
const implementation = source.slice(
  source.indexOf("function alignThemeTokens("),
  source.indexOf("function tokenHtmlStyle("),
);
const align = vm.runInThisContext(`(() => { ${implementation}; return alignThemeTokens; })()`);

function reference(results) {
  const lineCount = Math.max(...results.map((result) => result.result.tokens.length));
  return Array.from({ length: lineCount }, (_, lineIndex) => {
    const lines = results.map((result) => result.result.tokens[lineIndex] || []);
    const boundaries = [
      ...new Set(
        lines.flatMap((line) =>
          line.flatMap((token) => [token.offset, token.offset + token.content.length]),
        ),
      ),
    ].sort((a, b) => a - b);
    const output = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      const variants = {};
      let base;
      for (let j = 0; j < results.length; j++) {
        const token = lines[j].find(
          (item) => item.offset <= start && start < item.offset + item.content.length,
        );
        base ||= token;
        const style = {};
        if (token?.color) style.color = token.color;
        if (token?.fontStyle & 1) style["font-style"] = "italic";
        if (token?.fontStyle & 2) style["font-weight"] = "bold";
        const decorations = [];
        if (token?.fontStyle & 4) decorations.push("underline");
        if (token?.fontStyle & 8) decorations.push("line-through");
        if (decorations.length) style["text-decoration"] = decorations.join(" ");
        variants[results[j].color] = style;
      }
      if (base)
        output.push({
          content: base.content.slice(start - base.offset, end - base.offset),
          offset: start,
          ...(base.type === undefined ? {} : { type: base.type }),
          ...(base.scopeNames ? { scopeNames: base.scopeNames } : {}),
          variants,
        });
    }
    return output;
  });
}

const result = (color, tokens) => ({ color, result: { tokens } });

test("alignment preserves splits, gaps, fallback scopes, UTF-16 offsets and empty lines", () => {
  const input = [
    result("dark", [
      [
        { offset: 0, content: "😀", color: "red", type: "emoji", scopeNames: ["emoji"] },
        { offset: 4, content: "xy", fontStyle: 15 },
      ],
      [],
      [],
    ]),
    result("light", [
      [
        { offset: 0, content: "😀a", color: "blue" },
        { offset: 3, content: "bxy", scopeNames: ["fallback"] },
      ],
      [{ offset: 0, content: "z" }],
    ]),
    result("other", [
      [
        { offset: 0, content: "" },
        { offset: 1, content: "\ude00abx", fontStyle: 4 },
      ],
    ]),
  ];
  assert.deepEqual(align(input), reference(input));
  assert.deepEqual(
    align(input)[0].map((token) => token.offset),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(align(input)[0][3].scopeNames, ["fallback"]);
});

test("token accesses grow linearly with boundaries and themes", () => {
  let reads = 0;
  const makeLine = (count, shift) =>
    Array.from({ length: count }, (_, i) => {
      const token = { offset: i * 2 + shift, content: "x", color: "red" };
      return new Proxy(token, {
        get(target, key) {
          if (key === "offset" || key === "content") reads++;
          return target[key];
        },
      });
    });
  const count = 2000;
  const input = [result("dark", [makeLine(count, 0)]), result("light", [makeLine(count, 1)])];
  const output = align(input);
  assert.equal(output[0].length, count * 2);
  assert.ok(reads < count * 100, `expected linear token accesses, got ${reads}`);
});
