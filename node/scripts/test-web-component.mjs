import assert from "node:assert/strict";
import test from "node:test";

import {
  codeElementSizing,
  codeElementStyles,
  defineCodeElement,
  FERRIKI_CODE_TAG,
} from "../ferriki/web-component.mjs";

test("web component module imports in Node and registration is SSR-safe", () => {
  assert.equal(FERRIKI_CODE_TAG, "ferriki-code");
  assert.equal(defineCodeElement(), undefined);
  assert.equal(defineCodeElement({ css: ".token{color:red}" }), undefined);
});

test("theme stylesheet supports generic aliases and an empty alias list", () => {
  const css = codeElementStyles(["primary", "contrast"]);
  assert.match(css, /:host\(\[data-ferriki-theme="primary"\]\) pre\.shiki-themes/);
  assert.match(css, /--ferriki-color: var\(--shiki-contrast\)/);
  assert.match(css, /--ferriki-background: var\(--shiki-contrast-bg\)/);
  assert.match(css, /font-family: ui-monospace/);
  assert.match(css, /line-height: var\(--ferriki-code-line-height, 1\.3125rem\)/);
  assert.match(css, /padding-block: var\(--ferriki-code-padding-block, 0px\)/);
  assert.match(css, /max-block-size: var\(--ferriki-code-max-block-size, none\)/);
  assert.doesNotMatch(codeElementStyles([]), /data-ferriki-theme/);
});

test("code element sizing reserves one shared line box and validates line counts", () => {
  assert.deepEqual(codeElementSizing(4), {
    display: "block",
    boxSizing: "content-box",
    minBlockSize:
      "min(calc(4 * var(--ferriki-code-line-height, 1.3125rem) + 2 * var(--ferriki-code-padding-block, 0px)), var(--ferriki-code-max-block-size, calc(4 * var(--ferriki-code-line-height, 1.3125rem) + 2 * var(--ferriki-code-padding-block, 0px))))",
  });
  assert.deepEqual(codeElementSizing(30, 5), {
    display: "block",
    boxSizing: "content-box",
    minBlockSize:
      "min(calc(30 * var(--ferriki-code-line-height, 1.3125rem) + 2 * var(--ferriki-code-padding-block, 0px)), var(--ferriki-code-max-block-size, calc(30 * var(--ferriki-code-line-height, 1.3125rem) + 2 * var(--ferriki-code-padding-block, 0px))))",
    "--ferriki-code-max-block-size":
      "calc(5 * var(--ferriki-code-line-height, 1.3125rem) + 2 * var(--ferriki-code-padding-block, 0px))",
  });
  for (const lineCount of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Infinity,
    "4",
    null,
  ]) {
    assert.throws(() => codeElementSizing(lineCount), /positive safe integer/);
  }
  for (const maxLines of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Infinity,
    "5",
    null,
  ]) {
    assert.throws(
      () => codeElementSizing(4, maxLines),
      /`maxLines` must be a positive safe integer/,
    );
  }
});

test("registration validates CSS and theme aliases before browser access", () => {
  assert.throws(() => defineCodeElement(null), /options must be an object/);
  assert.throws(() => defineCodeElement({ css: 42 }), /`css` must be a string/);
  assert.throws(() => defineCodeElement({ themeAliases: ['safe"x'] }), /Unsupported theme alias/);
  assert.throws(
    () => defineCodeElement({ themeAliases: ["light", "light"] }),
    /Duplicate theme alias/,
  );
  assert.throws(() => codeElementStyles(null), /`themeAliases` must be an array/);
});

test("block registry validates code-ref IDs and trusted HTML before SSR return", () => {
  assert.equal(
    defineCodeElement({ blocks: Object.freeze({ Block_1: "<pre>safe</pre>", "a-b": "" }) }),
    undefined,
  );
  assert.throws(() => defineCodeElement({ blocks: null }), /`blocks` must be a record/);
  assert.throws(() => defineCodeElement({ blocks: [] }), /`blocks` must be a record/);
  assert.throws(() => defineCodeElement({ blocks: { "": "<pre />" } }), /Unsupported code-ref ID/);
  assert.throws(
    () => defineCodeElement({ blocks: { "has space": "<pre />" } }),
    /Unsupported code-ref ID/,
  );
  assert.throws(() => defineCodeElement({ blocks: { é: "<pre />" } }), /Unsupported code-ref ID/);
  assert.throws(
    () => defineCodeElement({ blocks: { valid: 42 } }),
    /must map to a trusted HTML string/,
  );
});

test("browser registration accumulates blocks and rejects conflicting IDs", () => {
  const globalDescriptors = new Map(
    ["customElements", "HTMLElement", "document"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  class FakeStyleSheet {
    static instances = [];

    cssRules = [];

    constructor() {
      FakeStyleSheet.instances.push(this);
    }

    replaceSync(css) {
      this.cssRules = css.trim() === "" ? [] : [{ cssText: css.trim() }];
    }

    insertRule(cssText, index) {
      if (cssText.startsWith("@namespace") && index > 0)
        throw new DOMException("Namespace rules must precede style rules", "InvalidStateError");
      this.cssRules.splice(index, 0, { cssText });
      return index;
    }
  }
  class FakeLink {
    constructor(marked) {
      this.nodeType = 1;
      this.tagName = "LINK";
      this.markedServerCss = marked;
      this.parentNode = undefined;
    }

    remove() {
      if (!this.parentNode) return;
      this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
      this.parentNode = undefined;
    }
  }
  class FakePre {
    constructor() {
      this.nodeType = 1;
      this.tagName = "PRE";
      this.attributes = new Map();
      this.parentNode = undefined;
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    hasAttribute(name) {
      return this.attributes.has(name);
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }
  }
  class FakeShadowRoot {
    constructor() {
      this.pre = new FakePre();
      this.childNodes = [
        { nodeType: 8, data: "ferriki-code:late%2Dref" },
        new FakeLink(true),
        new FakeLink(false),
        { nodeType: 1, tagName: "CODE" },
        this.pre,
      ];
      for (const node of this.childNodes) node.parentNode = this;
    }

    get firstChild() {
      return this.childNodes[0];
    }

    querySelectorAll(selector) {
      assert.equal(selector, "link[data-ferriki-code-css]");
      return this.childNodes.filter((node) => node instanceof FakeLink && node.markedServerCss);
    }

    querySelector(selector) {
      assert.equal(selector, "pre");
      return this.pre;
    }

    get adoptedStyleSheets() {
      return this._adoptedStyleSheets ?? [];
    }

    set adoptedStyleSheets(sheets) {
      this._adoptedStyleSheets = sheets;
    }
  }
  const fakeDocument = {
    defaultView: { CSSStyleSheet: FakeStyleSheet, ShadowRoot: FakeShadowRoot },
  };
  const definitions = new Map();
  let preUpgradeMaxLines;
  const fakeCustomElements = {
    get(name) {
      return definitions.get(name);
    },
    define(name, constructor) {
      definitions.set(name, constructor);
    },
  };

  try {
    Object.defineProperty(globalThis, "customElements", {
      configurable: true,
      value: fakeCustomElements,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: class {
        constructor() {
          this.ownerDocument = fakeDocument;
          this.shadowRoot = new FakeShadowRoot();
          this.attributes = new Map();
          const styleProperties = new Map();
          this.style = {
            setProperty(name, value) {
              styleProperties.set(name, value);
            },
            removeProperty(name) {
              styleProperties.delete(name);
            },
            getPropertyValue(name) {
              return styleProperties.get(name) ?? "";
            },
          };
          if (preUpgradeMaxLines !== undefined) {
            Object.defineProperty(this, "maxLines", {
              configurable: true,
              value: preUpgradeMaxLines,
              writable: true,
            });
            preUpgradeMaxLines = undefined;
          }
        }

        getAttribute(name) {
          return this.attributes.get(name) ?? null;
        }

        setAttribute(name, value) {
          const nextValue = String(value);
          const previousValue = this.getAttribute(name);
          this.attributes.set(name, nextValue);
          if (this.constructor.observedAttributes.includes(name))
            this.attributeChangedCallback(name, previousValue, nextValue);
        }

        removeAttribute(name) {
          const previousValue = this.getAttribute(name);
          if (previousValue === null) return;
          this.attributes.delete(name);
          if (this.constructor.observedAttributes.includes(name))
            this.attributeChangedCallback(name, previousValue, null);
        }
      },
    });
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });

    const constructor = defineCodeElement({ blocks: { first: "<pre>one</pre>" } });
    const host = new constructor();
    host.setAttribute("code-ref", "late-ref");
    host.connectedCallback();
    const [marker, markedLink, unmarkedLink, codeNode] = host.shadowRoot.childNodes;
    const sharedSheet = FakeStyleSheet.instances[0];
    assert.equal(host.shadowRoot.adoptedStyleSheets[0], sharedSheet);
    assert.equal(host.shadowRoot.childNodes.includes(markedLink), true);
    assert.equal(host.shadowRoot.childNodes.includes(codeNode), true);

    assert.equal(defineCodeElement({ blocks: { second: "<pre>two</pre>" } }), constructor);
    assert.equal(defineCodeElement({ blocks: { first: "<pre>one</pre>" } }), constructor);
    assert.equal(host.shadowRoot.childNodes.includes(markedLink), true);

    assert.throws(
      () =>
        defineCodeElement({
          css: '@namespace svg url("http://www.w3.org/2000/svg");',
          blocks: { "late-ref": "<pre>failed registration</pre>" },
        }),
      { name: "InvalidStateError" },
    );
    assert.equal(host.shadowRoot.childNodes.includes(markedLink), true);

    assert.equal(
      defineCodeElement({ css: ".late-ref{color:red}", blocks: { "late-ref": "<pre>late</pre>" } }),
      constructor,
    );
    assert.equal(host.shadowRoot.childNodes.includes(marker), true);
    assert.equal(host.shadowRoot.childNodes.includes(markedLink), false);
    assert.equal(host.shadowRoot.childNodes.includes(unmarkedLink), true);
    assert.equal(host.shadowRoot.childNodes.includes(codeNode), true);
    assert.equal(host.shadowRoot.adoptedStyleSheets[0], sharedSheet);

    const pre = host.shadowRoot.pre;
    host.maxLines = 3;
    assert.equal(host.getAttribute("max-lines"), "3");
    assert.equal(host.maxLines, 3);
    assert.equal(
      host.style.getPropertyValue("--ferriki-code-max-block-size"),
      "calc(3 * var(--ferriki-code-line-height, 1.3125rem) + 2 * var(--ferriki-code-padding-block, 0px))",
    );
    assert.equal(pre.getAttribute("tabindex"), "0");
    host.maxLines = 5;
    assert.equal(host.getAttribute("max-lines"), "5");
    assert.equal(host.shadowRoot.pre, pre);
    assert.equal(host.shadowRoot.childNodes.includes(codeNode), true);
    assert.throws(() => (host.maxLines = 0), /positive safe integer/);
    host.maxLines = null;
    assert.equal(host.getAttribute("max-lines"), null);
    assert.equal(host.maxLines, undefined);
    assert.equal(host.style.getPropertyValue("--ferriki-code-max-block-size"), "");
    assert.equal(pre.hasAttribute("tabindex"), false);

    host.setAttribute("maxlines", "2");
    assert.equal(host.maxLines, 2);
    assert.equal(pre.getAttribute("tabindex"), "0");
    host.setAttribute("max-lines", "not-a-count");
    assert.equal(host.maxLines, undefined);
    assert.equal(pre.hasAttribute("tabindex"), false);
    host.removeAttribute("max-lines");
    assert.equal(host.maxLines, 2);
    host.removeAttribute("maxlines");
    assert.equal(host.maxLines, undefined);

    preUpgradeMaxLines = 4;
    const upgradedHost = new constructor();
    assert.equal(Object.hasOwn(upgradedHost, "maxLines"), false);
    upgradedHost.setAttribute("code-ref", "late-ref");
    upgradedHost.connectedCallback();
    assert.equal(upgradedHost.maxLines, 4);
    assert.equal(upgradedHost.getAttribute("max-lines"), "4");
    assert.equal(upgradedHost.shadowRoot.pre.getAttribute("tabindex"), "0");

    assert.throws(
      () => defineCodeElement({ blocks: { first: "<pre>changed</pre>" } }),
      /already registered with different HTML/,
    );
  } finally {
    for (const [name, descriptor] of globalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
