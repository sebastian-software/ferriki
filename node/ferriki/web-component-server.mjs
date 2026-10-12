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

/**
 * Turn empty React-rendered reference hosts into declarative Shadow DOM.
 *
 * This scans one complete HTML string; it is not a streaming HTML parser or a
 * sanitizer. It ignores comments, declarations, raw-text/RCDATA elements, and
 * inert template contents. Only an empty `<ferriki-code code-ref="...">`
 * host with a matching trusted block is changed.
 *
 * @param {string} markup Complete server-rendered HTML.
 * @param {{blocks: Readonly<Record<string, string>>, stylesheetHref?: string, themeAliases?: readonly string[]}} options
 * @returns {string} HTML with declarative Shadow DOM for eligible reference hosts.
 */
export function renderCodeElementShadows(markup, options) {
  if (typeof markup !== "string") throw new TypeError("`markup` must be a string");
  validateOptions(options);
  const baseCss = codeElementStyles(
    options.themeAliases === undefined ? DEFAULT_THEME_ALIASES : options.themeAliases,
  );

  let outputCursor = 0;
  let scanCursor = 0;
  let templateDepth = 0;
  const output = [];

  while (scanCursor < markup.length) {
    const tagStart = markup.indexOf("<", scanCursor);
    if (tagStart === -1) break;

    if (markup.startsWith("<!--", tagStart)) {
      const commentEnd = markup.indexOf("-->", tagStart + 4);
      if (commentEnd === -1) break;
      scanCursor = commentEnd + 3;
      continue;
    }

    if (markup.startsWith("<!", tagStart) || markup.startsWith("<?", tagStart)) {
      const declarationEnd = findQuotedTagEnd(markup, tagStart + 2);
      if (declarationEnd === -1) break;
      scanCursor = declarationEnd;
      continue;
    }

    const tag = parseTag(markup, tagStart);
    if (!tag) {
      scanCursor = tagStart + 1;
      continue;
    }

    if (tag.closing) {
      if (tag.name === "template" && templateDepth > 0) templateDepth--;
      scanCursor = tag.end;
      continue;
    }

    if (RAW_TEXT_ELEMENTS.has(tag.name)) {
      if (tag.name === "plaintext") break;
      const rawTextClose = findRawTextClose(markup, tag.end, tag.name);
      if (rawTextClose === -1) break;
      scanCursor = rawTextClose;
      continue;
    }

    if (tag.name === "template") {
      templateDepth++;
      scanCursor = tag.end;
      continue;
    }

    if (templateDepth > 0 || tag.name !== "ferriki-code" || tag.selfClosing) {
      scanCursor = tag.end;
      continue;
    }

    const attributes = parseAttributes(markup, tag);
    if (attributes.some(({ name }) => MANUAL_CONTENT_ATTRIBUTES.has(name))) {
      scanCursor = tag.end;
      continue;
    }

    const codeRefAttributes = attributes.filter(({ name }) => name === "code-ref");
    if (codeRefAttributes.length === 0) {
      scanCursor = tag.end;
      continue;
    }

    const emptyClose = findEmptyHostClose(markup, tag.end);
    if (!emptyClose) {
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
    if (!Object.hasOwn(options.blocks, id))
      throw new Error(`No trusted HTML block was provided for code-ref ${JSON.stringify(id)}`);

    output.push(markup.slice(outputCursor, tag.end));
    output.push(makeTemplate(id, options.blocks[id], options.stylesheetHref, baseCss));
    output.push(markup.slice(emptyClose.start, emptyClose.end));
    outputCursor = emptyClose.end;
    scanCursor = emptyClose.end;
  }

  if (output.length === 0) return markup;
  output.push(markup.slice(outputCursor));
  return output.join("");
}

function validateOptions(options) {
  if (!isRecord(options)) throw new TypeError("`options` must be an object");
  if (!Object.hasOwn(options, "blocks"))
    throw new TypeError("`blocks` must be a record of code-ref IDs to trusted HTML strings");
  if (!isRecord(options.blocks))
    throw new TypeError("`blocks` must be a record of code-ref IDs to trusted HTML strings");

  for (const id of Reflect.ownKeys(options.blocks)) {
    if (typeof id !== "string" || !CODE_REF_PATTERN.test(id))
      throw new TypeError(
        `Unsupported code-ref ID ${JSON.stringify(id)}; use one or more ASCII letters, digits, underscores, or hyphens`,
      );
    const html = options.blocks[id];
    if (typeof html !== "string")
      throw new TypeError(
        `The trusted HTML block for code-ref ${JSON.stringify(id)} must be a string`,
      );
  }

  if (options.stylesheetHref !== undefined) {
    if (typeof options.stylesheetHref !== "string" || options.stylesheetHref.length === 0)
      throw new TypeError("`stylesheetHref` must be a nonempty string when provided");
    if (containsControlCharacters(options.stylesheetHref))
      throw new TypeError("`stylesheetHref` cannot contain control characters");
  }
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
  const end = findQuotedTagEnd(markup, cursor);
  if (end === -1) return undefined;

  return {
    closing,
    end,
    name,
    nameEnd,
    nameStart,
    selfClosing: !closing && markup[end - 2] === "/",
  };
}

function parseAttributes(markup, tag) {
  const attributes = [];
  let cursor = tag.nameEnd;
  const limit = tag.end - 1;

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

function findRawTextClose(markup, start, name) {
  for (let cursor = start; cursor < markup.length - name.length - 2; cursor++) {
    if (markup[cursor] !== "<" || markup[cursor + 1] !== "/") continue;
    if (!asciiEqualIgnoreCaseAt(markup, cursor + 2, name)) continue;
    const afterName = markup[cursor + 2 + name.length];
    if (afterName !== ">" && !isHtmlWhitespace(afterName)) continue;
    const closing = parseTag(markup, cursor);
    if (closing?.closing && closing.name === name) return cursor;
  }
  return -1;
}

function findQuotedTagEnd(markup, start) {
  let quote;
  for (let cursor = start; cursor < markup.length; cursor++) {
    const character = markup[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return cursor + 1;
    }
  }
  return -1;
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
  for (let offset = 0; offset < expected.length; offset++) {
    let code = value.charCodeAt(start + offset);
    if (code >= 65 && code <= 90) code += 32;
    if (code !== expected.charCodeAt(offset)) return false;
  }
  return true;
}
