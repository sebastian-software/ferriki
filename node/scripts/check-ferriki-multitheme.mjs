import assert from "node:assert/strict";

import { createHighlighter, ShikiError } from "../ferriki/index.mjs";

const highlighter = await createHighlighter({
  langs: ["typescript"],
  themes: ["vitesse-light", "vitesse-dark"],
});

try {
  const options = {
    lang: "typescript",
    themes: {
      light: "vitesse-light",
      dark: "vitesse-dark",
    },
    defaultColor: false,
  };
  const tokens = highlighter.codeToTokens("const answer: number = 42", options);
  assert.equal(tokens.themeName, "shiki-themes vitesse-light vitesse-dark");
  assert.match(tokens.fg, /--shiki-light:/);
  assert.match(tokens.fg, /--shiki-dark:/);
  assert(Object.hasOwn(tokens.tokens[0][0], "htmlStyle"));
  assert.match(tokens.tokens[0][0].htmlStyle, /--shiki-light:/);
  assert.match(tokens.tokens[0][0].htmlStyle, /--shiki-dark:/);

  const html = highlighter.codeToHtml("const answer: number = 42", options);
  assert.match(html, /class="shiki-themes vitesse-light vitesse-dark"/);
  assert.match(html, /--shiki-light:/);
  assert.match(html, /--shiki-dark:/);

  const lightDark = highlighter.codeToHtml("const answer = 42", {
    ...options,
    defaultColor: "light-dark()",
  });
  assert.match(lightDark, /light-dark\(/);
  assert.match(lightDark, /--shiki-light:/);
  assert.match(lightDark, /--shiki-dark:/);

  assert.throws(
    () =>
      highlighter.codeToHtml("const answer = 42", {
        lang: "typescript",
        themes: { dark: "vitesse-dark" },
      }),
    (error) => error instanceof ShikiError && error.message.includes("defaultColor key `light`"),
  );
  assert.throws(
    () =>
      highlighter.codeToHtml("const answer = 42", {
        lang: "typescript",
        themes: {},
        defaultColor: false,
      }),
    (error) => error instanceof ShikiError && error.message === "`themes` option must not be empty",
  );

  const none = highlighter.codeToHtml("const answer = 42", {
    lang: "typescript",
    theme: "none",
  });
  assert.match(none, /class="none"/);
  assert.match(none, /color:inherit/);
} finally {
  highlighter.dispose();
}

console.log("Ferriki multi-theme contract verified");
