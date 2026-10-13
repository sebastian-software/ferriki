import { digest } from "./asset-store.mjs";

// One-time migration cleanup. Only exact objects from the accepted snapshot
// qualify; any unexpected staging file or different bytes aborts before DELETE.
export async function cleanupBootstrap({ hostname, zone, accessKey, objects, fetchImpl = fetch }) {
  if (
    !/^(?:[a-z0-9-]+\.)?storage\.bunnycdn\.com$/.test(hostname || "") ||
    !/^[a-z0-9-]+$/.test(zone || "") ||
    !accessKey
  )
    throw new Error("Missing Bunny Storage configuration");
  const base = `https://${hostname}/${zone}/`;
  const request = (key, method = "GET") =>
    fetchImpl(`${base}${key}`, {
      method,
      headers: { AccessKey: accessKey },
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
  const old = new Map();
  for (const [key, bytes] of objects) {
    if (!/^(?:themes\/)?[a-z0-9-]+\/[a-zA-Z0-9]{8}$/.test(key))
      throw new Error("Cleanup requires short object names");
    old.set(`${key.slice(0, key.lastIndexOf("/") + 1)}${digest(bytes)}`, bytes);
  }
  const staging = "ferriki-bunny-assets/";
  const staged = new Set([...old.keys()].map((key) => staging + key));
  const folders = new Set([staging]);
  for (const key of staged) {
    const segments = key.split("/");
    for (let i = 1; i < segments.length; i++) folders.add(segments.slice(0, i).join("/") + "/");
  }
  async function inspectStaging(folder) {
    const response = await request(folder);
    if (response.status === 404) {
      await response.body?.cancel();
      return false;
    }
    if (!response.ok) throw new Error(`Staging lookup failed: HTTP ${response.status}`);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error("Invalid staging directory listing");
    for (const entry of entries) {
      if (!/^[a-zA-Z0-9-]+$/.test(entry.ObjectName)) throw new Error("Unexpected staging name");
      const key = folder + entry.ObjectName + (entry.IsDirectory ? "/" : "");
      if (entry.IsDirectory) {
        if (!folders.has(key)) throw new Error(`Unexpected staging directory: ${key}`);
        await inspectStaging(key);
      } else if (!staged.has(key)) throw new Error(`Unexpected staging object: ${key}`);
    }
    return true;
  }
  async function rootHasStaging() {
    const response = await request("");
    if (!response.ok) throw new Error(`Storage root lookup failed: HTTP ${response.status}`);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error("Invalid storage root listing");
    const entry = entries.find((item) => item.ObjectName === staging.slice(0, -1));
    if (entry && !entry.IsDirectory) throw new Error("Unexpected staging root object");
    return Boolean(entry);
  }
  const hasStaging = await rootHasStaging();
  if (hasStaging) await inspectStaging(staging);
  const candidates = [...old].flatMap(([key, bytes]) => [
    [key, bytes],
    [staging + key, bytes],
  ]);
  const present = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (cursor < candidates.length) {
        const [key, expected] = candidates[cursor++];
        const response = await request(key);
        if (response.status === 404) {
          await response.body?.cancel();
          continue;
        }
        if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(expected))
          throw new Error(`Cleanup integrity mismatch: ${key}`);
        present.push(key);
      }
    }),
  );
  // Staging is deleted as one verified directory; root objects are individual.
  const deletions = present.filter((key) => !key.startsWith(staging));
  if (hasStaging) deletions.push(staging);
  cursor = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (cursor < deletions.length) {
        const key = deletions[cursor++];
        const response = await request(key, "DELETE");
        await response.body?.cancel();
        if (!response.ok && response.status !== 404) throw new Error(`Cleanup failed: ${key}`);
        if (key === staging) {
          // Directory GET returns 200 with [] even when the directory is gone.
          if (await rootHasStaging()) throw new Error(`Cleanup deletion not confirmed: ${key}`);
        } else {
          const after = await request(key);
          await after.body?.cancel();
          if (after.status !== 404) throw new Error(`Cleanup deletion not confirmed: ${key}`);
        }
      }
    }),
  );
  return { removedObjects: present.length, removedStaging: hasStaging };
}
