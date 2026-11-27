import { codeElementStyles } from "./web-component.mjs";

const CODE_REF_PATTERN = /^[\w-]+$/u;
const DEFAULT_THEME_ALIASES = Object.freeze(["light", "dark"]);
const HTML_WHITESPACE_PATTERN = /^[\t\n\f\r ]+$/u;
const RAW_TEXT_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);
const MANUAL_CONTENT_ATTRIBUTES = new Set([
  ".highlightedcode",
  "highlighted-code",
  "highlightedcode",
]);
const SVG_HTML_INTEGRATION_POINTS = new Set(["foreignobject", "desc", "title"]);
const MATHML_TEXT_INTEGRATION_POINTS = new Set(["mi", "mo", "mn", "ms", "mtext"]);
const HTML_ANNOTATION_ENCODINGS = new Set(["text/html", "application/xhtml+xml"]);
// WHATWG HTML5 §13.2.6.5 start tags that break out of foreign content (plus `<font color|face|size>`).
const FOREIGN_BREAKOUT_TAGS = new Set([
  "b",
  "big",
  "blockquote",
  "body",
  "br",
  "center",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "i",
  "img",
  "li",
  "listing",
  "menu",
  "meta",
  "nobr",
  "ol",
  "p",
  "pre",
  "ruby",
  "s",
  "small",
  "span",
  "strong",
  "strike",
  "sub",
  "sup",
  "table",
  "tt",
  "u",
  "ul",
  "var",
]);
const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const HTML_NAMED_ENTITIES = Object.freeze({
  AMP: "&",
  GT: ">",
  LT: "<",
  NewLine: "\n",
  QUOT: '"',
  Tab: "\t",
  amp: "&",
  apos: "'",
  dash: "-",
  gt: ">",
  hyphen: "-",
  lt: "<",
  plus: "+",
  quot: '"',
  sol: "/",
});

/**
 * Turn empty React-rendered reference hosts into declarative Shadow DOM.
 *
 * This scans one complete HTML string; it is not a streaming HTML parser or a
 * sanitizer. It ignores comments, declarations, raw-text/RCDATA elements, and
 * inert template contents. Only an empty `<ferriki-code code-ref="...">`
 * host with a matching trusted block is changed.
 *
 * @param {string} markup Complete server-rendered HTML.
 * @param {{blocks: Readonly<Record<string, string>>, stylesheetHref?: string, themeAliases?: readonly string[], includeNoscript?: boolean}} options
 * @returns {string} HTML with declarative Shadow DOM for eligible reference hosts.
 */
export function renderCodeElementShadows(markup, options) {
  if (typeof markup !== "string") throw new TypeError("`markup` must be a string");
  const { blocks, stylesheetHref, includeNoscript, themeAliases } =
    snapshotAndValidateOptions(options);
  const baseCss = codeElementStyles(
    themeAliases === undefined ? DEFAULT_THEME_ALIASES : themeAliases,
  );

  let outputCursor = 0;
  let scanCursor = 0;
  let templateDepth = 0;
  let foreignScriptDepth = 0;
  const namespaceStack = [];
  const scopeCounts = [new Map()];
  const output = [];

  while (scanCursor < markup.length) {
    const tagStart = markup.indexOf("<", scanCursor);
    if (tagStart === -1) break;

    const elementNs = currentElementNamespace(namespaceStack);
    const childNs = currentChildNamespace(namespaceStack);

    if (markup.startsWith("<!--", tagStart)) {
      const commentEnd = findHtmlCommentEnd(markup, tagStart);
      if (commentEnd === -1) break;
      scanCursor = commentEnd;
      continue;
    }

    if (elementNs !== "html" && markup.startsWith("<![CDATA[", tagStart)) {
      const cdataEnd = markup.indexOf("]]>", tagStart + 9);
      if (cdataEnd === -1) break;
      scanCursor = cdataEnd + 3;
      continue;
    }

    if (
      markup.startsWith("<!", tagStart) ||
      markup.startsWith("<?", tagStart) ||
      (markup.startsWith("</", tagStart) && !isAsciiLetter(markup.charCodeAt(tagStart + 2)))
    ) {
      const declarationEnd = markup.indexOf(">", tagStart + 2);
      if (declarationEnd === -1) break;
      scanCursor = declarationEnd + 1;
      continue;
    }

    const tag = parseTag(markup, tagStart);
    if (!tag) {
      scanCursor = tagStart + 1;
      continue;
    }

    if (tag.closing) {
      if (childNs !== "html" && (tag.name === "p" || tag.name === "br")) {
        while (namespaceStack.length > 0 && namespaceStack.at(-1).childNs !== "html") {
          const popped = popNamespaceTop(namespaceStack, scopeCounts);
          if (popped.foreignScript) foreignScriptDepth--;
          if (popped.isHtmlTemplate) templateDepth--;
        }
      } else {
        const popped = popNamespaceTag(namespaceStack, scopeCounts, tag.name);
        foreignScriptDepth -= popped.foreignScripts;
        templateDepth -= popped.htmlTemplates;
      }
      scanCursor = tag.end;
      continue;
    }

    if (tag.name === "svg" || tag.name === "math") {
      if (!tag.selfClosing) {
        const top = namespaceStack.at(-1);
        const nextNs =
          childNs === "html" ||
          (tag.name === "svg" && top?.elementNs === "math" && top?.tag === "annotation-xml")
            ? tag.name
            : childNs;
        pushNamespaceFrame(namespaceStack, scopeCounts, {
          tag: tag.name,
          elementNs: nextNs,
          childNs: nextNs,
        });
      }
      scanCursor = tag.end;
      continue;
    }

    if (childNs !== "html") {
      if (isForeignBreakoutTag(markup, tag)) {
        while (namespaceStack.length > 0 && namespaceStack.at(-1).childNs !== "html") {
          const popped = popNamespaceTop(namespaceStack, scopeCounts);
          if (popped.foreignScript) foreignScriptDepth--;
          if (popped.isHtmlTemplate) templateDepth--;
        }
      } else {
        if (tag.name === "script" && !tag.selfClosing) {
          foreignScriptDepth++;
          pushNamespaceFrame(namespaceStack, scopeCounts, {
            tag: "script",
            elementNs: childNs,
            childNs,
            foreignScript: true,
          });
        } else if (tag.name === "template" && !tag.selfClosing) {
          pushNamespaceFrame(namespaceStack, scopeCounts, {
            tag: "template",
            elementNs: childNs,
            childNs,
            isHtmlTemplate: false,
          });
        } else if (
          childNs === "svg" &&
          SVG_HTML_INTEGRATION_POINTS.has(tag.name) &&
          !tag.selfClosing
        ) {
          pushNamespaceFrame(namespaceStack, scopeCounts, {
            tag: tag.name,
            elementNs: "svg",
            childNs: "html",
          });
        } else if (childNs === "math" && !tag.selfClosing) {
          if (MATHML_TEXT_INTEGRATION_POINTS.has(tag.name)) {
            pushNamespaceFrame(namespaceStack, scopeCounts, {
              tag: tag.name,
              elementNs: "math",
              childNs: "html",
              mathTextIntegration: true,
            });
          } else if (tag.name === "annotation-xml") {
            const rawEncoding = parseAttributes(markup, tag).find(
              ({ name }) => name === "encoding",
            )?.value;
            const encoding =
              typeof rawEncoding === "string"
                ? decodeHtmlAttributeEntities(rawEncoding).toLowerCase()
                : undefined;
            pushNamespaceFrame(namespaceStack, scopeCounts, {
              tag: tag.name,
              elementNs: "math",
              childNs:
                encoding !== undefined && HTML_ANNOTATION_ENCODINGS.has(encoding) ? "html" : "math",
            });
          } else {
            pushNamespaceFrame(namespaceStack, scopeCounts, {
              tag: tag.name,
              elementNs: "math",
              childNs: "math",
            });
          }
        } else if (!tag.selfClosing) {
          pushNamespaceFrame(namespaceStack, scopeCounts, {
            tag: tag.name,
            elementNs: childNs,
            childNs,
          });
        }
        scanCursor = tag.end;
        continue;
      }
    }

    // WHATWG HTML5 §13.2.6.5: inside MathML text integration points (`mi`, `mo`, `mn`, `ms`,
    // `mtext`), `mglyph` and `malignmark` stay in the MathML namespace.
    if (
      namespaceStack.at(-1)?.mathTextIntegration &&
      (tag.name === "mglyph" || tag.name === "malignmark")
    ) {
      if (!tag.selfClosing) {
        pushNamespaceFrame(namespaceStack, scopeCounts, {
          tag: tag.name,
          elementNs: "math",
          childNs: "math",
        });
      }
      scanCursor = tag.end;
      continue;
    }

    if (RAW_TEXT_ELEMENTS.has(tag.name) && !(includeNoscript && tag.name === "noscript")) {
      if (tag.name === "plaintext") break;
      const rawTextClose =
        tag.name === "script"
          ? findScriptClose(markup, tag.end)
          : findRawTextClose(markup, tag.end, tag.name);
      if (rawTextClose === -1) break;
      scanCursor = rawTextClose;
      continue;
    }

    if (tag.name === "template") {
      templateDepth++;
      pushNamespaceFrame(namespaceStack, scopeCounts, {
        tag: "template",
        elementNs: "html",
        childNs: "html",
        isHtmlTemplate: true,
      });
      scanCursor = tag.end;
      continue;
    }

    const pushSkippedHtmlFrame = () => {
      if (namespaceStack.length > 0 && !HTML_VOID_ELEMENTS.has(tag.name)) {
        pushNamespaceFrame(namespaceStack, scopeCounts, {
          tag: tag.name,
          elementNs: "html",
          childNs: "html",
        });
      }
    };

    if (
      templateDepth > 0 ||
      foreignScriptDepth > 0 ||
      tag.name !== "ferriki-code" ||
      tag.selfClosing
    ) {
      pushSkippedHtmlFrame();
      scanCursor = tag.end;
      continue;
    }

    const attributes = parseAttributes(markup, tag);
    if (attributes.some(({ name }) => MANUAL_CONTENT_ATTRIBUTES.has(name))) {
      pushSkippedHtmlFrame();
      scanCursor = tag.end;
      continue;
    }

    const codeRefAttributes = attributes.filter(({ name }) => name === "code-ref");
    if (codeRefAttributes.length === 0) {
      pushSkippedHtmlFrame();
      scanCursor = tag.end;
      continue;
    }

    const emptyClose = findEmptyHostClose(markup, tag.end);
    if (!emptyClose) {
      pushSkippedHtmlFrame();
      scanCursor = tag.end;
      continue;
    }

    if (codeRefAttributes.length !== 1)
      throw new TypeError(
        "An empty <ferriki-code> host must have exactly one `code-ref` attribute",
      );

    const id = codeRefAttributes[0].value;
    if (typeof id !== "string" || !CODE_REF_PATTERN.test(id))
      throw new TypeError(
        `Unsupported code-ref ID ${JSON.stringify(id)}; use one or more ASCII letters, digits, underscores, or hyphens`,
      );
    if (!Object.hasOwn(blocks, id))
      throw new Error(`No trusted HTML block was provided for code-ref ${JSON.stringify(id)}`);

    output.push(markup.slice(outputCursor, tag.end));
    output.push(makeTemplate(id, blocks[id], stylesheetHref, baseCss));
    output.push(markup.slice(emptyClose.start, emptyClose.end));
    outputCursor = emptyClose.end;
    scanCursor = emptyClose.end;
  }

  if (output.length === 0) return markup;
  output.push(markup.slice(outputCursor));
  return output.join("");
}

function currentElementNamespace(stack) {
  return stack.length === 0 ? "html" : stack.at(-1).elementNs;
}

function currentChildNamespace(stack) {
  return stack.length === 0 ? "html" : stack.at(-1).childNs;
}

function isForeignBreakoutTag(markup, tag) {
  if (FOREIGN_BREAKOUT_TAGS.has(tag.name)) return true;
  if (tag.name === "font") {
    return parseAttributes(markup, tag).some(
      ({ name }) => name === "color" || name === "face" || name === "size",
    );
  }
  return false;
}

function isScopeBarrierFrame(frame) {
  return frame.isHtmlTemplate || (frame.elementNs !== "html" && frame.childNs === "html");
}

function pushNamespaceFrame(stack, scopeCounts, frame) {
  stack.push(frame);
  if (isScopeBarrierFrame(frame)) {
    scopeCounts.push(new Map([[frame.tag, 1]]));
  } else {
    const active = scopeCounts.at(-1);
    active.set(frame.tag, (active.get(frame.tag) || 0) + 1);
  }
}

function popNamespaceTop(stack, scopeCounts) {
  const frame = stack.pop();
  if (isScopeBarrierFrame(frame)) {
    scopeCounts.pop();
  } else {
    const active = scopeCounts.at(-1);
    const next = (active.get(frame.tag) || 1) - 1;
    if (next <= 0) active.delete(frame.tag);
    else active.set(frame.tag, next);
  }
  return frame;
}

function popNamespaceTag(stack, scopeCounts, tagName) {
  if (!scopeCounts.at(-1).has(tagName)) return { foreignScripts: 0, htmlTemplates: 0 };
  for (let index = stack.length - 1; index >= 0; index--) {
    const frame = stack[index];
    if (frame.tag === tagName) {
      let foreignScripts = 0;
      let htmlTemplates = 0;
      while (stack.length > index) {
        const popped = popNamespaceTop(stack, scopeCounts);
        if (popped.foreignScript) foreignScripts++;
        if (popped.isHtmlTemplate) htmlTemplates++;
      }
      return { foreignScripts, htmlTemplates };
    }
    if (isScopeBarrierFrame(frame)) return { foreignScripts: 0, htmlTemplates: 0 };
  }
  return { foreignScripts: 0, htmlTemplates: 0 };
}

function decodeHtmlAttributeEntities(value) {
  if (!value.includes("&")) return value;
  return value.replace(
    /&(?:#[xX]([\da-fA-F]+);?|#(\d+);?|([a-zA-Z]+);)/gu,
    (match, hex, dec, name) => {
      if (hex !== undefined || dec !== undefined) {
        const codePoint = Number.parseInt(hex ?? dec, hex !== undefined ? 16 : 10);
        if (
          Number.isNaN(codePoint) ||
          codePoint <= 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        )
          return match;
        return String.fromCodePoint(codePoint);
      }
      return Object.hasOwn(HTML_NAMED_ENTITIES, name) ? HTML_NAMED_ENTITIES[name] : match;
    },
  );
}

function snapshotAndValidateOptions(options) {
  if (!isRecord(options)) throw new TypeError("`options` must be an object");
  if (!Object.hasOwn(options, "blocks"))
    throw new TypeError("`blocks` must be a record of code-ref IDs to trusted HTML strings");
  const rawBlocks = options.blocks;
  if (!isRecord(rawBlocks))
    throw new TypeError("`blocks` must be a record of code-ref IDs to trusted HTML strings");

  const blocks = Object.create(null);
  for (const id of Reflect.ownKeys(rawBlocks)) {
    if (typeof id !== "string" || !CODE_REF_PATTERN.test(id))
      throw new TypeError(
        `Unsupported code-ref ID ${JSON.stringify(id)}; use one or more ASCII letters, digits, underscores, or hyphens`,
      );
    const html = rawBlocks[id];
    if (typeof html !== "string")
      throw new TypeError(
        `The trusted HTML block for code-ref ${JSON.stringify(id)} must be a string`,
      );
    blocks[id] = html;
  }

  const stylesheetHref = options.stylesheetHref;
  if (stylesheetHref !== undefined) validateStylesheetHref(stylesheetHref);
  const includeNoscript = options.includeNoscript;
  if (includeNoscript !== undefined && typeof includeNoscript !== "boolean")
    throw new TypeError("`includeNoscript` must be a boolean when provided");
  const themeAliases = options.themeAliases;
  return {
    blocks,
    stylesheetHref,
    includeNoscript: includeNoscript === true,
    themeAliases,
  };
}

function validateStylesheetHref(stylesheetHref) {
  if (typeof stylesheetHref !== "string" || stylesheetHref.length === 0)
    throw new TypeError("`stylesheetHref` must be a nonempty string when provided");
  if (containsControlCharacters(stylesheetHref))
    throw new TypeError("`stylesheetHref` cannot contain control characters");
  const trimmed = stylesheetHref.trim();
  if (trimmed.length === 0 || trimmed !== stylesheetHref)
    throw new TypeError(
      "`stylesheetHref` must be a relative path or an http(s) URL without leading or trailing whitespace",
    );
  if (trimmed.startsWith("//") || trimmed.startsWith("\\") || trimmed.startsWith("/\\"))
    throw new TypeError("`stylesheetHref` must be a relative path or an http(s) URL");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(trimmed)) {
    if (!/^https?:\/\//iu.test(trimmed))
      throw new TypeError("`stylesheetHref` must use an http(s) URL or a relative path");
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new TypeError("`stylesheetHref` must be a relative path or an http(s) URL");
    }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname)
      throw new TypeError("`stylesheetHref` must use an http(s) URL or a relative path");
    return stylesheetHref;
  }
  const firstDelimiter = trimmed.search(/[/?#]/u);
  const firstSegment = firstDelimiter === -1 ? trimmed : trimmed.slice(0, firstDelimiter);
  if (firstSegment.includes(":"))
    throw new TypeError("`stylesheetHref` must be a relative path or an http(s) URL");
  return stylesheetHref;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function makeTemplate(id, trustedHtml, stylesheetHref, baseCss) {
  const encodedId = encodeURIComponent(id).replaceAll("-", "%2D");
  const stylesheet =
    stylesheetHref === undefined
      ? ""
      : `<link rel="stylesheet" href="${escapeAttribute(stylesheetHref)}" data-ferriki-code-css>`;
  return `<template shadowrootmode="open"><!--ferriki-code:${encodedId}--><style data-ferriki-code-base>${baseCss}</style>${stylesheet}${trustedHtml}</template>`;
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseTag(markup, start) {
  if (markup[start] !== "<") return undefined;
  let cursor = start + 1;
  let closing = false;
  if (markup[cursor] === "/") {
    closing = true;
    cursor++;
  }
  if (!isAsciiLetter(markup.charCodeAt(cursor))) return undefined;

  const nameStart = cursor;
  while (cursor < markup.length && !isTagNameEnd(markup[cursor])) cursor++;
  const nameEnd = cursor;
  const name = markup.slice(nameStart, nameEnd).toLowerCase();
  const scanned = scanTagEnd(markup, cursor);
  if (!scanned) return undefined;

  return {
    closing,
    end: scanned.end,
    name,
    nameEnd,
    nameStart,
    selfClosing: !closing && scanned.selfClosing,
  };
}

function parseAttributes(markup, tag) {
  const attributes = [];
  let cursor = tag.nameEnd;
  const limit = tag.selfClosing ? tag.end - 2 : tag.end - 1;

  while (cursor < limit) {
    while (cursor < limit && (isHtmlWhitespace(markup[cursor]) || markup[cursor] === "/")) cursor++;
    if (cursor >= limit) break;

    const nameStart = cursor;
    while (
      cursor < limit &&
      !isHtmlWhitespace(markup[cursor]) &&
      markup[cursor] !== "=" &&
      markup[cursor] !== "/"
    )
      cursor++;
    if (cursor === nameStart) {
      cursor++;
      continue;
    }

    const name = markup.slice(nameStart, cursor).toLowerCase();
    while (cursor < limit && isHtmlWhitespace(markup[cursor])) cursor++;

    let value;
    if (markup[cursor] === "=") {
      cursor++;
      while (cursor < limit && isHtmlWhitespace(markup[cursor])) cursor++;
      const quote = markup[cursor];
      if (quote === '"' || quote === "'") {
        cursor++;
        const valueStart = cursor;
        while (cursor < limit && markup[cursor] !== quote) cursor++;
        value = markup.slice(valueStart, cursor);
        if (cursor < limit) cursor++;
      } else {
        const valueStart = cursor;
        while (cursor < limit && !isHtmlWhitespace(markup[cursor])) cursor++;
        value = markup.slice(valueStart, cursor);
      }
    }

    attributes.push({ name, value });
  }

  return attributes;
}

function findEmptyHostClose(markup, start) {
  let cursor = start;
  while (cursor < markup.length && isHtmlWhitespace(markup[cursor])) cursor++;
  const closing = parseTag(markup, cursor);
  if (!closing || !closing.closing || closing.name !== "ferriki-code") return undefined;
  if (!isOnlyHtmlWhitespace(markup.slice(closing.nameEnd, closing.end - 1))) return undefined;
  return { end: closing.end, start: cursor };
}

function findHtmlCommentEnd(markup, tagStart) {
  let cursor = tagStart + 4;
  if (markup[cursor] === ">") return cursor + 1;
  if (markup[cursor] === "-" && markup[cursor + 1] === ">") return cursor + 2;
  // WHATWG HTML5 §13.2.5.45-48: 0 = comment, 1 = end dash, 2 = end, 3 = end bang.
  let state = 0;
  while (cursor < markup.length) {
    const ch = markup[cursor++];
    if (state === 0) {
      if (ch === "-") state = 1;
    } else if (state === 1) {
      state = ch === "-" ? 2 : 0;
    } else if (state === 2) {
      if (ch === ">") return cursor;
      if (ch === "!") state = 3;
      else if (ch !== "-") state = 0;
    } else {
      if (ch === ">") return cursor;
      state = ch === "-" ? 1 : 0;
    }
  }
  return -1;
}

function isRawTextTagDelimiter(character) {
  return character === ">" || character === "/" || isHtmlWhitespace(character);
}

function findRawTextClose(markup, start, name) {
  for (let cursor = start; cursor <= markup.length - name.length - 3; cursor++) {
    if (markup[cursor] !== "<" || markup[cursor + 1] !== "/") continue;
    if (!asciiEqualIgnoreCaseAt(markup, cursor + 2, name)) continue;
    const afterName = markup[cursor + 2 + name.length];
    if (!isRawTextTagDelimiter(afterName)) continue;
    const closing = parseTag(markup, cursor);
    if (closing?.closing && closing.name === name) return closing.end;
  }
  return -1;
}

function findScriptClose(markup, start) {
  // WHATWG HTML5 §13.2.5.6 & §13.2.5.15-31:
  // 0 = script data, 1 = script data escaped, 2 = script data double-escaped.
  let state = 0;
  let cursor = start;
  while (cursor < markup.length) {
    if (state === 0) {
      if (markup.startsWith("<!--", cursor)) {
        cursor += 4;
        while (cursor < markup.length && markup[cursor] === "-") cursor++;
        if (markup[cursor] === ">") cursor++;
        else state = 1;
        continue;
      }
      if (
        markup[cursor] === "<" &&
        markup[cursor + 1] === "/" &&
        asciiEqualIgnoreCaseAt(markup, cursor + 2, "script") &&
        isRawTextTagDelimiter(markup[cursor + 8])
      ) {
        const closing = parseTag(markup, cursor);
        if (closing?.closing && closing.name === "script") return closing.end;
      }
      cursor++;
    } else if (state === 1) {
      if (markup.startsWith("-->", cursor)) {
        cursor += 3;
        state = 0;
        continue;
      }
      if (
        markup[cursor] === "<" &&
        markup[cursor + 1] === "/" &&
        asciiEqualIgnoreCaseAt(markup, cursor + 2, "script") &&
        isRawTextTagDelimiter(markup[cursor + 8])
      ) {
        const closing = parseTag(markup, cursor);
        if (closing?.closing && closing.name === "script") return closing.end;
      }
      if (
        markup[cursor] === "<" &&
        asciiEqualIgnoreCaseAt(markup, cursor + 1, "script") &&
        isRawTextTagDelimiter(markup[cursor + 7])
      ) {
        cursor += 8;
        state = 2;
        continue;
      }
      cursor++;
    } else {
      if (markup.startsWith("-->", cursor)) {
        cursor += 3;
        state = 0;
        continue;
      }
      if (
        markup[cursor] === "<" &&
        markup[cursor + 1] === "/" &&
        asciiEqualIgnoreCaseAt(markup, cursor + 2, "script") &&
        isRawTextTagDelimiter(markup[cursor + 8])
      ) {
        cursor += 9;
        state = 1;
        continue;
      }
      cursor++;
    }
  }
  return -1;
}

function scanTagEnd(markup, start) {
  // WHATWG HTML5 §13.2.5.32-40 tag attribute states.
  // 0 = before-attr-name, 1 = attr-name, 2 = after-attr-name,
  // 3 = before-attr-value, 4 = double-quoted, 5 = single-quoted,
  // 6 = after-attr-value-quoted, 7 = unquoted, 8 = self-closing-start-tag.
  let state = 0;
  let cursor = start;
  while (cursor < markup.length) {
    const ch = markup[cursor];
    if (state === 0) {
      if (isHtmlWhitespace(ch)) cursor++;
      else if (ch === "/") {
        state = 8;
        cursor++;
      } else if (ch === ">") {
        return { end: cursor + 1, selfClosing: false };
      } else {
        state = 1;
        cursor++;
      }
    } else if (state === 1) {
      if (isHtmlWhitespace(ch)) {
        state = 2;
        cursor++;
      } else if (ch === "/") {
        state = 8;
        cursor++;
      } else if (ch === "=") {
        state = 3;
        cursor++;
      } else if (ch === ">") {
        return { end: cursor + 1, selfClosing: false };
      } else {
        cursor++;
      }
    } else if (state === 2) {
      if (isHtmlWhitespace(ch)) cursor++;
      else if (ch === "/") {
        state = 8;
        cursor++;
      } else if (ch === "=") {
        state = 3;
        cursor++;
      } else if (ch === ">") {
        return { end: cursor + 1, selfClosing: false };
      } else {
        state = 1;
        cursor++;
      }
    } else if (state === 3) {
      if (isHtmlWhitespace(ch)) cursor++;
      else if (ch === '"') {
        state = 4;
        cursor++;
      } else if (ch === "'") {
        state = 5;
        cursor++;
      } else if (ch === ">") {
        return { end: cursor + 1, selfClosing: false };
      } else {
        state = 7;
        cursor++;
      }
    } else if (state === 4) {
      if (ch === '"') state = 6;
      cursor++;
    } else if (state === 5) {
      if (ch === "'") state = 6;
      cursor++;
    } else if (state === 6) {
      if (isHtmlWhitespace(ch)) {
        state = 0;
        cursor++;
      } else if (ch === "/") {
        state = 8;
        cursor++;
      } else if (ch === ">") {
        return { end: cursor + 1, selfClosing: false };
      } else {
        state = 1;
        cursor++;
      }
    } else if (state === 7) {
      if (isHtmlWhitespace(ch)) {
        state = 0;
        cursor++;
      } else if (ch === ">") {
        return { end: cursor + 1, selfClosing: false };
      } else {
        cursor++;
      }
    } else {
      if (ch === ">") return { end: cursor + 1, selfClosing: true };
      state = 0;
    }
  }
  return undefined;
}

function isOnlyHtmlWhitespace(value) {
  return value === "" || HTML_WHITESPACE_PATTERN.test(value);
}

function isHtmlWhitespace(character) {
  return (
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r" ||
    character === " "
  );
}

function isTagNameEnd(character) {
  return (
    character === undefined || isHtmlWhitespace(character) || character === "/" || character === ">"
  );
}

function isAsciiLetter(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function asciiEqualIgnoreCaseAt(value, start, expected) {
  if (start + expected.length > value.length) return false;
  for (let offset = 0; offset < expected.length; offset++) {
    let code = value.charCodeAt(start + offset);
    if (code >= 65 && code <= 90) code += 32;
    if (code !== expected.charCodeAt(offset)) return false;
  }
  return true;
}
