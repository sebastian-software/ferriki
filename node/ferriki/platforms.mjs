import process from "node:process";

/**
 * The release workflow publishes these seven targets as optional sidecar
 * packages. The map is deliberately shared by the loader, docs, and CI so a new
 * target cannot be documented accidentally. musl binaries carry their libc in
 * the file name so a musl host can never pick up the glibc fallback addon that
 * ships in the main package.
 */
export const FERRIKI_NODE_MIN_VERSION = "22.13.0";

export const FERRIKI_PLATFORM_TARGETS = Object.freeze([
  Object.freeze({
    id: "linux-x64-gnu",
    platform: "linux",
    arch: "x64",
    libc: "gnu",
    packageName: "@ferriki/linux-x64-gnu",
    binaryName: "ferriki.linux-x64.node",
  }),
  Object.freeze({
    id: "linux-arm64-gnu",
    platform: "linux",
    arch: "arm64",
    libc: "gnu",
    packageName: "@ferriki/linux-arm64-gnu",
    binaryName: "ferriki.linux-arm64.node",
  }),
  Object.freeze({
    id: "linux-x64-musl",
    platform: "linux",
    arch: "x64",
    libc: "musl",
    packageName: "@ferriki/linux-x64-musl",
    binaryName: "ferriki.linux-x64-musl.node",
  }),
  Object.freeze({
    id: "linux-arm64-musl",
    platform: "linux",
    arch: "arm64",
    libc: "musl",
    packageName: "@ferriki/linux-arm64-musl",
    binaryName: "ferriki.linux-arm64-musl.node",
  }),
  Object.freeze({
    id: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    packageName: "@ferriki/darwin-arm64",
    binaryName: "ferriki.darwin-arm64.node",
  }),
  Object.freeze({
    id: "win32-x64-msvc",
    platform: "win32",
    arch: "x64",
    libc: "msvc",
    packageName: "@ferriki/win32-x64-msvc",
    binaryName: "ferriki.win32-x64.node",
  }),
  Object.freeze({
    id: "win32-arm64-msvc",
    platform: "win32",
    arch: "arm64",
    libc: "msvc",
    packageName: "@ferriki/win32-arm64-msvc",
    binaryName: "ferriki.win32-arm64.node",
  }),
]);

export function detectLinuxLibc(platform = process.platform) {
  if (platform !== "linux") return undefined;
  try {
    return process.report?.getReport?.().header?.glibcVersionRuntime ? "gnu" : "musl";
  } catch {
    return "unknown";
  }
}

export function resolveFerrikiPlatformTarget({
  platform = process.platform,
  arch = process.arch,
  libc = platform === "win32" ? "msvc" : detectLinuxLibc(platform),
} = {}) {
  return FERRIKI_PLATFORM_TARGETS.find(
    (target) =>
      target.platform === platform &&
      target.arch === arch &&
      (target.libc === undefined || target.libc === libc),
  );
}

export function formatFerrikiPlatformMatrix() {
  return FERRIKI_PLATFORM_TARGETS.map(
    (target) => `${target.id} (Node >= ${FERRIKI_NODE_MIN_VERSION})`,
  ).join(", ");
}
