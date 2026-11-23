const PUBLIC = "https://assets.ferriki.dev";
const ISSUER = "https://downloads.ferriki.dev/v1/downloads";
const PROTECTED = "https://protected-assets.ferriki.dev";
const PATH = /^\/(?:themes\/)?[a-z0-9-]+\/[A-Za-z0-9]{8}$/;

/** A protected request is selected explicitly, independent of token availability. */
export function protectedSelected(env = process.env) {
  const value = env.FERRIKI_ASSETS_PROTECTED?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error("Invalid FERRIKI_ASSETS_PROTECTED setting.");
}

export async function protectedUrl(asset, signal, env = process.env, request = fetch) {
  const token = env.FERRIKI_DOWNLOAD_TOKEN;
  if (!token || /[\r\n]/.test(token))
    throw new Error("Protected asset downloads require FERRIKI_DOWNLOAD_TOKEN.");
  let source;
  try {
    source = new URL(asset.url);
  } catch {
    throw new Error("Protected assets require the default CDN.");
  }
  if (
    source.origin !== PUBLIC ||
    source.username ||
    source.password ||
    source.search ||
    source.hash ||
    !PATH.test(source.pathname)
  )
    throw new Error("Protected assets require the default CDN and a canonical asset path.");
  let response;
  try {
    response = await request(ISSUER, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: source.pathname, sha256: asset.digest }),
      redirect: "error",
      signal,
    });
  } catch {
    throw new Error("Protected asset authorization failed.");
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Protected asset authorization failed.");
  }
  let body = "";
  try {
    let size = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 8192) throw new Error("too large");
      body += decoder.decode(chunk, { stream: true });
    }
    body += decoder.decode();
    const issued = JSON.parse(body);
    if (
      issued.bytes !== asset.size ||
      issued.sha256 !== asset.digest ||
      typeof issued.url !== "string"
    )
      throw new Error("invalid");
    const url = new URL(issued.url);
    if (
      url.origin !== PROTECTED ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== source.pathname ||
      [...url.searchParams.keys()].sort().join(",") !== "expires,token" ||
      !/^[A-Za-z0-9_-]+$/.test(url.searchParams.get("token") || "") ||
      !/^\d+$/.test(url.searchParams.get("expires") || "")
    )
      throw new Error("invalid");
    return url.href;
  } catch {
    throw new Error("Protected asset authorization returned an invalid response.");
  }
}
