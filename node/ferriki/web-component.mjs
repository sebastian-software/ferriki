const DEFAULT_THEME_ALIASES = Object.freeze(["light", "dark"]);
const DEFINITION_BRAND = Symbol.for("ferriki.code-element.definition.v1");
const CONFIGURE_STYLES = Symbol.for("ferriki.code-element.configure-styles.v1");
const BLOCKS_CHANGED = Symbol.for("ferriki.code-element.blocks-changed.v1");
const STYLES_CHANGED = Symbol.for("ferriki.code-element.styles-changed.v1");
const BASE_STYLE_ATTRIBUTE = "data-ferriki-code-base";
const CSS_LINK_ATTRIBUTE = "data-ferriki-code-css";

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

:where(pre) {
  color: var(--ferriki-foreground, inherit);
  background-color: var(--ferriki-background-color, transparent);
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

.ferriki-highlight-line[data-ln]::before {
  content: attr(data-ln);
  display: inline-block;
  min-width: 2.5em;
  margin-right: 1.5em;
  padding-right: 0.75em;
  text-align: right;
  opacity: 0.55;
}

.ferriki-highlight-line.highlighted {
  background: color-mix(in srgb, currentColor 10%, transparent);
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
 * Explicitly register `<ferriki-code>`, add optional local CSS to each shadow
 * root, and register trusted HTML blocks by code-ref ID. A `stylesheetHref`
 * adds a shared external stylesheet link to each root. Registration during
 * server rendering is safe and returns `undefined`.
 *
 * Explicit local `css` additions accumulate for the lifetime of the document.
 * Updating `stylesheetHref` refreshes the linked palette in existing roots.
 *
 * @param {{css?: string, stylesheetHref?: string, themeAliases?: readonly string[], blocks?: Readonly<Record<string, string>>}} [options]
 * @returns {(new () => FerrikiCodeElement) | undefined} The constructor, or `undefined` on the server.
 */
export function defineCodeElement(options = {}) {
  validateOptionsObject(options, "defineCodeElement options");
  const css = options.css === undefined ? "" : options.css;
  if (typeof css !== "string")
    throw new TypeError("defineCodeElement `css` must be a string when provided");
  const stylesheetHref = validateStylesheetHref(options.stylesheetHref);
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
    existing[CONFIGURE_STYLES](css, aliases, globalThis.document, blocks, stylesheetHref);
    return existing;
  }

  const cssChunks = new Set();
  const blockRegistry = new Map();
  const connectedElements = new Set();
  let configuredProfile;
  let configuredStylesheetHref = stylesheetHref;

  function assertProfile(nextAliases) {
    const nextProfile = JSON.stringify(nextAliases);
    if (configuredProfile !== undefined && configuredProfile !== nextProfile)
      throw new TypeError(
        `The <${FERRIKI_CODE_TAG}> theme aliases are already configured as ${configuredProfile}; one document cannot use multiple alias sets`,
      );
    configuredProfile = nextProfile;
  }

  function configureStyles(nextCss, nextAliases, _doc, nextBlocks = new Map(), nextStylesheetHref) {
    assertProfile(nextAliases);
    assertBlocksCompatible(blockRegistry, nextBlocks);
    if (nextCss) cssChunks.add(nextCss);
    const previousStylesheetHref = configuredStylesheetHref;
    if (nextStylesheetHref !== undefined) configuredStylesheetHref = nextStylesheetHref;
    for (const element of connectedElements) element[STYLES_CHANGED](previousStylesheetHref);
    const changedBlockIds = mergeBlocks(blockRegistry, nextBlocks);
    if (changedBlockIds.size > 0) {
      for (const element of connectedElements) element[BLOCKS_CHANGED](changedBlockIds);
    }
  }

  class FerrikiCodeElement extends HTMLElementConstructor {
    #initialized = false;
    #upgradeAttributes;
    #replayingUpgradeProperty = false;
    #reflectingCodeRef = false;
    #pendingCodeRefReflection;
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
        this.#upgradeAttributes = new Map(
          FerrikiCodeElement.observedAttributes
            .map((name) => [name, this.getAttribute(name)])
            .filter(([, value]) => value !== null),
        );
        this.#replayingUpgradeProperty = true;
        // Pre-definition own properties carry no assignment history. Prefer
        // direct HTML when both content interfaces are supplied before upgrade.
        if (hasCodeRef) this.#upgradeProperty("codeRef");
        if (hasHighlightedCode) this.#upgradeProperty("highlightedCode");
        if (hasMaxLines) this.#upgradeProperty("maxLines");
        this.#replayingUpgradeProperty = false;
      }
    }

    connectedCallback() {
      this.#connected = true;
      connectedElements.add(this);
      this.#upgradeAttributes = undefined;
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      this.#installStyles();
      if (!this.#initialized) this.#readAttributes();
      else this.#render();
      if (this.#pendingCodeRefReflection) {
        const { value } = this.#pendingCodeRefReflection;
        this.#reflectCodeRef(value);
      }
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

    attributeChangedCallback(name, oldValue, newValue) {
      if (this.#upgradeAttributes?.has(name)) {
        const originalValue = this.#upgradeAttributes.get(name);
        this.#upgradeAttributes.delete(name);
        if (oldValue === null && newValue === originalValue) return;
      }
      if (name === "max-lines" || name === "maxlines") {
        if (this.#reflectingMaxLines) return;
        const maxLinesAttribute = this.#readMaxLinesAttribute();
        this.#setMaxLines(maxLinesAttribute.value, false);
        return;
      }
      if (name === "code-ref") {
        if (this.#reflectingCodeRef) return;
        this.#pendingCodeRefReflection = undefined;
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
      if (this.#replayingUpgradeProperty) this.#pendingCodeRefReflection = { value: reference };
      else this.#reflectCodeRef(reference);
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

    #reflectCodeRef(reference) {
      this.#pendingCodeRefReflection = undefined;
      this.#reflectingCodeRef = true;
      try {
        if (reference === undefined) this.removeAttribute("code-ref");
        else this.setAttribute("code-ref", reference);
      } finally {
        this.#reflectingCodeRef = false;
      }
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
      const root = this.shadowRoot;
      const doc = this.ownerDocument;
      if (!root || !doc) return;

      let style = root.querySelector?.(`style[${BASE_STYLE_ATTRIBUTE}]`);
      if (!style) {
        style = doc.createElement("style");
        style.setAttribute(BASE_STYLE_ATTRIBUTE, "");
      }
      const css = [codeElementStyles(aliases), ...cssChunks]
        .filter((chunk) => chunk.trim())
        .join("\n");
      if (style.textContent !== css) style.textContent = css;

      const marker = isServerMarkerNode(root.firstChild) ? root.firstChild : undefined;
      const styleReference = marker ? marker.nextSibling : root.firstChild;
      moveNodeBefore(root, style, styleReference);

      let link = root.querySelector?.(`link[${CSS_LINK_ATTRIBUTE}]`);
      if (!link && configuredStylesheetHref !== undefined) {
        link = doc.createElement("link");
        link.setAttribute("rel", "stylesheet");
        link.setAttribute("href", configuredStylesheetHref);
        link.setAttribute(CSS_LINK_ATTRIBUTE, "");
      }
      if (link) moveNodeBefore(root, link, style.nextSibling);
      this.#installedDocument = this.ownerDocument;
    }

    #render() {
      if (!this.shadowRoot || !this.#connected) return;
      if (this.#installedDocument !== this.ownerDocument) this.#installStyles();
      if (!this.#initialized) return;

      if (this.#mode === "reference" && this.#reference !== undefined) {
        const serverMarker = `ferriki-code:${encodeCodeReference(this.#reference)}`;
        const markerNode = this.shadowRoot.firstChild;
        if (isServerMarkerNode(markerNode) && markerNode.data === serverMarker) {
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
        this.#replaceContent(undefined);
        this.#syncTabIndex();
        return;
      }

      const template = this.ownerDocument.createElement("template");
      // This sink is limited to the trusted HTML emitted by Ferriki's generator.
      template.innerHTML = value;
      this.#replaceContent(template.content);
      this.#syncTabIndex();
    }

    #replaceContent(content) {
      const root = this.shadowRoot;
      const infrastructure = Array.from(root.childNodes).filter(isInfrastructureNode);
      const stylesheetLink = root.querySelector?.(`link[${CSS_LINK_ATTRIBUTE}]`);
      if (
        stylesheetLink &&
        configuredStylesheetHref !== undefined &&
        stylesheetLink.getAttribute("href") !== configuredStylesheetHref
      )
        stylesheetLink.setAttribute("href", configuredStylesheetHref);
      for (const node of Array.from(root.childNodes))
        if (!infrastructure.includes(node)) root.removeChild(node);
      if (content === undefined) {
        const slot = this.ownerDocument.createElement("slot");
        root.appendChild(slot);
      } else {
        root.appendChild(content);
      }
    }

    [STYLES_CHANGED](previousStylesheetHref) {
      if (!this.#connected) return;
      if (
        previousStylesheetHref !== undefined &&
        configuredStylesheetHref !== previousStylesheetHref
      ) {
        const link = this.shadowRoot?.querySelector?.(`link[${CSS_LINK_ATTRIBUTE}]`);
        if (link?.getAttribute("href") === previousStylesheetHref)
          link.setAttribute("href", configuredStylesheetHref);
      }
      this.#installStyles();
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
  registry.define(FERRIKI_CODE_TAG, FerrikiCodeElement);
  return FerrikiCodeElement;
}

function moveNodeBefore(root, node, reference) {
  if (node === reference) return;
  if (node.parentNode === root && node.nextSibling === reference) return;
  root.insertBefore(node, reference ?? null);
}

function isInfrastructureNode(node) {
  return (
    node.hasAttribute?.(BASE_STYLE_ATTRIBUTE) === true ||
    node.hasAttribute?.(CSS_LINK_ATTRIBUTE) === true
  );
}

function isServerMarkerNode(node) {
  return (
    node?.nodeType === 8 && typeof node.data === "string" && node.data.startsWith("ferriki-code:")
  );
}

function themeAliasStyles(alias) {
  const host = `:host([data-ferriki-theme="${alias}"])`;
  const inlineRoot = `${host} pre.shiki-themes[style*="--shiki-${alias}"]`;
  const classesRoot = `${host} pre[class*="ferriki-themes-"]`;

  return `
${inlineRoot} {
  color: var(--ferriki-foreground, var(--shiki-${alias}, inherit)) !important;
  background-color: var(--ferriki-background-color, var(--shiki-${alias}-bg, inherit)) !important;
}

${inlineRoot} span:not(.ferriki-color-authored) {
  --_ferriki-token-theme-color: var(--shiki-${alias}, inherit);
  color: var(--_ferriki-token-color, var(--shiki-${alias}, inherit)) !important;
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
  --ferriki-color: var(--ferriki-foreground, var(--shiki-${alias}));
  --ferriki-background: var(--ferriki-background-color, var(--shiki-${alias}-bg));
}

${classesRoot} .token {
  --ferriki-color: var(--shiki-${alias});
  --_ferriki-token-theme-color: var(--shiki-${alias});
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

function validateStylesheetHref(stylesheetHref) {
  if (stylesheetHref === undefined) return undefined;
  if (typeof stylesheetHref !== "string" || stylesheetHref.length === 0)
    throw new TypeError("`stylesheetHref` must be a nonempty string when provided");
  for (const character of stylesheetHref) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f)
      throw new TypeError("`stylesheetHref` cannot contain control characters");
  }
  return stylesheetHref;
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
