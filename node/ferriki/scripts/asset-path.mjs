// Eight Base62 digits from the first 64 SHA-256 bits. The complete digest
// remains the integrity check; publication rejects short-name collisions.
export function shortHash(hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid asset digest");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = BigInt(`0x${hash.slice(0, 16)}`) % 62n ** 8n;
  let result = "";
  for (let i = 0; i < 8; i++) {
    result = alphabet[Number(value % 62n)] + result;
    value /= 62n;
  }
  return result;
}

export function objectPath(kind, id, hash, layout = "language-hash-v2") {
  if (!/^[a-z0-9-]+$/.test(id) || !/^[a-f0-9]{64}$/.test(hash))
    throw new Error("Invalid content-addressed asset identity");
  if (!["language-hash-v1", "language-hash-v2"].includes(layout))
    throw new Error("Unknown asset storage layout");
  const name = layout === "language-hash-v1" ? hash : shortHash(hash);
  if (kind === "language") return `${id}/${name}`;
  if (kind === "theme") return `themes/${id}/${name}`;
  throw new Error(`Unknown asset kind: ${kind}`);
}

export function payloadPath(key, asset, layout = "language-hash-v2") {
  const match = /^(languages|themes)\/([a-z0-9-]+)\.(fkgram|fktheme)$/.exec(key);
  if (!match || (match[1] === "languages") !== (match[3] === "fkgram"))
    throw new Error(`Invalid catalog payload path: ${key}`);
  return objectPath(
    match[1] === "languages" ? "language" : "theme",
    match[2],
    asset.sha256,
    layout,
  );
}
