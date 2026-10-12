// eslint-disable-next-line no-unused-vars, unused-imports/no-unused-imports -- Vite consumes this JSX marker at build time.
import { Code } from "@ferriki/core/react/macro";
import { codeElementStyles } from "@ferriki/core/web-component";
import React, { useEffect, useState } from "react";
import { ShadowCode } from "../ShadowCode.mjs";
import { initialBlock, updatedBlock } from "./snippets.jsx";

const THEME_ALIASES = ["light", "dark"];
export const LIGHT_CODE_CSS = codeElementStyles(THEME_ALIASES)
  .replaceAll(/:host\(([^)]+)\)/g, "[data-code-host]$1")
  .replaceAll(":host", "[data-code-host]");

let liveBlocks = { initialBlock, updatedBlock };
if (import.meta.hot) {
  import.meta.hot.accept("./snippets.jsx", (module) => {
    if (!module) return;
    liveBlocks = { initialBlock: module.initialBlock, updatedBlock: module.updatedBlock };
    window.dispatchEvent(new CustomEvent("ferriki:shadow-source-update", { detail: liveBlocks }));
  });
}

function LightCode({ code, theme }) {
  const html = `<style>${LIGHT_CODE_CSS}\n${code.css}</style>${code.html}`;
  return React.createElement("div", {
    "data-code-host": "",
    "data-ferriki-theme": theme,
    "data-light-code": "",
    dangerouslySetInnerHTML: { __html: html },
  });
}

export function App() {
  const [theme, setTheme] = useState("light");
  const [conflict, setConflict] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [renderCount, setRenderCount] = useState(0);
  const [copied, setCopied] = useState("");
  const [blocks, setBlocks] = useState(liveBlocks);
  const block = updated ? blocks.updatedBlock : blocks.initialBlock;

  useEffect(() => {
    window.__ferrikiShadowHydrated = true;
    const onSourceUpdate = (event) => setBlocks(event.detail);
    window.addEventListener("ferriki:shadow-source-update", onSourceUpdate);
    return () => window.removeEventListener("ferriki:shadow-source-update", onSourceUpdate);
  }, []);

  async function copyCode(kind) {
    await navigator.clipboard.writeText(block.code);
    setCopied(kind);
  }

  return (
    <main className={conflict ? "demo conflict" : "demo"} data-parent-renders={renderCount}>
      <header className="intro">
        <p className="eyebrow">Ferriki code element</p>
        <h1>Prepared code with isolated styles.</h1>
        <p>
          Both blocks contain the same prepared HTML and real, selectable text. The property adapter
          keeps page selectors outside the code block; the default macro uses a short reference and
          declarative Shadow DOM.
        </p>
      </header>
      <div className="controls" aria-label="Code example controls">
        <label>
          <input
            type="checkbox"
            checked={conflict}
            data-toggle-conflict=""
            onChange={(event) => setConflict(event.target.checked)}
          />
          Enable conflicting page styles
        </label>
        <button
          type="button"
          data-toggle-theme=""
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          Theme: {theme}
        </button>
        <button type="button" data-update-code="" onClick={() => setUpdated(!updated)}>
          {updated ? "Restore source" : "Change source"}
        </button>
        <button type="button" data-rerender="" onClick={() => setRenderCount(renderCount + 1)}>
          Rerender parent ({renderCount})
        </button>
      </div>
      <div className="comparison">
        <section className="panel" aria-labelledby="light-title" data-panel="light">
          <header>
            <div>
              <h2 id="light-title">Regular HTML</h2>
              <p>Shares the page's CSS scope.</p>
            </div>
            <button type="button" data-copy-code="light" onClick={() => void copyCode("light")}>
              Copy code
            </button>
          </header>
          {React.createElement(LightCode, { code: block, theme })}
        </section>
        <section className="panel" aria-labelledby="shadow-title" data-panel="shadow">
          <header>
            <div>
              <h2 id="shadow-title">Property adapter</h2>
              <p>Uses a highlighted HTML property and a readable source fallback.</p>
            </div>
            <button type="button" data-copy-code="shadow" onClick={() => void copyCode("shadow")}>
              Copy code
            </button>
          </header>
          {React.createElement(ShadowCode, {
            code: block,
            theme,
            className: renderCount % 2 ? "shadow-code shadow-code-alternate" : "shadow-code",
          })}
        </section>
      </div>
      <p role="status" className="status">
        {copied
          ? `Copied ${copied} source.`
          : "Select text in either block, or copy the original source."}
      </p>
      <section className="panel macro-panel" aria-labelledby="macro-title" data-panel="macro">
        <header>
          <div>
            <h2 id="macro-title">Default Code macro output</h2>
            <p>
              The macro emits a code-ref host. The server postprocessor adds declarative Shadow DOM,
              and the browser registry supplies the prepared HTML.
            </p>
          </div>
        </header>
        <Code
          language="ts"
          source={`const island = "prepared at build time";\nconsole.log(island);\n`}
          meta='title="Default macro island" {2}'
          lineNumbers
          className="macro-shadow-code"
          theme={theme}
        />
      </section>
    </main>
  );
}
