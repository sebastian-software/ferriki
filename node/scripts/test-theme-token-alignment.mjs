import assert from "node:assert/strict";
import test from "node:test";
import { alignThemeTokens as align } from "../ferriki/src/theme-tokens.mjs";

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
        { offset: 1, content: "\uDE00abx", fontStyle: 4 },
      ],
    ]),
  ];
  assert.deepEqual(align(input), [
    [
      {
        content: "\uD83D",
        offset: 0,
        type: "emoji",
        scopeNames: ["emoji"],
        variants: { dark: { color: "red" }, light: { color: "blue" }, other: {} },
      },
      {
        content: "\uDE00",
        offset: 1,
        type: "emoji",
        scopeNames: ["emoji"],
        variants: {
          dark: { color: "red" },
          light: { color: "blue" },
          other: { "text-decoration": "underline" },
        },
      },
      {
        content: "a",
        offset: 2,
        variants: { dark: {}, light: { color: "blue" }, other: { "text-decoration": "underline" } },
      },
      {
        content: "b",
        offset: 3,
        scopeNames: ["fallback"],
        variants: { dark: {}, light: {}, other: { "text-decoration": "underline" } },
      },
      {
        content: "x",
        offset: 4,
        variants: {
          dark: {
            "font-style": "italic",
            "font-weight": "bold",
            "text-decoration": "underline line-through",
          },
          light: {},
          other: { "text-decoration": "underline" },
        },
      },
      {
        content: "y",
        offset: 5,
        variants: {
          dark: {
            "font-style": "italic",
            "font-weight": "bold",
            "text-decoration": "underline line-through",
          },
          light: {},
          other: {},
        },
      },
    ],
    [{ content: "z", offset: 0, variants: { dark: {}, light: {}, other: {} } }],
    [],
  ]);
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

test("alignment does not mutate prototypes on __proto__ theme keys and drops unsafe colors", () => {
  const output = align([
    result("__proto__", [[{ offset: 0, content: "x", color: "red;position:fixed" }]]),
    result("light", [[{ offset: 0, content: "x", color: "#123456" }]]),
  ]);
  const variants = output[0][0].variants;
  assert.equal(Object.getPrototypeOf(variants), Object.prototype);
  assert.equal(Object.hasOwn(variants, "__proto__"), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(variants, "__proto__")?.value, {});
  assert.deepEqual(variants.light, { color: "#123456" });
});
