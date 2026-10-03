import { fromHtml } from "hast-util-from-html";

const comparedStyleProperties = ["color", "font-style", "font-weight", "text-decoration"];

function classes(node) {
  const value = node.properties?.className;
  return Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/) : [];
}

function normalizeColor(value) {
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(color))
    return `#${[...color.slice(1)].map((part) => part + part).join("")}`;
  if (/^#[0-9a-f]{4}$/.test(color))
    return `#${[...color.slice(1)].map((part) => part + part).join("")}`;
  return color.replace(/\s*,\s*/g, ",");
}

function normalizeStyleValue(property, value) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (property === "color") return normalizeColor(normalized);
  if (property === "font-weight") {
    if (normalized === "normal") return "400";
    if (normalized === "bold") return "700";
  }
  return normalized;
}

function inlineStyles(node, inherited) {
  const result = { ...inherited };
  const style = node.properties?.style;
  if (typeof style !== "string") return result;

  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    if (comparedStyleProperties.includes(property)) {
      result[property] = normalizeStyleValue(property, declaration.slice(separator + 1));
    }
  }
  return result;
}

function styleSnapshot(style) {
  return {
    color: style.color ?? null,
    "font-style": style["font-style"] ?? "normal",
    "font-weight": style["font-weight"] ?? "400",
    "text-decoration": style["text-decoration"] ?? "none",
  };
}

function appendText(node, inherited, output) {
  if (node.type === "text") {
    for (const character of Array.from(node.value)) {
      output.text += character;
      output.styles.push(styleSnapshot(inherited));
    }
    return;
  }

  if (node.type !== "element") {
    for (const child of node.children ?? []) appendText(child, inherited, output);
    return;
  }

  if (classes(node).includes("line-number")) return;
  const style = inlineStyles(node, inherited);
  for (const child of node.children ?? []) appendText(child, style, output);
}

function textForNode(node, inherited) {
  const output = { text: "", styles: [] };
  appendText(node, inherited, output);
  return output;
}

function findElement(root, tagName, ancestors = []) {
  if (root.type === "element" && root.tagName === tagName) return { element: root, ancestors };
  for (const child of root.children ?? []) {
    const nextAncestors = root.type === "element" ? [...ancestors, root] : ancestors;
    const found = findElement(child, tagName, nextAncestors);
    if (found) return found;
  }
  return undefined;
}

function collectCode(html) {
  const tree = fromHtml(html, { fragment: true });
  const found = findElement(tree, "code");
  if (!found) throw new Error("Phiki output did not contain a code element.");
  const { element: code, ancestors } = found;

  const inherited = [...ancestors, code].reduce(
    (style, element) => inlineStyles(element, style),
    {},
  );
  // The `<code>` subtree contains the actual visible separators between
  // Shiki's `.line` wrappers and inside Phiki's wrappers. Flatten its real
  // text rather than reconstructing line breaks from wrappers: doing so
  // preserves extra/missing newlines and their inherited character styles.
  return textForNode(code, inherited);
}

function normalizeEol(text, styles) {
  const characters = Array.from(text);
  const normalized = { text: "", styles: [] };
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    if (character === "\r" && characters[index + 1] === "\n") {
      normalized.text += "\n";
      normalized.styles.push(styles[index + 1] ?? styles[index]);
      index++;
    } else if (character === "\r") {
      normalized.text += "\n";
      normalized.styles.push(styles[index]);
    } else {
      normalized.text += character;
      normalized.styles.push(styles[index]);
    }
  }
  return normalized;
}

function removeFinalNewlineSentinel(rendered, source) {
  if (rendered.text !== `${source}\n`) return false;
  const characters = Array.from(rendered.text);
  rendered.text = characters.slice(0, -1).join("");
  rendered.styles.pop();
  return true;
}

function firstTextDifference(expected, actual) {
  const expectedCharacters = Array.from(expected);
  const actualCharacters = Array.from(actual);
  const length = Math.max(expectedCharacters.length, actualCharacters.length);
  for (let index = 0; index < length; index++) {
    if (expectedCharacters[index] !== actualCharacters[index]) {
      return {
        kind: "text",
        characterIndex: index,
        expected: expectedCharacters[index] ?? null,
        actual: actualCharacters[index] ?? null,
      };
    }
  }
  return undefined;
}

/** Compare visible source text and computed inline character styles from two HTML renderers. */
export function compareHighlightedHtml(expectedHtml, actualHtml, source) {
  const expectedCode = collectCode(expectedHtml);
  const actualCode = collectCode(actualHtml);
  const expected = normalizeEol(expectedCode.text, expectedCode.styles);
  const actual = normalizeEol(actualCode.text, actualCode.styles);
  const normalizedSource = source.replace(/\r\n?/g, "\n");

  const expectedRemovedFinalNewlineSentinel = removeFinalNewlineSentinel(
    expected,
    normalizedSource,
  );
  const actualRemovedFinalNewlineSentinel = removeFinalNewlineSentinel(actual, normalizedSource);
  const removedFinalNewlineSentinel =
    expectedRemovedFinalNewlineSentinel || actualRemovedFinalNewlineSentinel;

  const expectedTextDifference = firstTextDifference(normalizedSource, expected.text);
  if (expectedTextDifference) {
    return {
      agrees: false,
      textAgrees: false,
      stylesAgree: false,
      removedFinalNewlineSentinel,
      difference: { ...expectedTextDifference, renderer: "reference" },
    };
  }

  const textDifference = firstTextDifference(normalizedSource, actual.text);
  if (textDifference) {
    return {
      agrees: false,
      textAgrees: false,
      stylesAgree: false,
      removedFinalNewlineSentinel,
      difference: textDifference,
    };
  }

  const expectedCharacters = Array.from(expected.text);
  for (let index = 0; index < expectedCharacters.length; index++) {
    const expectedStyle = expected.styles[index] ?? styleSnapshot({});
    const actualStyle = actual.styles[index] ?? styleSnapshot({});
    if (JSON.stringify(expectedStyle) !== JSON.stringify(actualStyle)) {
      return {
        agrees: false,
        textAgrees: true,
        stylesAgree: false,
        removedFinalNewlineSentinel,
        difference: {
          kind: "style",
          characterIndex: index,
          character: expectedCharacters[index],
          expected: expectedStyle,
          actual: actualStyle,
        },
      };
    }
  }

  return {
    agrees: true,
    textAgrees: true,
    stylesAgree: true,
    removedFinalNewlineSentinel,
  };
}

export const phikiStyleCriteria = comparedStyleProperties;
