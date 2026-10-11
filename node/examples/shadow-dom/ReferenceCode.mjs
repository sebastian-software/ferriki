import { defineCodeElement, FERRIKI_CODE_TAG } from "@ferriki/core/web-component";
import React from "react";

/**
 * Register trusted prepared blocks separately from React presentation props.
 * Call this before hydrating or mounting reference hosts.
 */
export function registerCodeElementReferences({ css, themeAliases, blocks }) {
  return defineCodeElement({ css, themeAliases, blocks });
}

/** Render an empty host whose short reference is resolved by the browser registry. */
export function ReferenceCode({ codeRef, className, theme = "light", ...presentationProps }) {
  if (typeof codeRef !== "string" || codeRef.length === 0)
    throw new TypeError("ReferenceCode `codeRef` must be a nonempty string");
  if (typeof theme !== "string") throw new TypeError("ReferenceCode `theme` must be a string");

  return React.createElement(FERRIKI_CODE_TAG, {
    ...presentationProps,
    ...(className === undefined ? {} : { className }),
    "data-ferriki-theme": theme,
    "code-ref": codeRef,
  });
}
