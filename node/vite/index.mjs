import { createHash } from "node:crypto";
import { createHighlighter, ShikiError } from "@ferriki/core";
import MagicString from "magic-string";
import { parseAst } from "vite";

import { MACRO_MODULE_SPECIFIERS, MacroDiagnostic, scanInlineCodeMacros } from "./macro-scan.mjs";

const VIRTUAL_CSS_PREFIX = "virtual:ferriki-vite/";
/** A JavaScript or TypeScript module ID; a query after the path is allowed. */
const SCRIPT_ID = /^[^?]*\.[cm]?[jt]sx?(?:\?|$)/;
const LINE_CSS = [
  ".ferriki-highlight-line[data-ln]::before{content:attr(data-ln);display:inline-block;min-width:2.5em;margin-right:1.5em;padding-right:.75em;text-align:right;opacity:.55}",
  ".ferriki-highlight-line.highlighted{background:color-mix(in srgb,currentColor 10%,transparent)}",
].join("\n");

const DEFAULT_THEME = "github-dark-default";

/**
 * Prepare Ferriki's inline highlighting macros before the framework lowers JSX.
 * Only modules that import `@ferriki/core/macro` or `@ferriki/core/react/macro`
 * reach the transform; they are parsed once with Vite's own parser.
 * @param {import("./index.d.mts").FerrikiViteOptions} options
 * @returns {import("vite").Plugin} A plugin that replaces `code()` calls and `<Code />` elements.
 */
export function ferriki(options = {}) {
  if (options.theme && options.themes)
    throw new TypeError("Pass either `theme` or `themes`, not both");
  if (options.transformers !== undefined && !Array.isArray(options.transformers))
    throw new ShikiError("`transformers` option must be an array", "ERR_USAGE");

  const theme = options.theme ?? (options.themes ? undefined : DEFAULT_THEME);
  const themes = options.themes;
  if (themes && Object.keys(themes).length === 0)
    throw new ShikiError("`themes` option must not be empty", "ERR_USAGE");
  const styleMode = options.styleMode ?? "inline";
  const lineNumbers = options.lineNumbers ?? false;
  const transformers = [...(options.transformers ?? [])];
  const themeNames = themes ? [...new Set(Object.values(themes))] : [theme];
  const include = options.include;
  let highlighterPromise;
  const languageLoads = new Map();
  const virtualCss = new Map();
  const warnedFiles = new Set();

  function getHighlighter() {
    highlighterPromise ??= createHighlighter({ themes: themeNames, assets: options.assets });
    return highlighterPromise;
  }

  function warnOnce(context, id, language, cause) {
    const key = id.split("?", 1)[0];
    if (warnedFiles.has(key)) return;
    warnedFiles.add(key);
    context.warn(
      `Ferriki could not highlight language "${language}" in ${id}; keeping the block as plain code (${cause?.message ?? "unknown language"}).`,
    );
  }

  async function highlight(context, id, code, language, meta, effectiveLineNumbers) {
    const highlighter = await getHighlighter();
    let loading = languageLoads.get(language);
    if (!loading) {
      loading = Promise.resolve().then(() => highlighter.loadLanguage(language));
      languageLoads.set(language, loading);
    }
    try {
      await loading;
    } catch (error) {
      languageLoads.delete(language);
      if (error?.code === "ERR_UNSUPPORTED") {
        warnOnce(context, id, language, error);
        return { html: plainCodeHtml(code, language, meta, effectiveLineNumbers), css: "" };
      }
      throw error;
    }

    const transformer = createMetaTransformer(meta, effectiveLineNumbers);
    const highlightOptions = {
      lang: language,
      ...(themes ? { themes, defaultColor: Object.keys(themes)[0] } : { theme }),
      styleMode,
      transformers: [...transformers, transformer],
    };
    try {
      if (styleMode === "classes") return highlighter.codeToHtmlWithCss(code, highlightOptions);
      return { html: highlighter.codeToHtml(code, highlightOptions), css: "" };
    } catch (error) {
      if (error?.code === "ERR_UNSUPPORTED") {
        warnOnce(context, id, language, error);
        return { html: plainCodeHtml(code, language, meta, effectiveLineNumbers), css: "" };
      }
      throw error;
    }
  }

  function makeCssModule(css) {
    const id = `${VIRTUAL_CSS_PREFIX}${createHash("sha256").update(css).digest("hex")}.css`;
    virtualCss.set(id, css);
    return id;
  }

  return {
    name: "@ferriki/vite",
    enforce: "pre",

    resolveId(id) {
      if (id.startsWith(VIRTUAL_CSS_PREFIX) && virtualCss.has(id)) return `\0${id}`;
      return null;
    },

    load(id) {
      if (id.startsWith("\0")) return virtualCss.get(id.slice(1)) ?? null;
      return null;
    },

    transform: {
      // Vite and Rolldown evaluate this before calling the handler, so a module
      // that does not spell out a macro specifier is never parsed. The code
      // filter is a substring test, not evidence: the parse decides. A
      // function `include` cannot be expressed as a host filter and is checked
      // in the handler instead.
      filter: include
        ? { code: MACRO_MODULE_SPECIFIERS }
        : { id: SCRIPT_ID, code: MACRO_MODULE_SPECIFIERS },

      async handler(source, id, meta) {
        // Repeat the filter for hosts or callers that invoke the handler directly.
        if (!(SCRIPT_ID.test(id) || include?.(id))) return null;
        if (!MACRO_MODULE_SPECIFIERS.some((specifier) => source.includes(specifier))) return null;

        const path = id.split("?", 1)[0];
        const lang = parserLanguage(path);
        let program;
        try {
          program = parseAst(source, { lang, preserveParens: true }, id);
        } catch (error) {
          return this.error(error);
        }

        let scan;
        try {
          scan = scanInlineCodeMacros(program, source);
        } catch (error) {
          if (error instanceof MacroDiagnostic) return reportMacroError(this, id, source, error);
          throw error;
        }
        if (scan.calls.length === 0 && scan.imports.length === 0) return null;

        const magic = new MagicString(source);
        const macroCss = new Set();
        const needsRenderHelper = scan.calls.some((call) =>
          call.presentation?.some((item) => item.name === "render"),
        );
        const renderHelperName = needsRenderHelper
          ? uniqueIdentifierName(scan.names, "FerrikiMacroRenderHelper")
          : undefined;
        // Lower the innermost calls first; an enclosing React element only
        // rewrites the text around its presentation expressions.
        const calls = [...scan.calls].sort(
          (left, right) =>
            left.end - left.start - (right.end - right.start) || left.start - right.start,
        );
        for (const call of calls) {
          const parsedMeta = parseMeta(call.meta ?? "");
          // A call-level setting replaces the Vite default, while an explicit
          // showLineNumbers annotation remains an opt-in in its own right.
          const effectiveLineNumbers = parsedMeta.lineNumbers || (call.lineNumbers ?? lineNumbers);
          const rendered = await highlight(
            this,
            id,
            call.code,
            call.language,
            parsedMeta,
            effectiveLineNumbers,
          );
          const descriptorCss = [
            rendered.css,
            effectiveLineNumbers || parsedMeta.highlightedLines.size ? LINE_CSS : "",
          ]
            .filter(Boolean)
            .join("\n");
          const descriptor = createPreparedCodeBlock(
            call.code,
            call.language,
            rendered.html,
            descriptorCss,
            parsedMeta,
            effectiveLineNumbers,
          );
          lowerMacroCall(magic, call, descriptor, renderHelperName);
          if (descriptorCss) macroCss.add(descriptorCss);
        }

        for (const item of scan.imports) {
          if (item.replacement) magic.overwrite(item.start, item.end, item.replacement);
          else magic.remove(item.start, item.end);
        }
        if (needsRenderHelper) magic.append(`\n${renderHelperSource(renderHelperName)}\n`);
        const css = [...macroCss].join("\n");
        if (css) magic.append(`\nimport ${JSON.stringify(makeCssModule(css))};\n`);

        const result = {
          code: magic.toString(),
          map: magic.generateMap({ hires: true, includeContent: true, source: id }),
        };
        // React elements lower to JSX. An included module ID without a JSX
        // extension would otherwise not be treated as JSX by Rolldown.
        if (
          scan.calls.some((call) => call.kind === "react") &&
          !/\.[jt]sx$/.test(path) &&
          meta?.moduleType !== "jsx" &&
          meta?.moduleType !== "tsx"
        )
          result.moduleType = lang === "jsx" ? "jsx" : "tsx";
        return result;
      },
    },
  };
}

/** Mirror the parser's file-type detection, with TSX for extensionless virtual modules. */
function parserLanguage(path) {
  if (/\.[cm]?ts$/.test(path)) return "ts";
  if (/\.tsx$/.test(path)) return "tsx";
  if (/\.[cm]?jsx?$/.test(path)) return "jsx";
  return "tsx";
}

function reportMacroError(context, id, source, diagnostic) {
  const error = new Error(diagnostic.message);
  error.name = "FerrikiMacroError";
  error.code = "FERRIKI_MACRO";
  error.id = id;
  error.loc = { file: id, ...lineAndColumn(source, diagnostic.offset) };
  // The offset lets Vite and Rolldown draw the code frame from the text this
  // plugin received; `loc` uses Rollup's 1-based line and 0-based column.
  return context.error(error, diagnostic.offset);
}

function lineAndColumn(source, offset) {
  const before = source.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: offset - lineStart };
}

function createMetaTransformer(meta, defaultLineNumbers) {
  // Ferriki's transformer nodes carry HTML attribute names, as Shiki's do.
  const addClass = (node, name) => {
    const existing = node.properties.class;
    const classes = Array.isArray(existing)
      ? existing
      : typeof existing === "string"
        ? existing.split(/\s+/)
        : [];
    node.properties.class = [...new Set([...classes.filter(Boolean), name])].join(" ");
  };
  return {
    name: "ferriki-vite-metadata",
    pre(node) {
      if (meta.title !== undefined) node.properties["data-title"] = meta.title;
      if (meta.label !== undefined) node.properties["data-label"] = meta.label;
    },
    line(node, line) {
      if (defaultLineNumbers || meta.lineNumbers) node.properties["data-ln"] = line;
      if (meta.highlightedLines.has(line)) addClass(node, "highlighted");
      if (defaultLineNumbers || meta.lineNumbers || meta.highlightedLines.size)
        addClass(node, "ferriki-highlight-line");
    },
  };
}

function parseMeta(raw = "") {
  const titleMatch = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)')/.exec(raw);
  const title = titleMatch?.[1] ?? titleMatch?.[2];
  const rest = titleMatch
    ? `${raw.slice(0, titleMatch.index)} ${raw.slice(titleMatch.index + titleMatch[0].length)}`
    : raw;
  const label = /\[([^\]]+)\]/.exec(rest)?.[1]?.trim();
  const selection = /(?:^|\s)\{([\d,-]+)\}(?=\s|$)/.exec(rest)?.[1];
  const highlightedLines = new Set();
  if (selection) {
    for (const part of selection.split(",")) {
      const [first, last = first] = part.split("-").map(Number);
      if (first < 1 || last < first || last > 10000) continue;
      for (let line = first; line <= last; line++) highlightedLines.add(line);
    }
  }
  return {
    title,
    label,
    highlightedLines,
    lineNumbers: /(?:^|\s)showLineNumbers(?:\s|$)/.test(rest),
  };
}

// Same escaping as Ferriki's native HTML renderer.
function escapeHtmlText(value) {
  return value.replaceAll("&", "&#x26;").replaceAll("<", "&#x3C;");
}

function escapeHtmlAttribute(value) {
  return escapeHtmlText(value).replaceAll('"', "&#x22;");
}

/** Escaped plain code with the same `pre`/`code` shape and line markup as highlighted output. */
function plainCodeHtml(code, language, meta, lineNumbers) {
  let preAttributes = ' class="shiki"';
  if (meta.title !== undefined) preAttributes += ` data-title="${escapeHtmlAttribute(meta.title)}"`;
  if (meta.label !== undefined) preAttributes += ` data-label="${escapeHtmlAttribute(meta.label)}"`;
  const annotated = lineNumbers || meta.highlightedLines.size > 0;
  const content = annotated
    ? code
        .split("\n")
        .map((line, index) => {
          const number = index + 1;
          const classes = meta.highlightedLines.has(number)
            ? "ferriki-highlight-line highlighted"
            : "ferriki-highlight-line";
          const lineNumber = lineNumbers ? ` data-ln="${number}"` : "";
          return `<span class="${classes}"${lineNumber}>${escapeHtmlText(line)}</span>`;
        })
        .join("\n")
    : escapeHtmlText(code);
  return `<pre${preAttributes}><code class="${escapeHtmlAttribute(`language-${language}`)}">${content}</code></pre>`;
}

function createPreparedCodeBlock(code, language, html, css, meta, lineNumbers) {
  const highlightedLines = [...meta.highlightedLines];
  const metadata = {
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    ...(meta.label !== undefined ? { label: meta.label } : {}),
    lineNumbers,
    highlightedLines,
  };
  return { code, language, html, css, metadata };
}

function safeJsLiteral(value) {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g, (character) => {
    if (character === "<") return "\\u003c";
    return character === "\u2028" ? "\\u2028" : "\\u2029";
  });
}

function lowerMacroCall(magic, call, descriptor, renderHelperName) {
  const { start, end } = call;
  if (call.kind !== "react") {
    const literal = safeJsLiteral(descriptor);
    magic.overwrite(start, end, call.wrap ? `(${literal})` : literal);
    return;
  }

  const presentation = call.presentation.map((item) => ({
    ...item,
    isLiteral: item.name === "className" && item.literal !== undefined,
  }));
  if (presentation.length === 0) {
    magic.overwrite(
      start,
      end,
      `<div dangerouslySetInnerHTML={{ __html: ${safeJsLiteral(descriptor.html)} }} />`,
    );
    return;
  }

  const hasRenderer = presentation.some((item) => item.name === "render");
  const first = presentation[0];
  const attributeStart = (item) => `${item.name}${item.isLiteral ? "=" : "={"}`;
  if (hasRenderer) {
    magic.overwrite(
      start,
      first.start,
      `<${renderHelperName} code={${safeJsLiteral(descriptor)}} ${attributeStart(first)}`,
    );
  } else {
    magic.overwrite(start, first.start, `<div ${attributeStart(first)}`);
  }

  for (let index = 1; index < presentation.length; index++) {
    const previous = presentation[index - 1];
    const current = presentation[index];
    magic.overwrite(
      previous.end,
      current.start,
      `${previous.isLiteral ? "" : "}"} ${attributeStart(current)}`,
    );
  }

  const last = presentation.at(-1);
  const suffix = hasRenderer
    ? `${last.isLiteral ? "" : "}"} />`
    : `${last.isLiteral ? "" : "}"} dangerouslySetInnerHTML={{ __html: ${safeJsLiteral(descriptor.html)} }} />`;
  magic.overwrite(last.end, end, suffix);
}

function uniqueIdentifierName(used, base) {
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) candidate = `${base}${suffix++}`;
  return candidate;
}

function renderHelperSource(name) {
  return `function ${name}(props) {
  const { code, render, ...presentationProps } = props;
  if (render === undefined)
    return <div {...presentationProps} dangerouslySetInnerHTML={{ __html: code.html }} />;
  return render({ code, ...presentationProps });
}`;
}
