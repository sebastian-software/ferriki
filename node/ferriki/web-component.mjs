const DEFAULT_THEME_ALIASES = Object.freeze(["light", "dark"]);
const DEFINITION_BRAND = Symbol.for("ferriki.code-element.definition.v1");
const CONFIGURE_STYLES = Symbol.for("ferriki.code-element.configure-styles.v1");
const BLOCKS_CHANGED = Symbol.for("ferriki.code-element.blocks-changed.v1");

const BASE_STYLES = `
:host {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

:host,
:host *,
:host *::before,
:host *::after {
  box-sizing: border-box;
}

:host pre {
  margin: 0;
  max-block-size: var(--ferriki-code-max-block-size, none);
  max-width: 100%;
  overflow: auto;
  font-family: inherit;
  font-size: 0.875rem;
  font-style: normal;
  font-weight: normal;
  line-height: var(--ferriki-code-line-height, 1.3125rem);
  padding-block: var(--ferriki-code-padding-block, 0px);
  text-decoration: none;
}

:host pre > code {
  font: inherit;
}
`;

/** The host tag used by Ferriki's browser custom element. */
export const FERRIKI_CODE_TAG = "ferriki-code";

/**
 * Reserve host height for the known number of rendered code lines.
 * The caller supplies the build-time count, including any trailing blank lines.
 *
 * @param {number} lineCount
 * @param {number} [maxLines] Limit the reserved height and make the code pane scrollable.
 * @returns {{display: "block", boxSizing: "content-box", minBlockSize: string, "--ferriki-code-max-block-size"?: string}} The host sizing style.
 */
export function codeElementSizing(lineCount, maxLines) {
  if (!Number.isSafeInteger(lineCount) || lineCount <= 0)
    throw new TypeError("`lineCount` must be a positive safe integer");
  if (maxLines !== undefined && (!Number.isSafeInteger(maxLines) || maxLines <= 0))
    throw new TypeError("`maxLines` must be a positive safe integer when provided");

  const fullHeight = `calc(${lineCount} * var(--ferriki-code-line-height, 1.3125rem) + 2 * var(--ferriki-code-padding-block, 0px))`;
  const sizing = {
    display: "block",
    boxSizing: "content-box",
    minBlockSize: `min(${fullHeight}, var(--ferriki-code-max-block-size, ${fullHeight}))`,
  };
  if (maxLines !== undefined)
    sizing["--ferriki-code-max-block-size"] =
      `calc(${maxLines} * var(--ferriki-code-line-height, 1.3125rem) + 2 * var(--ferriki-code-padding-block, 0px))`;

  return sizing;
}

/**
 * Generate base and local theme-switching styles for the custom element.
 * Aliases are used as both `data-ferriki-theme` values and `--shiki-*` suffixes.
 *
 * @param {readonly string[]} [themeAliases]
 * @returns {string} CSS rules scoped to the custom element's shadow root.
 */
export function codeElementStyles(themeAliases = DEFAULT_THEME_ALIASES) {
  const aliases = validateThemeAliases(themeAliases);
  return [BASE_STYLES, ...aliases.map(themeAliasStyles)].join("\n");
}

/**
 * Explicitly register `<ferriki-code>`, add generated block CSS to the shared
 * stylesheet, and register trusted HTML blocks by code-ref ID. Registration
 * during server rendering is safe and returns `undefined`.
 *
 * CSS rules are accumulated for the lifetime of the document. Class-mode rules
 * use content-derived class names, so rules from replaced or HMR-updated blocks
 * become unused; they are reclaimed when the document is reloaded.
 *
 * @param {{css?: string, themeAliases?: readonly string[], blocks?: Readonly<Record<string, string>>}} [options]
 * @returns {(new () => FerrikiCodeElement) | undefined} The constructor, or `undefined` on the server.
 */
export function defineCodeElement(options = {}) {
  validateOptionsObject(options, "defineCodeElement options");
  const css = options.css === undefined ? "" : options.css;
  if (typeof css !== "string")
    throw new TypeError("defineCodeElement `css` must be a string when provided");
  const aliases =
    options.themeAliases === undefined
      ? DEFAULT_THEME_ALIASES
      : validateThemeAliases(options.themeAliases);
  const blocks = validateBlocks(options.blocks);

  const registry = globalThis.customElements;
  const HTMLElementConstructor = globalThis.HTMLElement;
  if (
    !registry ||
    typeof registry.get !== "function" ||
    typeof registry.define !== "function" ||
    typeof HTMLElementConstructor !== "function"
  )
    return undefined;

  const existing = registry.get(FERRIKI_CODE_TAG);
  if (existing) {
    if (existing[DEFINITION_BRAND] !== true || typeof existing[CONFIGURE_STYLES] !== "function")
      throw new TypeError(
        `Cannot define <${FERRIKI_CODE_TAG}> because another custom element already uses that tag`,
      );
    existing[CONFIGURE_STYLES](css, aliases, globalThis.document, blocks);
    return existing;
  }

  const documentStates = new WeakMap();
  const cssChunks = new Set();
  const blockRegistry = new Map();
  const connectedElements = new Set();
  let configuredProfile;

  function assertProfile(nextAliases) {
    const nextProfile = JSON.stringify(nextAliases);
    if (configuredProfile !== undefined && configuredProfile !== nextProfile)
      throw new TypeError(
        `The <${FERRIKI_CODE_TAG}> theme aliases are already configured as ${configuredProfile}; one document cannot use multiple alias sets`,
      );
    configuredProfile = nextProfile;
  }

  function registerDocumentStyles(doc) {
    if (!doc) return undefined;
    if (!doc.defaultView)
      throw new TypeError("Cannot register Ferriki styles for a document without a window");

    const view = doc.defaultView;
    const Sheet = view.CSSStyleSheet;
    if (
      typeof Sheet !== "function" ||
      typeof Sheet.prototype.replaceSync !== "function" ||
      !view.ShadowRoot?.prototype ||
      !("adoptedStyleSheets" in view.ShadowRoot.prototype)
    )
      throw new TypeError(
        "<ferriki-code> requires constructed stylesheets and ShadowRoot.adoptedStyleSheets",
      );

    let state = documentStates.get(doc);
    if (!state) {
      const sheet = new Sheet();
      state = { sheet, rules: new Set(), appliedChunks: new Set() };
      documentStates.set(doc, state);
      try {
        insertCssText(state, sheet, codeElementStyles(aliases), Sheet);
      } catch (error) {
        documentStates.delete(doc);
        throw error;
      }
    }

    for (const chunk of cssChunks) {
      if (state.appliedChunks.has(chunk)) continue;
      insertCssText(state, state.sheet, chunk, Sheet);
      state.appliedChunks.add(chunk);
    }
    return state;
  }

  function configureStyles(nextCss, nextAliases, doc, nextBlocks = new Map()) {
    assertProfile(nextAliases);
    assertBlocksCompatible(blockRegistry, nextBlocks);
    const addedChunk = nextCss && !cssChunks.has(nextCss);
    if (nextCss) cssChunks.add(nextCss);
    let state;
    try {
      state = registerDocumentStyles(doc);
    } catch (error) {
      if (addedChunk) cssChunks.delete(nextCss);
      throw error;
    }
    const changedBlockIds = mergeBlocks(blockRegistry, nextBlocks);
    if (changedBlockIds.size > 0) {
      for (const element of connectedElements) element[BLOCKS_CHANGED](changedBlockIds);
    }
    return state;
  }

  class FerrikiCodeElement extends HTMLElementConstructor {
    #initialized = false;
    #preserveUpgradeProperty = false;
    #replayingUpgradeProperty = false;
    #connected = false;
    #mode = "none";
    #value;
    #reference;
    #renderedMode;
    #renderedValue;
    #renderedReference;
    #installedDocument;
    #hasRendered = false;
    #maxLines;
    #maxLinesInitialized = false;
    #reflectingMaxLines = false;
    #pendingMaxLinesReflection = false;
    #managedTabIndexTarget;

    static get observedAttributes() {
      return ["highlightedcode", "highlighted-code", "code-ref", "max-lines", "maxlines"];
    }

    constructor() {
      super();
      // DSD may attach this root before a late custom-element upgrade. Reuse it
      // so an upgrade never clears its server-rendered contents.
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      const hasHighlightedCode = Object.prototype.hasOwnProperty.call(this, "highlightedCode");
      const hasCodeRef = Object.prototype.hasOwnProperty.call(this, "codeRef");
      const hasMaxLines = Object.prototype.hasOwnProperty.call(this, "maxLines");
      if (hasHighlightedCode || hasCodeRef || hasMaxLines) {
        this.#preserveUpgradeProperty = true;
        this.#replayingUpgradeProperty = true;
        if (hasCodeRef) this.#upgradeProperty("codeRef");
        if (hasHighlightedCode) this.#upgradeProperty("highlightedCode");
        if (hasMaxLines) this.#upgradeProperty("maxLines");
        this.#replayingUpgradeProperty = false;
      }
    }

    connectedCallback() {
      this.#connected = true;
      connectedElements.add(this);
      this.#preserveUpgradeProperty = false;
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      this.#installStyles();
      if (!this.#initialized) this.#readAttributes();
      else this.#render();
      if (!this.#maxLinesInitialized) {
        const maxLinesAttribute = this.#readMaxLinesAttribute();
        if (maxLinesAttribute.present) this.#setMaxLines(maxLinesAttribute.value, false);
      } else {
        this.#applyMaxLinesStyle();
        if (this.#pendingMaxLinesReflection) {
          this.#reflectMaxLines();
          this.#pendingMaxLinesReflection = false;
        }
      }
      this.#syncTabIndex();
    }

    disconnectedCallback() {
      // Keep the shadow tree and current value. Reconnection does not reread the
      // original server-rendered attribute.
      this.#connected = false;
      connectedElements.delete(this);
    }

    adoptedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      this.#installStyles();
      this.#render();
    }

    attributeChangedCallback(name, _oldValue, newValue) {
      if (this.#preserveUpgradeProperty) return;
      if (name === "max-lines" || name === "maxlines") {
        if (this.#reflectingMaxLines) return;
        const maxLinesAttribute = this.#readMaxLinesAttribute();
        this.#setMaxLines(maxLinesAttribute.value, false);
        return;
      }
      if (name === "code-ref") {
        this.#setReference(newValue === null ? undefined : newValue);
        return;
      }
      const value =
        newValue === null
          ? this.getAttribute(name === "highlightedcode" ? "highlighted-code" : "highlightedcode")
          : newValue;
      this.#setExplicitValue(value === null || value === "" ? undefined : value);
    }

    /** The trusted Ferriki HTML rendered inside the shadow root. */
    get highlightedCode() {
      if (this.#mode === "explicit") return this.#value;
      if (this.#mode === "reference")
        return this.#reference === undefined ? undefined : blockRegistry.get(this.#reference);
      if (!this.#initialized) {
        const value = this.getAttribute("highlightedcode") ?? this.getAttribute("highlighted-code");
        return value === null || value === "" ? undefined : value;
      }
      return undefined;
    }

    set highlightedCode(value) {
      if (value != null && typeof value !== "string")
        throw new TypeError("<ferriki-code>.highlightedCode must be a string, null, or undefined");
      this.#setExplicitValue(value == null || value === "" ? undefined : value);
    }

    /** The trusted HTML registry key used by this element, when present. */
    get codeRef() {
      if (this.#mode === "reference") return this.#reference;
      const value = this.getAttribute("code-ref");
      return value === null ? undefined : value;
    }

    set codeRef(value) {
      if (value != null && typeof value !== "string")
        throw new TypeError("<ferriki-code>.codeRef must be a string, null, or undefined");
      const reference = value == null ? undefined : value;
      this.#setReference(reference);
      if (!this.#replayingUpgradeProperty) {
        if (reference === undefined) this.removeAttribute("code-ref");
        else this.setAttribute("code-ref", reference);
      }
    }

    /** Maximum visible code lines, or undefined when the code pane is uncapped. */
    get maxLines() {
      return this.#maxLines;
    }

    set maxLines(value) {
      if (value != null && (!Number.isSafeInteger(value) || value <= 0))
        throw new TypeError(
          "<ferriki-code>.maxLines must be a positive safe integer, null, or undefined",
        );
      this.#setMaxLines(value == null ? undefined : value);
    }

    #readAttributes() {
      const reference = this.getAttribute("code-ref");
      if (reference !== null) {
        this.#setReference(reference);
        return;
      }
      const value = this.getAttribute("highlightedcode") ?? this.getAttribute("highlighted-code");
      this.#setExplicitValue(value === null || value === "" ? undefined : value);
    }

    #readMaxLinesAttribute() {
      const raw = this.getAttribute("max-lines") ?? this.getAttribute("maxlines");
      if (raw === null) return { present: false, value: undefined };
      const value = Number(raw);
      return {
        present: true,
        value: Number.isSafeInteger(value) && value > 0 ? value : undefined,
      };
    }

    #upgradeProperty(name) {
      if (!Object.prototype.hasOwnProperty.call(this, name)) return;
      const value = this[name];
      delete this[name];
      this[name] = value;
    }

    #setExplicitValue(value) {
      if (this.#initialized && this.#mode === "explicit" && this.#value === value) return;
      this.#initialized = true;
      this.#mode = "explicit";
      this.#value = value;
      this.#reference = undefined;
      this.#render();
    }

    #setReference(reference) {
      if (this.#initialized && this.#mode === "reference" && this.#reference === reference) return;
      this.#initialized = true;
      this.#mode = "reference";
      this.#reference = reference;
      this.#value = undefined;
      this.#render();
    }

    #setMaxLines(value, reflect = true) {
      this.#maxLinesInitialized = true;
      this.#maxLines = value;
      if (this.#replayingUpgradeProperty) {
        this.#pendingMaxLinesReflection = true;
        return;
      }
      if (reflect) this.#reflectMaxLines();
      this.#applyMaxLinesStyle();
      this.#syncTabIndex();
    }

    #reflectMaxLines() {
      this.#reflectingMaxLines = true;
      try {
        if (this.#maxLines === undefined) this.removeAttribute("max-lines");
        else this.setAttribute("max-lines", String(this.#maxLines));
        this.removeAttribute("maxlines");
      } finally {
        this.#reflectingMaxLines = false;
      }
    }

    #applyMaxLinesStyle() {
      const style = this.style;
      if (!style) return;
      if (this.#maxLines === undefined) style.removeProperty("--ferriki-code-max-block-size");
      else
        style.setProperty(
          "--ferriki-code-max-block-size",
          `calc(${this.#maxLines} * var(--ferriki-code-line-height, 1.3125rem) + 2 * var(--ferriki-code-padding-block, 0px))`,
        );
    }

    #syncTabIndex() {
      const current = this.shadowRoot?.querySelector?.("pre");
      if (this.#managedTabIndexTarget) {
        if (
          this.#managedTabIndexTarget !== current ||
          this.#maxLines === undefined ||
          this.#managedTabIndexTarget.getAttribute("tabindex") !== "0"
        ) {
          if (this.#managedTabIndexTarget.getAttribute("tabindex") === "0")
            this.#managedTabIndexTarget.removeAttribute("tabindex");
          this.#managedTabIndexTarget = undefined;
        }
      }
      if (
        this.#maxLines !== undefined &&
        this.#connected &&
        current &&
        !current.hasAttribute("tabindex")
      ) {
        current.setAttribute("tabindex", "0");
        this.#managedTabIndexTarget = current;
      }
    }

    #installStyles() {
      const state = registerDocumentStyles(this.ownerDocument);
      if (!state) return;
      const previous = this.shadowRoot.adoptedStyleSheets;
      if (previous.length !== 1 || previous[0] !== state.sheet)
        this.shadowRoot.adoptedStyleSheets = [state.sheet];
      this.#installedDocument = this.ownerDocument;
    }

    #render() {
      if (!this.shadowRoot || !this.#connected) return;
      if (this.#installedDocument !== this.ownerDocument) this.#installStyles();
      if (!this.#initialized) return;

      if (this.#mode === "reference" && this.#reference !== undefined) {
        const serverMarker = `ferriki-code:${encodeCodeReference(this.#reference)}`;
        const markerNode = this.shadowRoot.firstChild;
        if (markerNode?.nodeType === 8 && markerNode.data === serverMarker) {
          if (blockRegistry.has(this.#reference)) this.#removeServerStylesheetLinks();
          this.#hasRendered = true;
          this.#renderedMode = "reference";
          this.#renderedReference = this.#reference;
          this.#renderedValue = blockRegistry.get(this.#reference);
          this.#syncTabIndex();
          return;
        }
      }

      const value =
        this.#mode === "explicit"
          ? this.#value
          : this.#mode === "reference" && this.#reference !== undefined
            ? blockRegistry.get(this.#reference)
            : undefined;
      const reference = this.#mode === "reference" ? this.#reference : undefined;
      if (
        this.#hasRendered &&
        this.#renderedMode === this.#mode &&
        this.#renderedValue === value &&
        this.#renderedReference === reference
      ) {
        this.#syncTabIndex();
        return;
      }

      this.#renderedMode = this.#mode;
      this.#renderedValue = value;
      this.#renderedReference = reference;
      this.#hasRendered = true;

      if (value === undefined) {
        this.shadowRoot.replaceChildren(this.ownerDocument.createElement("slot"));
        this.#syncTabIndex();
        return;
      }

      const template = this.ownerDocument.createElement("template");
      // This sink is limited to the trusted HTML emitted by Ferriki's generator.
      template.innerHTML = value;
      this.shadowRoot.replaceChildren(template.content);
      this.#syncTabIndex();
    }

    #removeServerStylesheetLinks() {
      const state = registerDocumentStyles(this.ownerDocument);
      if (!state || !Array.from(this.shadowRoot.adoptedStyleSheets).includes(state.sheet)) return;
      for (const link of this.shadowRoot.querySelectorAll("link[data-ferriki-code-css]"))
        link.remove();
    }

    [BLOCKS_CHANGED](changedBlockIds) {
      if (
        this.#connected &&
        this.#mode === "reference" &&
        this.#reference !== undefined &&
        changedBlockIds.has(this.#reference)
      )
        this.#render();
    }
  }

  Object.defineProperty(FerrikiCodeElement, DEFINITION_BRAND, { value: true });
  Object.defineProperty(FerrikiCodeElement, CONFIGURE_STYLES, { value: configureStyles });

  assertProfile(aliases);
  if (css) cssChunks.add(css);
  mergeBlocks(blockRegistry, blocks);
  registerDocumentStyles(globalThis.document);
  registry.define(FERRIKI_CODE_TAG, FerrikiCodeElement);
  return FerrikiCodeElement;
}

function insertCssText(state, target, css, Sheet) {
  if (!css.trim()) return;
  const parsed = new Sheet();
  try {
    parsed.replaceSync(css);
  } catch (error) {
    throw new TypeError(`Invalid CSS passed to defineCodeElement: ${error.message}`, {
      cause: error,
    });
  }
  insertRules(state, target, parsed.cssRules);
}

function insertRules(state, target, rules) {
  for (const rule of Array.from(rules)) {
    const text = rule.cssText;
    if (state.rules.has(text)) continue;
    target.insertRule(text, target.cssRules.length);
    state.rules.add(text);
  }
}

function themeAliasStyles(alias) {
  const host = `:host([data-ferriki-theme="${alias}"])`;
  const inlineRoot = `${host} pre.shiki-themes[style*="--shiki-${alias}"]`;
  const classesRoot = `${host} pre[class*="ferriki-themes-"]`;

  return `
${inlineRoot} {
  color: var(--shiki-${alias}, inherit) !important;
  background-color: var(--shiki-${alias}-bg, inherit) !important;
}

${inlineRoot} span {
  color: var(--shiki-${alias}, inherit) !important;
}

${host} pre.shiki-themes span[style*="--shiki-${alias}-font-style"] {
  font-style: var(--shiki-${alias}-font-style, normal) !important;
}

${host} pre.shiki-themes span[style*="--shiki-${alias}-font-weight"] {
  font-weight: var(--shiki-${alias}-font-weight, normal) !important;
}

${host} pre.shiki-themes span[style*="--shiki-${alias}-text-decoration"] {
  text-decoration: var(--shiki-${alias}-text-decoration, none) !important;
}

${classesRoot} {
  --ferriki-color: var(--shiki-${alias});
  --ferriki-background: var(--shiki-${alias}-bg);
}

${classesRoot} .token {
  --ferriki-color: var(--shiki-${alias});
  --ferriki-font-style: var(--shiki-${alias}-font-style, normal);
  --ferriki-font-weight: var(--shiki-${alias}-font-weight, normal);
  --ferriki-text-decoration: var(--shiki-${alias}-text-decoration, none);
}
`;
}

function validateThemeAliases(themeAliases) {
  if (!Array.isArray(themeAliases))
    throw new TypeError("`themeAliases` must be an array of CSS-safe theme alias names");

  const seen = new Set();
  for (const alias of themeAliases) {
    if (typeof alias !== "string" || !/^[A-Za-z_][\w-]*$/u.test(alias))
      throw new TypeError(
        `Unsupported theme alias ${JSON.stringify(alias)}; start with a letter or underscore and use only ASCII letters, digits, underscores, and hyphens`,
      );
    if (seen.has(alias)) throw new TypeError(`Duplicate theme alias ${JSON.stringify(alias)}`);
    seen.add(alias);
  }
  return [...themeAliases];
}

function validateBlocks(blocks) {
  if (blocks === undefined) return new Map();
  if (blocks === null || typeof blocks !== "object" || Array.isArray(blocks))
    throw new TypeError("`blocks` must be a record of code-ref IDs to trusted HTML strings");

  const validated = new Map();
  for (const key of Reflect.ownKeys(blocks)) {
    if (typeof key !== "string" || !/^[\w-]+$/u.test(key))
      throw new TypeError(
        `Unsupported code-ref ID ${JSON.stringify(key)}; use one or more ASCII letters, digits, underscores, or hyphens`,
      );
    const html = blocks[key];
    if (typeof html !== "string")
      throw new TypeError(`Block ${JSON.stringify(key)} must map to a trusted HTML string`);
    validated.set(key, html);
  }
  return validated;
}

function mergeBlocks(registry, blocks) {
  assertBlocksCompatible(registry, blocks);

  const changed = new Set();
  for (const [id, html] of blocks) {
    if (registry.has(id)) continue;
    registry.set(id, html);
    changed.add(id);
  }
  return changed;
}

function assertBlocksCompatible(registry, blocks) {
  for (const [id, html] of blocks) {
    if (registry.has(id) && registry.get(id) !== html)
      throw new TypeError(
        `The <${FERRIKI_CODE_TAG}> code-ref ${JSON.stringify(id)} is already registered with different HTML`,
      );
  }
}

function encodeCodeReference(reference) {
  return encodeURIComponent(reference).replaceAll("-", "%2D");
}

function validateOptionsObject(options, label) {
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new TypeError(`${label} must be an object`);
}
