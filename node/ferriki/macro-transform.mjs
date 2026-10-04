import { loadFerrikiNativeBinding } from "./native.mjs";

let nativeBinding;

/**
 * Find static `code` calls, React `Code` elements and their imports.
 * The native scanner owns JavaScript/TypeScript binding and shadow analysis;
 * this Node-only entry deliberately stays outside the browser macro entry.
 *
 * @param {string} source
 * @param {string} [filename]
 * @returns {import("./macro-transform.d.mts").InlineCodeMacroPlan} Macro calls and import edits.
 */
export function findInlineCodeMacros(source, filename = "<source>") {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  if (typeof filename !== "string") throw new TypeError("filename must be a string");

  // Avoid loading the platform addon for ordinary modules. Normalize source
  // escapes only to recognize a cooked macro-module candidate; the native
  // scanner remains responsible for parsing and validating JavaScript.
  if (!hasMacroModuleCandidate(source)) return { calls: [], imports: [] };

  nativeBinding ??= loadFerrikiNativeBinding();
  const scanner = nativeBinding.scanInlineCodeMacros;
  if (typeof scanner !== "function") {
    throw new TypeError(
      "The installed Ferriki native binding does not include inline macro scanning. Rebuild or reinstall the Ferriki native package before using @ferriki/vite.",
    );
  }

  const json = nativeBinding.scanInlineCodeMacros(source, filename);
  let plan;
  try {
    plan = JSON.parse(json);
  } catch (cause) {
    throw new Error("Ferriki's native inline macro scanner returned invalid JSON", { cause });
  }
  if (!plan || !Array.isArray(plan.calls) || !Array.isArray(plan.imports)) {
    throw new Error("Ferriki's native inline macro scanner returned an invalid edit plan");
  }
  for (const call of plan.calls) {
    if (
      !Number.isInteger(call?.start) ||
      !Number.isInteger(call?.end) ||
      call.start < 0 ||
      call.end < call.start ||
      typeof call.code !== "string" ||
      typeof call.language !== "string" ||
      (call.meta != null && typeof call.meta !== "string") ||
      (call.lineNumbers != null && typeof call.lineNumbers !== "boolean") ||
      (call.kind != null && call.kind !== "react") ||
      (call.component != null &&
        (call.kind !== "react" || typeof call.component !== "string" || !call.component))
    ) {
      throw new Error("Ferriki's native inline macro scanner returned an invalid call record");
    }
  }
  for (const item of plan.imports) {
    if (
      !Number.isInteger(item?.start) ||
      !Number.isInteger(item?.end) ||
      item.start < 0 ||
      item.end < item.start ||
      typeof item.replacement !== "string"
    ) {
      throw new Error("Ferriki's native inline macro scanner returned an invalid import record");
    }
  }
  return plan;
}

function hasMacroModuleCandidate(source) {
  const moduleNames = ["@ferriki/core/macro", "@ferriki/core/react/macro"];
  if (moduleNames.some((moduleName) => source.includes(moduleName))) return true;
  if (!source.includes("\\")) return false;
  const normalized = normalizeSourceEscapes(source);
  return moduleNames.some((moduleName) => normalized.includes(moduleName));
}

function normalizeSourceEscapes(source) {
  const escapes = {
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    0: "\0",
    "'": "'",
    '"': '"',
    "`": "`",
    "\\": "\\",
  };
  let normalized = "";
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character !== "\\" || index + 1 >= source.length) {
      normalized += character;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === "\r" || escaped === "\n" || escaped === "\u2028" || escaped === "\u2029") {
      index++;
      if (escaped === "\r" && source[index + 1] === "\n") index++;
      continue;
    }
    if (escaped === "u") {
      const codePointMatch = /^\\u\{([\da-f]+)\}/i.exec(source.slice(index));
      const codeUnitMatch = /^\\u([\da-f]{4})/i.exec(source.slice(index));
      const match = codePointMatch ?? codeUnitMatch;
      if (match) {
        const value = Number.parseInt(match[1], 16);
        if (value <= 0x10ffff) {
          normalized += String.fromCodePoint(value);
          index += match[0].length - 1;
          continue;
        }
      }
    }
    if (escaped === "x") {
      const match = /^\\x([\da-f]{2})/i.exec(source.slice(index));
      if (match) {
        normalized += String.fromCharCode(Number.parseInt(match[1], 16));
        index += match[0].length - 1;
        continue;
      }
    }

    normalized += Object.hasOwn(escapes, escaped) ? escapes[escaped] : escaped;
    index++;
  }
  return normalized;
}
