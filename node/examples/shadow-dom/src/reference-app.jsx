import { codeElementSizing } from "@ferriki/core/web-component";
import { useEffect, useState } from "react";
// eslint-disable-next-line no-unused-vars, unused-imports/no-unused-imports -- JSX resolves this component reference at build time.
import { ReferenceCode } from "../ReferenceCode.mjs";
import { initialBlock, updatedBlock } from "./snippets.jsx";

const lineCount = (source) => source.split(/\r\n|\r|\n/u).length;
const initialLineCount = lineCount(initialBlock.code);
const updatedLineCount = lineCount(updatedBlock.code);
const initialCodeSizing = codeElementSizing(initialLineCount);
const updatedCodeSizing = codeElementSizing(updatedLineCount);
const shortCappedCodeSizing = codeElementSizing(initialLineCount, 20);
const customInitialCodeSizing = {
  ...initialCodeSizing,
  "--ferriki-code-line-height": "28px",
  "--ferriki-code-padding-block": "10px",
  borderBlock: "2px solid #476a62",
  paddingBlock: "4px",
};
const customUpdatedCodeSizing = {
  ...updatedCodeSizing,
  "--ferriki-code-line-height": "28px",
  "--ferriki-code-padding-block": "10px",
  borderBlock: "2px solid #476a62",
  paddingBlock: "4px",
};

// eslint-disable-next-line no-unused-vars, unused-imports/no-unused-vars -- JSX resolves this component reference at build time.
function ReferenceMaxLinesFixture() {
  const [maxLines, setMaxLines] = useState(3);

  return (
    <section data-reference-max-lines="">
      <button type="button" data-max-lines-grow="" onClick={() => setMaxLines(6)}>
        Grow code viewport
      </button>
      <button type="button" data-max-lines-remove="" onClick={() => setMaxLines(undefined)}>
        Remove code viewport cap
      </button>
      <ReferenceCode
        codeRef="probe-updated"
        max-lines={maxLines}
        className="reference-code"
        style={codeElementSizing(updatedLineCount, maxLines)}
        data-max-lines-host="long"
      />
      <div className="reference-next" data-max-lines-next="long" />
      <ReferenceCode
        codeRef="probe-initial"
        max-lines={20}
        className="reference-code"
        style={shortCappedCodeSizing}
        data-max-lines-host="short"
      />
      <div className="reference-next" data-max-lines-next="short" />
    </section>
  );
}

if (import.meta.hot) {
  import.meta.hot.accept("./snippets.jsx", () => {
    if (window.__ferrikiReferenceReloadPending) return;
    window.__ferrikiReferenceReloadPending = true;
    window.location.reload();
  });
}

export const referenceBlocks = {
  "probe-initial": initialBlock.html,
  "probe-updated": updatedBlock.html,
};

export function ReferenceApp() {
  const [updated, setUpdated] = useState(false);
  const [theme, setTheme] = useState("light");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    window.__referenceHydrated = true;
  }, []);

  return (
    <main id="reference-root" data-reference-revision={revision}>
      <button
        type="button"
        data-reference-theme=""
        onClick={() => setTheme(theme === "light" ? "dark" : "light")}
      >
        Toggle reference theme
      </button>
      <button type="button" data-reference-source="" onClick={() => setUpdated((value) => !value)}>
        Toggle reference source
      </button>
      <button
        type="button"
        data-reference-rerender=""
        onClick={() => setRevision((value) => value + 1)}
      >
        Rerender reference parent
      </button>
      <ReferenceCode
        codeRef={updated ? "probe-updated" : "probe-initial"}
        theme={theme}
        className="reference-code"
        style={updated ? customUpdatedCodeSizing : customInitialCodeSizing}
        data-reference-host="changing"
      />
      <div className="reference-next" data-reference-next="changing" />
      <ReferenceCode
        codeRef="probe-initial"
        theme={theme}
        className="reference-code"
        style={initialCodeSizing}
        data-reference-host="stable"
      />
      <div className="reference-next" data-reference-next="stable" />
      <ReferenceCode
        codeRef="probe-initial"
        theme={theme}
        className="reference-code"
        style={customInitialCodeSizing}
        data-reference-host="repeated"
      />
      <div className="reference-next" data-reference-next="repeated" />
      <ReferenceCode
        codeRef="probe-updated"
        theme={theme}
        className="reference-code"
        style={customUpdatedCodeSizing}
        data-reference-host="late-style"
      />
      <div className="reference-next" data-reference-next="late-style" />
      <ReferenceMaxLinesFixture />
    </main>
  );
}
