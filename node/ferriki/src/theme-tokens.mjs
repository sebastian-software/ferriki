export function alignThemeTokens(results) {
  const lineCount = Math.max(...results.map((result) => result.result.tokens.length));
  return Array.from({ length: lineCount }, (_, lineIndex) => {
    const lines = results.map((result) => result.result.tokens[lineIndex] || []);
    const boundaries = new Set();
    for (const line of lines) {
      for (const token of line) {
        boundaries.add(token.offset);
        boundaries.add(token.offset + token.content.length);
      }
    }
    const sorted = [...boundaries].sort((left, right) => left - right);
    const output = [];
    const cursors = lines.map(() => 0);
    for (let index = 0; index < sorted.length - 1; index++) {
      const start = sorted[index];
      const end = sorted[index + 1];
      if (start === end) continue;
      const variants = {};
      let baseToken;
      for (let themeIndex = 0; themeIndex < results.length; themeIndex++) {
        const result = results[themeIndex];
        const line = lines[themeIndex];
        while (
          cursors[themeIndex] < line.length &&
          line[cursors[themeIndex]].offset + line[cursors[themeIndex]].content.length <= start
        ) {
          cursors[themeIndex]++;
        }
        const candidate = line[cursors[themeIndex]];
        const token = candidate && candidate.offset <= start ? candidate : undefined;
        if (token && !baseToken) baseToken = token;
        variants[result.color] = tokenStyle(token);
      }
      if (!baseToken) continue;
      output.push({
        content: baseToken.content.slice(start - baseToken.offset, end - baseToken.offset),
        offset: start,
        ...(baseToken.type === undefined ? {} : { type: baseToken.type }),
        ...(baseToken.scopeNames ? { scopeNames: baseToken.scopeNames } : {}),
        variants,
      });
    }
    return output;
  });
}

export function tokenStyle(token) {
  if (!token) return {};
  const style = {};
  if (token.color) style.color = token.color;
  const fontStyle = token.fontStyle || 0;
  if (fontStyle & 1) style["font-style"] = "italic";
  if (fontStyle & 2) style["font-weight"] = "bold";
  const decorations = [];
  if (fontStyle & 4) decorations.push("underline");
  if (fontStyle & 8) decorations.push("line-through");
  if (decorations.length) style["text-decoration"] = decorations.join(" ");
  return style;
}
