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
  assert.match(css, /--_ferriki-token-theme-color: var\(--shiki-contrast, inherit\)/);
  assert.match(css, /color: var\(--_ferriki-token-color, var\(--shiki-primary, inherit\)\)/);
  assert.match(css, /span:not\(\.ferriki-color-authored\)/);
  assert.match(css, /--ferriki-color: var\(--ferriki-foreground, var\(--shiki-contrast\)\)/);
  assert.match(
    css,
    /--ferriki-background: var\(--ferriki-background-color, var\(--shiki-contrast-bg\)\)/,
  );
  assert.match(css, /font-family: ui-monospace/);
  assert.match(css, /line-height: var\(--ferriki-code-line-height, 1\.3125rem\)/);
  assert.match(css, /padding-block: var\(--ferriki-code-padding-block, 0px\)/);
  assert.match(css, /max-block-size: var\(--ferriki-code-max-block-size, none\)/);
  assert.match(css, /\.ferriki-highlight-line\[data-ln\]::before/);
  assert.match(css, /\.ferriki-highlight-line\.highlighted/);
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
  assert.throws(() => defineCodeElement({ stylesheetHref: "" }), /nonempty string/);
  assert.throws(
    () => defineCodeElement({ stylesheetHref: "/code.css\nunsafe" }),
    /control characters/,
  );
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

test("browser registration uses local styles and a persistent shared stylesheet link", () => {
  const globalDescriptors = new Map(
    ["customElements", "HTMLElement", "document"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );

  class FakeNode {
    constructor(tagName, nodeType = 1) {
      this.nodeType = nodeType;
      this.tagName = tagName;
      this.parentNode = undefined;
      this.childNodes = [];
      this.attributes = new Map();
      this.textContent = "";
    }

    get firstChild() {
      return this.childNodes[0];
    }

    get nextSibling() {
      if (!this.parentNode) return undefined;
      const siblings = this.parentNode.childNodes;
      return siblings[siblings.indexOf(this) + 1];
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

    remove() {
      this.parentNode?.removeChild(this);
    }
  }

  class FakeComment extends FakeNode {
    constructor(data) {
      super(undefined, 8);
      this.data = data;
    }
  }

  class FakeFragment extends FakeNode {
    constructor() {
      super(undefined, 11);
    }

    replaceChildren(...nodes) {
      for (const child of [...this.childNodes]) this.removeChild(child);
      for (const node of nodes) this.appendChild(node);
    }

    appendChild(node) {
      node.parentNode?.removeChild(node);
      this.childNodes.push(node);
      node.parentNode = this;
      return node;
    }

    removeChild(node) {
      const index = this.childNodes.indexOf(node);
      if (index === -1) throw new TypeError("The node is not in this fragment");
      this.childNodes.splice(index, 1);
      node.parentNode = undefined;
      return node;
    }
  }

  class FakePre extends FakeNode {
    constructor(markup = "") {
      super("PRE");
      this.markup = markup;
    }
  }

  class FakeShadowRoot extends FakeFragment {
    constructor(children = []) {
      super();
      for (const child of children) this.appendChild(child);
    }

    get pre() {
      return this.querySelector("pre");
    }

    insertBefore(node, reference) {
      if (node.nodeType === 11) {
        for (const child of [...node.childNodes]) this.insertBefore(child, reference);
        return node;
      }
      if (node === reference) return node;
      if (reference !== null && !this.childNodes.includes(reference))
        throw new TypeError("The reference node is not a child of this shadow root");
      node.parentNode?.removeChild(node);
      const index =
        reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
      this.childNodes.splice(index, 0, node);
      node.parentNode = this;
      return node;
    }

    appendChild(node) {
      return this.insertBefore(node, null);
    }

    removeChild(node) {
      const index = this.childNodes.indexOf(node);
      if (index === -1) throw new TypeError("The node is not a child of this shadow root");
      this.childNodes.splice(index, 1);
      node.parentNode = undefined;
      return node;
    }

    replaceChildren(...nodes) {
      for (const child of [...this.childNodes]) this.removeChild(child);
      for (const node of nodes) this.appendChild(node);
    }

    querySelector(selector) {
      if (selector === "pre") return this.childNodes.find((node) => node.tagName === "PRE");
      if (selector === "style[data-ferriki-code-base]")
        return this.childNodes.find(
          (node) => node.tagName === "STYLE" && node.hasAttribute("data-ferriki-code-base"),
        );
      if (selector === "link[data-ferriki-code-css]")
        return this.childNodes.find(
          (node) => node.tagName === "LINK" && node.hasAttribute("data-ferriki-code-css"),
        );
      throw new TypeError(`Unexpected selector: ${selector}`);
    }

    querySelectorAll(selector) {
      if (selector === "link[data-ferriki-code-css]")
        return this.childNodes.filter(
          (node) => node.tagName === "LINK" && node.hasAttribute("data-ferriki-code-css"),
        );
      throw new TypeError(`Unexpected selector: ${selector}`);
    }
  }

  class FakeLink extends FakeNode {
    constructor(href, marked = false) {
      super("LINK");
      this.setAttribute("rel", "stylesheet");
      if (href !== undefined) this.setAttribute("href", href);
      if (marked) this.setAttribute("data-ferriki-code-css", "");
    }
  }

  const fakeDocument = {
    createElement(tagName) {
      if (tagName === "template") {
        const template = new FakeNode("TEMPLATE");
        template.content = new FakeFragment();
        Object.defineProperty(template, "innerHTML", {
          get() {
            return template._html;
          },
          set(markup) {
            template._html = markup;
            template.content.replaceChildren();
            const node = /<pre(?:\s|>)/iu.test(markup) ? new FakePre(markup) : new FakeNode("SPAN");
            node.markup = markup;
            template.content.appendChild(node);
          },
        });
        return template;
      }
      return tagName === "pre" ? new FakePre() : new FakeNode(tagName.toUpperCase());
    },
    createComment(data) {
      return new FakeComment(data);
    },
  };

  let nextShadowRoot;
  let preUpgradeMaxLines;
  let preUpgradeProperties;
  let preUpgradeAttributes;
  const fakeCustomElements = {
    definitions: new Map(),
    get(name) {
      return this.definitions.get(name);
    },
    define(name, constructor) {
      this.definitions.set(name, constructor);
    },
  };

  const marker = new FakeComment("ferriki-code:late%2Dref");
  const serverStyle = new FakeNode("STYLE");
  serverStyle.setAttribute("data-ferriki-code-base", "");
  serverStyle.textContent = codeElementStyles();
  const serverLink = new FakeLink("/assets/code.8ad2.css", true);
  const unrelatedLink = new FakeLink("/author.css");
  const serverCode = new FakePre("<pre>late</pre>");
  const root = new FakeShadowRoot([marker, serverStyle, serverLink, unrelatedLink, serverCode]);

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
          this.shadowRoot = nextShadowRoot ?? new FakeShadowRoot();
          nextShadowRoot = undefined;
          this.attributes = new Map(Object.entries(preUpgradeAttributes ?? {}));
          preUpgradeAttributes = undefined;
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
          for (const [name, value] of Object.entries(preUpgradeProperties ?? {}))
            Object.defineProperty(this, name, { configurable: true, value, writable: true });
          preUpgradeProperties = undefined;
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

    const constructor = defineCodeElement({
      stylesheetHref: "/client-code.css",
      blocks: { first: "<pre>one</pre>", second: "<pre>two</pre>" },
    });

    const matchingMarker = new FakeComment("ferriki-code:second");
    const matchingStyle = new FakeNode("STYLE");
    matchingStyle.setAttribute("data-ferriki-code-base", "");
    matchingStyle.textContent = codeElementStyles();
    const matchingLink = new FakeLink("/assets/ssr-code.css", true);
    const matchingCode = new FakePre("<pre>two</pre>");
    const matchingRoot = new FakeShadowRoot([
      matchingMarker,
      matchingStyle,
      matchingLink,
      matchingCode,
    ]);
    const matchingHost = new constructor();
    matchingHost.shadowRoot = matchingRoot;
    matchingHost.setAttribute("code-ref", "second");
    matchingHost.connectedCallback();
    assert.equal(matchingRoot.firstChild, matchingMarker);
    assert.equal(matchingMarker.nextSibling, matchingStyle);
    assert.equal(matchingRoot.querySelector("pre"), matchingCode);
    assert.equal(matchingRoot.querySelector("link[data-ferriki-code-css]"), matchingLink);
    assert.equal(matchingLink.getAttribute("href"), "/assets/ssr-code.css");

    const configuredMarker = new FakeComment("ferriki-code:second");
    const configuredStyle = new FakeNode("STYLE");
    configuredStyle.setAttribute("data-ferriki-code-base", "");
    configuredStyle.textContent = codeElementStyles();
    const configuredLink = new FakeLink("/client-code.css", true);
    const configuredCode = new FakePre("<pre>two</pre>");
    const configuredRoot = new FakeShadowRoot([
      configuredMarker,
      configuredStyle,
      configuredLink,
      configuredCode,
    ]);
    const configuredHost = new constructor();
    configuredHost.shadowRoot = configuredRoot;
    configuredHost.setAttribute("code-ref", "second");
    configuredHost.connectedCallback();
    assert.equal(configuredRoot.querySelector("link[data-ferriki-code-css]"), configuredLink);
    assert.equal(configuredLink.getAttribute("href"), "/client-code.css");

    const host = new constructor();
    host.shadowRoot = root;
    host.setAttribute("code-ref", "late-ref");
    host.connectedCallback();

    assert.equal(root.firstChild, marker);
    assert.equal(marker.nextSibling, serverStyle);
    assert.equal(serverStyle.textContent, codeElementStyles());
    assert.equal(root.querySelector("link[data-ferriki-code-css]"), serverLink);
    assert.equal(serverLink.getAttribute("href"), "/assets/code.8ad2.css");
    assert.equal(root.childNodes.includes(unrelatedLink), true);
    assert.equal(root.childNodes.includes(serverCode), true);

    assert.equal(
      defineCodeElement({
        css: ".late-ref{color:red}",
        stylesheetHref: "/client-code-v2.css",
        blocks: { "late-ref": "<pre>late</pre>" },
      }),
      constructor,
    );
    assert.equal(root.firstChild, marker);
    assert.equal(marker.nextSibling, serverStyle);
    assert.equal(serverStyle.textContent.includes(".late-ref{color:red}"), true);
    assert.equal(root.querySelector("link[data-ferriki-code-css]"), serverLink);
    assert.equal(serverLink.getAttribute("href"), "/assets/code.8ad2.css");
    assert.equal(root.childNodes.includes(unrelatedLink), true);
    assert.equal(root.childNodes.includes(serverCode), true);
    assert.equal(root.querySelector("pre"), serverCode);
    assert.equal(root.querySelector("pre").markup, "<pre>late</pre>");
    assert.equal(configuredRoot.firstChild, configuredMarker);
    assert.equal(configuredMarker.nextSibling, configuredStyle);
    assert.equal(configuredRoot.querySelector("pre"), configuredCode);
    assert.equal(configuredRoot.querySelector("link[data-ferriki-code-css]"), configuredLink);
    assert.equal(configuredLink.getAttribute("href"), "/client-code-v2.css");
    assert.equal(matchingRoot.querySelector("link[data-ferriki-code-css]"), matchingLink);
    assert.equal(matchingLink.getAttribute("href"), "/assets/ssr-code.css");

    host.setAttribute("code-ref", "second");
    assert.equal(root.firstChild, serverStyle);
    assert.equal(root.querySelector("link[data-ferriki-code-css]"), serverLink);
    assert.equal(serverLink.getAttribute("href"), "/client-code-v2.css");
    assert.equal(root.childNodes.includes(unrelatedLink), false);
    assert.equal(root.childNodes.includes(marker), false);
    assert.notEqual(root.querySelector("pre"), serverCode);
    assert.equal(root.querySelector("pre").markup, "<pre>two</pre>");
    host.setAttribute("code-ref", "late-ref");
    assert.equal(root.firstChild, serverStyle);
    assert.equal(root.querySelector("link[data-ferriki-code-css]"), serverLink);
    assert.equal(root.querySelector("pre").markup, "<pre>late</pre>");

    matchingHost.setAttribute("code-ref", "first");
    assert.equal(matchingRoot.firstChild, matchingStyle);
    assert.equal(matchingRoot.querySelector("pre").markup, "<pre>one</pre>");
    assert.equal(matchingRoot.querySelector("link[data-ferriki-code-css]"), matchingLink);
    assert.equal(matchingLink.getAttribute("href"), "/client-code-v2.css");
    matchingHost.setAttribute("code-ref", "second");
    assert.equal(matchingRoot.firstChild, matchingStyle);
    assert.equal(matchingRoot.querySelector("pre").markup, "<pre>two</pre>");

    const pre = root.querySelector("pre");
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
    assert.equal(root.querySelector("pre"), pre);
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

    nextShadowRoot = new FakeShadowRoot();
    preUpgradeMaxLines = 4;
    const upgradedHost = new constructor();
    assert.equal(Object.hasOwn(upgradedHost, "maxLines"), false);
    upgradedHost.setAttribute("code-ref", "late-ref");
    upgradedHost.connectedCallback();
    assert.equal(upgradedHost.maxLines, 4);
    assert.equal(upgradedHost.getAttribute("max-lines"), "4");
    assert.equal(upgradedHost.shadowRoot.pre.getAttribute("tabindex"), "0");
    assert.equal(
      upgradedHost.shadowRoot.querySelector("link[data-ferriki-code-css]").getAttribute("href"),
      "/client-code-v2.css",
    );

    preUpgradeAttributes = { "code-ref": "second" };
    preUpgradeProperties = { codeRef: "first" };
    const reflectedHost = new constructor();
    reflectedHost.attributeChangedCallback("code-ref", null, "second");
    reflectedHost.connectedCallback();
    assert.equal(reflectedHost.codeRef, "first");
    assert.equal(reflectedHost.getAttribute("code-ref"), "first");
    assert.equal(reflectedHost.shadowRoot.pre.markup, "<pre>one</pre>");

    preUpgradeAttributes = { "code-ref": "second" };
    preUpgradeProperties = { codeRef: "first" };
    const disconnectedUpgrade = new constructor();
    disconnectedUpgrade.attributeChangedCallback("code-ref", null, "second");
    disconnectedUpgrade.setAttribute("code-ref", "late-ref");
    disconnectedUpgrade.connectedCallback();
    assert.equal(disconnectedUpgrade.codeRef, "late-ref");
    assert.equal(disconnectedUpgrade.getAttribute("code-ref"), "late-ref");
    assert.equal(disconnectedUpgrade.shadowRoot.pre.markup, "<pre>late</pre>");

    for (const properties of [
      { highlightedCode: "<pre>direct</pre>", codeRef: "first" },
      { codeRef: "first", highlightedCode: "<pre>direct</pre>" },
    ]) {
      preUpgradeProperties = properties;
      const mixedHost = new constructor();
      mixedHost.connectedCallback();
      assert.equal(mixedHost.getAttribute("code-ref"), "first");
      assert.equal(mixedHost.highlightedCode, "<pre>direct</pre>");
      assert.equal(mixedHost.shadowRoot.pre.markup, "<pre>direct</pre>");
      mixedHost.codeRef = "second";
      assert.equal(mixedHost.getAttribute("code-ref"), "second");
      assert.equal(mixedHost.shadowRoot.pre.markup, "<pre>two</pre>");
    }

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
