import { renderCodeElementShadows } from "@ferriki/core/web-component/server";
import React from "react";
import { renderToString } from "react-dom/server";
import { ReferenceApp, referenceBlocks } from "./reference-app.jsx";
import { initialBlock, updatedBlock } from "./snippets.jsx";
export const referenceCss = [initialBlock.css, updatedBlock.css].filter(Boolean).join("\n");

export function renderReferenceApp() {
  return renderToString(
    React.createElement(React.StrictMode, null, React.createElement(ReferenceApp)),
  );
}

export function renderReferenceShadows() {
  return renderCodeElementShadows(renderReferenceApp(), {
    blocks: referenceBlocks,
    themeAliases: ["light", "dark"],
    ...(initialBlock.css ? { stylesheetHref: "/reference.css" } : {}),
  });
}
