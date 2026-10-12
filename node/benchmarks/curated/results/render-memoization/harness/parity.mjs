// Compare unusual transformed inputs and public options with current main.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

async function main() {
  const nodeRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
  const out = fileURLToPath(new URL("../", import.meta.url));
  await import(pathToFileURL(join(nodeRoot, "scripts/test-asset-env.mjs")));
  const engines = await Promise.all(
    ["baseline", "candidate"].map(async (name) => {
      const api = await import(
        pathToFileURL(join(nodeRoot, ".cache/render-memoization", name, "index.mjs"))
      );
      return api.createHighlighter({
        langs: ["json", "javascript"],
        themes: ["github-dark", "github-light"],
        assets: { remote: false },
      });
    }),
  );
  const scenarios = [];
  try {
    for (const structure of ["classic", "inline"]) {
      for (const defaultColor of [undefined, "dark", false, "light-dark()"]) {
        scenarios.push({
          code: 'const x = "<&😀";\n// trailing\n',
          options: {
            lang: "javascript",
            themes: { dark: "github-dark", light: "github-light" },
            structure,
            defaultColor,
          },
        });
      }
    }
    for (const rootStyle of [false, "color:#123456", "color:#654321", undefined]) {
      scenarios.push({
        code: '"x"\n{"x":42}',
        options: {
          lang: "json",
          theme: "github-dark",
          rootStyle,
          transformers: [
            {
              tokens(lines) {
                for (const [index, token] of lines.flat().entries()) {
                  token.scopeNames = [
                    "source.probe",
                    index % 2 ? "meta.b" : "meta.a",
                    "meta.a",
                    'meta.😀_"',
                    "entity.name.probe",
                  ];
                }
              },
              span(node, _line, column) {
                node.properties.class = column % 2 ? ["existing", "tok-meta"] : "existing token";
                node.properties.style =
                  column % 2
                    ? { color: "#123456", "font-weight": "bold" }
                    : "font-weight:bold;color:#123456";
              },
            },
          ],
        },
      });
    }
    scenarios.push({
      code: "const answer = 42",
      options: {
        lang: "javascript",
        theme: "github-dark",
        decorations: [{ start: 6, end: 12, properties: { class: "selected" }, alwaysWrap: true }],
        transformers: [
          {
            span(node) {
              this.addClassToHast(node, "transformed");
            },
          },
        ],
      },
    });
    for (const code of ["", "<&😀\r\n\r\n", "trailing\n"])
      scenarios.push({ code, options: { lang: "text", theme: "none" } });
    for (const entry of scenarios) {
      const outputs = engines.map((engine) => engine.codeToHtmlWithCss(entry.code, entry.options));
      assert.deepEqual(outputs[1], outputs[0]);
      for (const [index, engine] of engines.entries())
        assert.equal(
          engine.codeToHtml(entry.code, { ...entry.options, styleMode: "classes" }),
          outputs[index].html,
        );
    }
    // A nested render must not replace the outer render's cache.
    const nested = engines.map((engine) =>
      engine.codeToHtmlWithCss('"outer"', {
        lang: "json",
        theme: "github-dark",
        transformers: [
          {
            span(node) {
              engine.codeToHtmlWithCss("const inner = 1", {
                lang: "javascript",
                theme: "github-light",
              });
              node.properties.style = "color:#123456";
            },
          },
        ],
      }),
    );
    assert.deepEqual(nested[1], nested[0]);
    writeFileSync(
      join(out, "parity.json"),
      `${JSON.stringify(
        {
          scenarios: scenarios.length + 1,
          exactHtmlAndCss: true,
          coverage:
            "scope order/repetition/Unicode escaping, preexisting class arrays/strings, style property order, different root styles across calls, all theme defaults, classic/inline structure, decorations, nested renders, empty/plain/CRLF source",
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    engines.forEach((engine) => engine.dispose());
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
