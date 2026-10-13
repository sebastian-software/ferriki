import ts from "typescript";
import expectations from "./fixtures/loaded-languages.json";

// Preserve every immutable HTML fixture. Only the six tests with historical
// catalog assumptions use Ferriki-owned ID/alias sets or a reviewed count.
export function adaptCatalogSnapshots(code: string, filename: string): string | undefined {
  const entry = Object.entries(expectations).find(([path]) =>
    filename.endsWith(`/compat/upstream/shiki/packages/${path}`),
  );
  if (!entry) return;
  const tests = entry[1] as Record<string, (string[] | number)[]>;
  const counts = new Map<string, number>();
  const changes: { start: number; end: number; code: string }[] = [];
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node, testName = ""): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "it" &&
      ts.isStringLiteral(node.arguments[0])
    )
      testName = node.arguments[0].text;
    if (
      tests[testName] &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "toMatchInlineSnapshot" &&
      ts.isCallExpression(node.expression.expression)
    ) {
      const assertion = node.expression.expression;
      const actual = assertion.arguments[0]?.getText(source);
      if (
        ts.isIdentifier(assertion.expression) &&
        assertion.expression.text === "expect" &&
        actual &&
        /^\w+\.getLoadedLanguages\(\)(?:\.sort\(\))?(?:\.length)?$/.test(actual)
      ) {
        const index = counts.get(testName) ?? 0;
        const expected = tests[testName][index];
        if (expected === undefined) throw new Error(`Unreviewed catalog assertion: ${testName}`);
        counts.set(testName, index + 1);
        changes.push({
          start: node.getStart(source),
          end: node.getEnd(),
          // The API promises the loaded keys, not their registration order.
          code: Array.isArray(expected)
            ? `expect([...${actual}].sort()).toEqual(${JSON.stringify([...expected].sort())})`
            : `expect(${actual}).toEqual(${expected})`,
        });
      }
    }
    ts.forEachChild(node, (child) => visit(child, testName));
  }
  visit(source);
  for (const [name, expected] of Object.entries(tests))
    if (counts.get(name) !== expected.length)
      throw new Error(`Catalog snapshot adapter no longer matches ${filename}: ${name}`);
  for (const change of changes.reverse())
    code = code.slice(0, change.start) + change.code + code.slice(change.end);
  return code;
}
