import { createHash } from "node:crypto";
import { posix } from "node:path";
import { createHighlighter, ShikiError } from "@ferriki/core";
import { codeElementStyles } from "@ferriki/core/web-component";
import { renderCodeElementShadows } from "@ferriki/core/web-component/server";
import MagicString from "magic-string";
import { parseAst } from "vite";

import { createCodeElementColorTransformer } from "./code-element-colors.mjs";
import { MACRO_MODULE_SPECIFIERS, MacroDiagnostic, scanInlineCodeMacros } from "./macro-scan.mjs";

const VIRTUAL_CSS_PREFIX = "virtual:ferriki-vite/";
const CODE_STYLESHEET_MODULE = `${VIRTUAL_CSS_PREFIX}code-element-stylesheet-url`;
const CODE_STYLESHEET_META = "FERRIKI_CODE_STYLESHEET_URL";
const DEV_CODE_STYLESHEET_PATH = "@ferriki/code-elements.css";
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
 * @returns {import("./index.d.mts").FerrikiVitePlugin} A plugin that prepares code macros.
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
  const reactModules = new Map();
  let resolvedConfig;
  let configuredBase;
  let devServer;
  const buildStylesheets = new WeakMap();

  function preparedReactBlocks() {
    return Object.fromEntries(
      [...reactModules.values()].flatMap(({ blocks }) =>
        [...blocks].map(([ref, block]) => [ref, block.html]),
      ),
    );
  }

  function preparedReactCss() {
    if (styleMode !== "classes") return "";
    const css = new Set();
    for (const { blocks } of reactModules.values()) {
      for (const block of blocks.values())
        if (block.css) for (const rule of cssRules(block.css)) css.add(rule);
    }
    return [...css].join("\n");
  }

  function refreshReactCss(previousPalette) {
    if (!devServer) return;
    const palette = preparedReactCss();
    if (palette !== previousPalette)
      devServer.ws.send({
        type: "custom",
        event: "ferriki:code-element-css",
        data: {
          href: `${devServer.config.base}${DEV_CODE_STYLESHEET_PATH}?v=${createHash("sha256").update(palette).digest("hex")}`,
        },
      });
  }

  function removeReactModules(ids) {
    const previousPalette = devServer ? preparedReactCss() : undefined;
    for (const id of ids) reactModules.delete(id);
    refreshReactCss(previousPalette);
  }

  function reactModuleIdsForFile(file) {
    return [...reactModules.keys()].filter((id) => id.split("?", 1)[0] === file);
  }

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

  async function highlight(context, id, code, language, meta, effectiveLineNumbers, codeElement) {
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
      ...(codeElement
        ? { includeExplanation: "scopeName", mergeWhitespaces: false, mergeSameStyleTokens: false }
        : {}),
      transformers: [
        ...transformers,
        transformer,
        ...(codeElement ? [createCodeElementColorTransformer()] : []),
      ],
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
    api: {
      codeElementBlocks: preparedReactBlocks,
      renderCodeElements(markup, options = {}) {
        return renderCodeElementShadows(markup, {
          themeAliases: themes ? Object.keys(themes) : [],
          ...options,
          blocks: preparedReactBlocks(),
        });
      },
      codeElementCss: preparedReactCss,
    },

    config: {
      order: "post",
      handler(config) {
        configuredBase = config.base;
      },
    },

    configResolved(config) {
      resolvedConfig = config;
    },

    configureServer(server) {
      if (styleMode !== "classes") return;
      devServer = server;
      const pathname = `${server.config.base}${DEV_CODE_STYLESHEET_PATH}`;
      server.middlewares.use((request, response, next) => {
        if ((request.url ?? "").split("?", 1)[0] !== pathname) return next();
        response.setHeader("Content-Type", "text/css; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache");
        response.end(preparedReactCss());
      });
    },

    async hotUpdate({ type, file, read }) {
      const ids = reactModuleIdsForFile(file);
      if (!ids.length) return;
      // The host's code filter skips transforms after the last macro import is
      // removed, so clear its saved blocks here without parsing ordinary code.
      if (type === "delete") {
        removeReactModules(ids);
        return;
      }
      if (type !== "update") return;
      const source = await read();
      if (!MACRO_MODULE_SPECIFIERS.some((specifier) => source.includes(specifier)))
        removeReactModules(ids);
    },

    watchChange(file, { event }) {
      if (event === "delete") removeReactModules(reactModuleIdsForFile(file));
    },

    buildEnd(error) {
      if (
        error ||
        styleMode !== "classes" ||
        resolvedConfig?.command !== "build" ||
        !Object.keys(preparedReactBlocks()).length
      )
        return;
      const source = preparedReactCss();
      const reference = this.emitFile({ type: "asset", name: "ferriki-code.css", source });
      buildStylesheets.set(this.environment, { reference, source });
    },

    renderChunk(code, chunk) {
      const expression = `import.meta.${CODE_STYLESHEET_META}`;
      if (!code.includes(expression)) return null;
      const stylesheet = buildStylesheets.get(this.environment);
      if (!stylesheet) return this.error("Ferriki's prepared code stylesheet is missing");
      const base = resolvedConfig.base;
      if (
        (configuredBase === "./" || configuredBase === "") &&
        this.environment.config.consumer === "server"
      )
        return this.error("Ferriki React macro SSR requires an absolute Vite `base` path or URL");
      const filename = this.getFileName(stylesheet.reference)
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const relativeBase = base === "./" || base === "";
      const relativeFilename = relativeBase
        ? posix.relative(posix.dirname(chunk.fileName), filename)
        : undefined;
      const stylesheetUrl = relativeBase
        ? `new URL(${safeJsLiteral(relativeFilename)}, import.meta.url).href`
        : safeJsLiteral(`${base.replace(/\/+$/u, "")}/${filename}`);
      const magic = new MagicString(code);
      magic.replaceAll(expression, stylesheetUrl);
      return {
        code: magic.toString(),
        map: resolvedConfig.build.sourcemap ? magic.generateMap({ hires: true }) : null,
      };
    },

    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const stylesheet = buildStylesheets.get(this.environment);
        if (!stylesheet) return;
        const filename = this.getFileName(stylesheet.reference);
        // Vite normally suppresses SSR assets. Preserve this required CSS file
        // without changing the application's asset policy for other imports.
        if (!bundle[filename])
          this.emitFile({ type: "asset", fileName: filename, source: stylesheet.source });
      },
    },

    resolveId(id) {
      if (id === CODE_STYLESHEET_MODULE) return `\0${id}`;
      if (id.startsWith(VIRTUAL_CSS_PREFIX) && virtualCss.has(id)) return `\0${id}`;
      return null;
    },

    load(id) {
      if (id === `\0${CODE_STYLESHEET_MODULE}`) {
        const devHref = `${resolvedConfig?.base ?? "/"}${DEV_CODE_STYLESHEET_PATH}`;
        return {
          code:
            resolvedConfig?.command === "build"
              ? `export default import.meta.${CODE_STYLESHEET_META};`
              : `import { defineCodeElement } from "@ferriki/core/web-component";\nlet stylesheetHref = ${safeJsLiteral(devHref)};\nexport { stylesheetHref as default };\nif (import.meta.hot) import.meta.hot.on("ferriki:code-element-css", ({ href }) => {\n  stylesheetHref = href;\n  if (globalThis.customElements?.get("ferriki-code")?.[Symbol.for("ferriki.code-element.definition.v1")] === true)\n    defineCodeElement({ stylesheetHref, themeAliases: ${safeJsLiteral(themes ? Object.keys(themes) : [])} });\n});`,
          moduleSideEffects: resolvedConfig?.command !== "build",
        };
      }
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
        if (
          !(SCRIPT_ID.test(id) || include?.(id)) ||
          !MACRO_MODULE_SPECIFIERS.some((specifier) => source.includes(specifier))
        ) {
          if (reactModules.has(id)) removeReactModules([id]);
          return null;
        }

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
        if (scan.calls.length === 0 && scan.imports.length === 0) {
          if (reactModules.has(id)) removeReactModules([id]);
          return null;
        }

        const magic = new MagicString(source);
        const macroCss = new Set();
        const renderedReactCss = new Map();
        const reactBlocks = new Map();
        const customRendererRefs = new Set();
        const needsRenderHelper = scan.calls.some((call) => call.kind === "react");
        if (needsRenderHelper && themes) codeElementStyles(Object.keys(themes));
        const renderHelperName = needsRenderHelper
          ? uniqueIdentifierName(scan.names, "FerrikiMacroRenderHelper")
          : undefined;
        const registrationName = needsRenderHelper
          ? uniqueIdentifierName(scan.names, "FerrikiDefineCodeElement")
          : undefined;
        const sizingName = needsRenderHelper
          ? uniqueIdentifierName(scan.names, "FerrikiCodeElementSizing")
          : undefined;
        const codeSizesName = needsRenderHelper
          ? uniqueIdentifierName(scan.names, "FerrikiCodeSizes")
          : undefined;
        const codeElementConfigName = needsRenderHelper
          ? uniqueIdentifierName(scan.names, "FerrikiCodeElementConfig")
          : undefined;
        const codeBlocksName = needsRenderHelper
          ? uniqueIdentifierName(scan.names, "FerrikiCodeBlocks")
          : undefined;
        const codeElementRegisteredName = needsRenderHelper
          ? uniqueIdentifierName(scan.names, "FerrikiCodeElementRegistered")
          : undefined;
        const stylesheetName =
          needsRenderHelper && styleMode === "classes"
            ? uniqueIdentifierName(scan.names, "FerrikiCodeStylesheetUrl")
            : undefined;
        const stylesheetHrefName =
          needsRenderHelper && styleMode === "classes"
            ? uniqueIdentifierName(scan.names, "FerrikiCodeStylesheetHref")
            : undefined;
        const serverHtmlName = needsRenderHelper
          ? uniqueIdentifierName(scan.names, "FerrikiCodeServerHtml")
          : undefined;
        const serverStylesName = needsRenderHelper
          ? uniqueIdentifierName(scan.names, "FerrikiCodeServerStyles")
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
            call.kind === "react",
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
          const codeRef =
            call.kind === "react"
              ? `ferriki-${createHash("sha256").update(JSON.stringify(descriptor)).digest("hex")}`
              : undefined;
          if (codeRef) {
            reactBlocks.set(codeRef, descriptor);
            renderedReactCss.set(codeRef, rendered.css);
          }
          lowerMacroCall(magic, call, descriptor, renderHelperName, codeRef);
          const hasCustomRenderProp =
            call.kind === "react" && call.presentation.some((item) => item.name === "render");
          if (hasCustomRenderProp) customRendererRefs.add(codeRef);
          // Default React hosts share styles through the element definition.
          // Descriptor consumers and syntactic custom renderers keep ordinary CSS delivery.
          if (descriptorCss && (call.kind !== "react" || hasCustomRenderProp))
            macroCss.add(descriptorCss);
        }
        const previousPalette = devServer ? preparedReactCss() : undefined;
        reactModules.set(id, {
          blocks: new Map(
            [...reactBlocks].map(([ref, block]) => [
              ref,
              { html: block.html, css: renderedReactCss.get(ref) },
            ]),
          ),
        });
        refreshReactCss(previousPalette);

        for (const item of scan.imports) {
          if (item.replacement) magic.overwrite(item.start, item.end, item.replacement);
          else magic.remove(item.start, item.end);
        }
        if (needsRenderHelper) {
          // Initialize prepared content before authored code can eagerly render a
          // macro, while keeping framework directive prologues first.
          let helperOffset = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
          for (const statement of program.body) {
            if (typeof statement.directive !== "string") break;
            helperOffset = statement.end;
          }
          const registrySource = [...reactBlocks.keys()]
            .map((ref) => `${JSON.stringify(ref)}: ${codeBlocksName}[${JSON.stringify(ref)}].html`)
            .join(", ");
          const sizingSource = [...reactBlocks]
            .map(([ref, block]) => {
              const lineCount = block.code.split(/\r\n|\r|\n/u).length;
              return `${JSON.stringify(ref)}: { lineCount: ${lineCount}, style: ${sizingName}(${lineCount}) }`;
            })
            .join(", ");
          const preparedBlocks = Object.fromEntries(
            [...reactBlocks].map(([ref, block]) => [
              ref,
              customRendererRefs.has(ref) ? block : { ...block, css: "" },
            ]),
          );
          const aliases = themes ? Object.keys(themes) : [];
          const serverStyles = `<style data-ferriki-code-base>${codeElementStyles(aliases)}</style>`;
          const stylesheetImport = stylesheetName
            ? `import ${stylesheetName} from ${JSON.stringify(CODE_STYLESHEET_MODULE)};`
            : "";
          const stylesheetConfig = stylesheetName ? `, stylesheetHref: ${stylesheetName}` : "";
          const escapedStylesheetHref = stylesheetName
            ? `const ${stylesheetHrefName} = import.meta.env.SSR ? ${stylesheetName}.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") : undefined;`
            : "";
          const serverHtmlSource = [...reactBlocks.keys()]
            .map((ref) => {
              const marker = encodeURIComponent(ref).replaceAll("-", "%2D");
              const link = stylesheetName
                ? ` + ${safeJsLiteral('<link rel="stylesheet" href="')} + ${stylesheetHrefName} + ${safeJsLiteral('" data-ferriki-code-css>')}`
                : "";
              return `${JSON.stringify(ref)}: { __html: ${safeJsLiteral(`<template shadowrootmode="open"><!--ferriki-code:${marker}-->`)} + ${serverStylesName}${link} + ${codeBlocksName}[${JSON.stringify(ref)}].html + "</template>" }`;
            })
            .join(", ");
          magic.appendLeft(
            helperOffset,
            [
              `\nimport { defineCodeElement as ${registrationName} } from "@ferriki/core/web-component";`,
              `import { codeElementSizing as ${sizingName} } from "@ferriki/core/web-component";`,
              stylesheetImport,
              `const ${codeBlocksName} = ${safeJsLiteral(preparedBlocks)};`,
              `const ${codeSizesName} = { ${sizingSource} };`,
              `const ${codeElementConfigName} = { ...${safeJsLiteral({ themeAliases: aliases })}${stylesheetConfig}, blocks: { ${registrySource} } };`,
              escapedStylesheetHref,
              `const ${serverStylesName} = import.meta.env.SSR ? ${safeJsLiteral(serverStyles)} : undefined;`,
              `const ${serverHtmlName} = import.meta.env.SSR ? { ${serverHtmlSource} } : undefined;`,
              `let ${codeElementRegisteredName} = false;`,
              renderHelperSource(
                renderHelperName,
                registrationName,
                codeElementConfigName,
                codeBlocksName,
                codeElementRegisteredName,
                codeSizesName,
                sizingName,
                serverHtmlName,
              ),
              "",
            ].join("\n"),
          );
        }
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

function lowerMacroCall(magic, call, descriptor, renderHelperName, codeRef) {
  const { start, end } = call;
  if (call.kind !== "react") {
    const literal = safeJsLiteral(descriptor);
    magic.overwrite(start, end, call.wrap ? `(${literal})` : literal);
    return;
  }

  const presentation = call.presentation.map((item) => ({
    ...item,
    isLiteral: item.literal !== undefined,
  }));
  if (presentation.length === 0) {
    magic.overwrite(start, end, `<${renderHelperName} codeRef=${JSON.stringify(codeRef)} />`);
    return;
  }

  const first = presentation[0];
  const attributeStart = (item) => `${item.name}${item.isLiteral ? "=" : "={"}`;
  magic.overwrite(
    start,
    first.start,
    `<${renderHelperName} codeRef=${JSON.stringify(codeRef)} ${attributeStart(first)}`,
  );

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
  const suffix = `${last.isLiteral ? "" : "}"} />`;
  magic.overwrite(last.end, end, suffix);
}

function uniqueIdentifierName(used, base) {
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) candidate = `${base}${suffix++}`;
  return candidate;
}

// Deduplicate complete generated rules, keeping nested at-rules and quoted
// declaration values intact. Splitting on lines would break media blocks.
function cssRules(css) {
  const rules = [];
  let start = 0;
  let braces = 0;
  let parentheses = 0;
  let quote;
  let comment = false;
  for (let index = 0; index < css.length; index++) {
    const character = css[index];
    if (comment) {
      if (character === "*" && css[index + 1] === "/") {
        comment = false;
        index++;
      }
      continue;
    }
    if (character === "\\") {
      index++;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "/" && css[index + 1] === "*") {
      comment = true;
      index++;
    } else if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (parentheses === 0) {
      if (character === "{") braces++;
      else if (character === "}") braces--;
      if (braces === 0 && (character === "}" || character === ";")) {
        rules.push(css.slice(start, index + 1).trim());
        start = index + 1;
      }
    }
  }
  const trailing = css.slice(start).trim();
  if (trailing) rules.push(trailing);
  return rules;
}

function renderHelperSource(
  name,
  registrationName,
  codeElementConfigName,
  codeBlocksName,
  codeElementRegisteredName,
  codeSizesName,
  sizingName,
  serverHtmlName,
) {
  return `function ${name}(props) {
  const { codeRef, render, theme, maxLines, ...presentationProps } = props;
  if (render === undefined) {
    if (!import.meta.env.SSR && !${codeElementRegisteredName}) {
      ${registrationName}(${codeElementConfigName});
      ${codeElementRegisteredName} = true;
    }
    const sizing = ${codeSizesName}[codeRef];
    if (import.meta.env.SSR) {
      return <ferriki-code {...presentationProps} data-ferriki-theme={theme} code-ref={codeRef} max-lines={maxLines} style={maxLines === undefined ? sizing.style : ${sizingName}(sizing.lineCount, maxLines)} dangerouslySetInnerHTML={${serverHtmlName}[codeRef]} />;
    }
    return <ferriki-code {...presentationProps} data-ferriki-theme={theme} code-ref={codeRef} max-lines={maxLines} style={maxLines === undefined ? sizing.style : ${sizingName}(sizing.lineCount, maxLines)} />;
  }
  return render({ code: ${codeBlocksName}[codeRef], ...presentationProps, ...(theme === undefined ? {} : { theme }), ...(maxLines === undefined ? {} : { maxLines }) });
}`;
}
