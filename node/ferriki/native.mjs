import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { formatFerrikiPlatformMatrix, resolveFerrikiPlatformTarget } from "./platforms.mjs";

// Every candidate says how it must be resolved. The sidecar is a package
// specifier that Node resolves from node_modules, whatever its scope; the rest
// are files next to this loader. Deciding by the shape of the string (a leading
// `@`) is exactly what broke once the sidecars became unscoped.
function nativeCandidates(target, here) {
  return [
    { package: `${target.packageName}/ferriki.node` },
    { file: join(here, "dist", target.binaryName) },
    { file: join(here, "dist", "ferriki.node") },
    { file: join(here, "ferriki.node") },
  ];
}

export function loadFerrikiNativeBinding() {
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolveFerrikiPlatformTarget();
  const candidates = target ? nativeCandidates(target, here) : [];
  const errors = [];
  for (const candidate of candidates) {
    const label = candidate.package ?? candidate.file;
    try {
      const resolved = candidate.package ? require.resolve(candidate.package) : candidate.file;
      return require(resolved);
    } catch (error) {
      errors.push(`${label}: ${String(error)}`);
    }
  }
  if (!target) {
    throw new Error(
      [
        `[ferriki] Unsupported target ${process.platform}-${process.arch}${process.platform === "linux" ? " (musl or unknown libc)" : ""}.`,
        `Supported targets: ${formatFerrikiPlatformMatrix()}.`,
        "Ferriki currently supports GNU libc on Linux; musl/Alpine requires a separately tested target.",
      ].join("\n"),
    );
  }
  throw new Error(
    [
      `[ferriki] No native binary for ${target.id}.`,
      `Install the optional platform package ${target.packageName} or use a supported target.`,
      "Tried:",
      ...errors.map((e) => `- ${e}`),
    ].join("\n"),
  );
}

export function tryLoadFerrikiNativeBinding() {
  try {
    return loadFerrikiNativeBinding();
  } catch {
    return undefined;
  }
}
