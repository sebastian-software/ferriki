import { defineCodeElement, FERRIKI_CODE_TAG } from "@ferriki/core/web-component";

import React from "react";

/** Thin React adapter for feeding prepared blocks to Ferriki's custom element. */
export function ShadowCode({ code, className, theme = "light", themeAliases }) {
  if (typeof theme !== "string") throw new TypeError("ShadowCode `theme` must be a string");

  // Registration is a no-op during SSR and must happen before React commits the
  // host in the browser. The code HTML is a custom property; React owns the
  // source-text fallback children in light DOM.
  defineCodeElement({ css: code.css, themeAliases });

  return React.createElement(
    FERRIKI_CODE_TAG,
    {
      className,
      "data-ferriki-theme": theme,
      "data-code-host": "",
      highlightedCode: code.html,
    },
    React.createElement(
      "pre",
      code.metadata?.title ? { "data-title": code.metadata.title } : null,
      React.createElement("code", null, code.code),
    ),
  );
}
