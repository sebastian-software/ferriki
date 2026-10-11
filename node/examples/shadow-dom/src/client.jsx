import { defineCodeElement, FERRIKI_CODE_TAG } from "@ferriki/core/web-component";
import React from "react";
import { hydrateRoot } from "react-dom/client";
import { App } from "./app.jsx";
import { initialBlock } from "./snippets.jsx";
import "./style.css";

// Upgrade SSR hosts before hydration so their fallback children remain React-owned.
defineCodeElement({ css: initialBlock.css, themeAliases: ["light", "dark"] });
window.__ferrikiCodeDefinedBeforeHydration = Boolean(customElements.get(FERRIKI_CODE_TAG));
window.__ferrikiShadowErrors = [];
hydrateRoot(
  document.getElementById("root"),
  React.createElement(React.StrictMode, null, React.createElement(App)),
  {
    onRecoverableError(error) {
      window.__ferrikiShadowErrors.push(String(error.message ?? error));
    },
  },
);

if (import.meta.hot) {
  import.meta.hot.accept("./snippets.jsx", (module) => {
    if (!module) return;
    defineCodeElement({ css: module.initialBlock.css, themeAliases: ["light", "dark"] });
  });
  import.meta.hot.accept();
}
