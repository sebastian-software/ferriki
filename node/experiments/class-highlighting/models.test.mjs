import assert from "node:assert/strict";
import { it } from "vitest";

import {
  classifyCollisions,
  exactSelector,
  identity,
  pathId,
  renderTokens,
  scopeName,
} from "./models.mjs";

it("nested theme selectors anchor the complete path at the fixture root", () => {
  const selector = exactSelector(["source.js", "meta.var.js"], "nested");
  assert.equal(selector, ".fixture > .exact-source-js > .exact-meta-var-js > .token");
});

it("flat classes cannot distinguish reordered or repeated context, but the other models can", () => {
  const pairs = [
    [
      ["source.probe", "meta.a", "meta.b", "entity.name"],
      ["source.probe", "meta.b", "meta.a", "entity.name"],
    ],
    [
      ["source.probe", "meta.a", "meta.a", "entity.name"],
      ["source.probe", "meta.a", "entity.name"],
    ],
  ];
  for (const [first, second] of pairs) {
    assert.equal(identity(first, "flat"), identity(second, "flat"));
    assert.notEqual(identity(first, "nested"), identity(second, "nested"));
    assert.notEqual(pathId(first), pathId(second));
    const paths = [first, second].map((scopes) => ({ id: pathId(scopes), scopes }));
    const styles = {
      probe: { [paths[0].id]: { color: "#ff0000" }, [paths[1].id]: { color: "#0000ff" } },
    };
    assert.equal(classifyCollisions(paths, styles, "flat").conflicts.length, 1);
    assert.equal(classifyCollisions(paths, styles, "nested").conflicts.length, 0);
    assert.equal(classifyCollisions(paths, styles, "hybrid").conflicts.length, 0);
  }
});

it("scope encoding keeps literal punctuation distinct from hierarchy separators", () => {
  assert.notEqual(scopeName("meta.a-b"), scopeName("meta.a.b"));
  assert.notEqual(scopeName("meta.a_b"), scopeName("meta.a-b"));
});

it("nested output shares ancestors but retains repeated scopes and escapes source text", () => {
  const tokens = [
    { index: 0, scopes: ["source.probe", "meta.a", "meta.a"], content: '<x>&"' },
    { index: 1, scopes: ["source.probe", "meta.a", "meta.b"], content: "😀\n" },
  ];
  const html = renderTokens(tokens, "nested");
  assert.equal((html.match(/class="scope-source /g) || []).length, 1);
  assert.equal((html.match(/<span/g) || []).length, 6);
  assert.equal((html.match(/<\/span>/g) || []).length, 6);
  assert(html.includes("&lt;x&gt;&amp;&quot;"));
  assert(html.includes("😀\n"));
});
