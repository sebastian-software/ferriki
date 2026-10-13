import { digest } from "./asset-store.mjs";

// GET before PUT makes reruns idempotent. Existing bytes must match; even a
// corrupt object is never silently overwritten. Writers of the same hash
// necessarily publish the same bytes, including concurrent workflow runs.
export async function uploadImmutable({ hostname, zone, accessKey, objects, fetchImpl = fetch }) {
  if (
    !/^(?:[a-z0-9-]+\.)?storage\.bunnycdn\.com$/.test(hostname || "") ||
    !/^[a-z0-9-]+$/.test(zone || "") ||
    !accessKey
  )
    throw new Error("Set BUNNY_STORAGE_HOSTNAME, BUNNY_STORAGE_ZONE, and BUNNY_STORAGE_ACCESS_KEY");
  const headers = { AccessKey: accessKey };
  let uploaded = 0;
  let skipped = 0;
  for (const [objectPath, bytes] of objects) {
    if (
      !/^(?:themes\/)?[a-z0-9-]+\/[a-f0-9]{64}$/.test(objectPath) ||
      digest(bytes) !== objectPath.split("/").at(-1)
    )
      throw new Error(`Invalid immutable object: ${objectPath}`);
    const url = `https://${hostname}/${zone}/${objectPath}`;
    const get = () =>
      fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(60000) });
    const existing = await get();
    if (existing.status === 200) {
      const prior = Buffer.from(await existing.arrayBuffer());
      if (!prior.equals(bytes)) throw new Error(`Existing immutable object differs: ${objectPath}`);
      skipped++;
      continue;
    }
    await existing.body?.cancel();
    if (existing.status !== 404) throw new Error(`Storage lookup failed: HTTP ${existing.status}`);
    const response = await fetchImpl(url, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/octet-stream" },
      body: bytes,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Storage upload failed: HTTP ${response.status}`);
    const verified = await get();
    if (!verified.ok || !Buffer.from(await verified.arrayBuffer()).equals(bytes))
      throw new Error(`Storage read-back verification failed: ${objectPath}`);
    uploaded++;
  }
  return { uploaded, skipped };
}
