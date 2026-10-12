import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { ReferenceCode, registerCodeElementReferences } from "../ReferenceCode.mjs";
import { ReferenceApp, referenceBlocks } from "./reference-app.jsx";
import { initialBlock, updatedBlock } from "./snippets.jsx";

if (import.meta.hot) {
  import.meta.hot.accept("./snippets.jsx", () => {
    if (window.__ferrikiReferenceReloadPending) return;
    window.__ferrikiReferenceReloadPending = true;
    window.location.reload();
  });
}

const initialRegistration = {
  themeAliases: ["light", "dark"],
  ...(initialBlock.css ? { stylesheetHref: "/reference.css" } : {}),
  blocks: { "probe-initial": referenceBlocks["probe-initial"] },
};
const updatedRegistration = {
  themeAliases: ["light", "dark"],
  ...(updatedBlock.css ? { stylesheetHref: "/reference.css" } : {}),
  blocks: { "probe-updated": referenceBlocks["probe-updated"] },
};

registerCodeElementReferences(initialRegistration);
window.__referenceCodeRegistry = initialRegistration;
window.__registerInitialReferenceAgain = () => registerCodeElementReferences(initialRegistration);
window.__registerUpdatedReference = () => registerCodeElementReferences(updatedRegistration);
window.__registerCodeBlocks = registerCodeElementReferences;
window.__referenceCodeDefinedBeforeHydration = Boolean(customElements.get("ferriki-code"));
window.__referenceShadowErrors = [];
hydrateRoot(
  document.getElementById("root"),
  React.createElement(React.StrictMode, null, React.createElement(ReferenceApp)),
  {
    onRecoverableError(error) {
      window.__referenceShadowErrors.push(String(error.message ?? error));
    },
  },
);

window.__mountReferenceProbe = (target) => {
  const root = createRoot(target);
  root.render(
    React.createElement(ReferenceCode, {
      codeRef: "probe-initial",
      theme: "light",
      className: "reference-code",
      "data-reference-host": "csr",
    }),
  );
  return root;
};
window.__updateReferenceProbe = (root, codeRef) => {
  root.render(
    React.createElement(ReferenceCode, {
      codeRef,
      theme: "light",
      className: "reference-code",
      "data-reference-host": "csr",
    }),
  );
};
