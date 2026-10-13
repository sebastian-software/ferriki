export function objectPath(kind, id, hash) {
  if (!/^[a-z0-9-]+$/.test(id) || !/^[a-f0-9]{64}$/.test(hash))
    throw new Error("Invalid content-addressed asset identity");
  if (kind === "language") return `${id}/${hash}`;
  if (kind === "theme") return `themes/${id}/${hash}`;
  throw new Error(`Unknown asset kind: ${kind}`);
}

export function payloadPath(key, asset) {
  const match = /^(languages|themes)\/([a-z0-9-]+)\.(fkgram|fktheme)$/.exec(key);
  if (!match || (match[1] === "languages") !== (match[3] === "fkgram"))
    throw new Error(`Invalid catalog payload path: ${key}`);
  return objectPath(match[1] === "languages" ? "language" : "theme", match[2], asset.sha256);
}
