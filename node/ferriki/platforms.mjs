import process from "node:process";
import { detectLinuxLibc, NATIVE_TARGETS, nativeTarget } from "./native-runtime.mjs";
export { detectLinuxLibc };
export const FERRIKI_NODE_MIN_VERSION = "22.13.0";
export const FERRIKI_PLATFORM_TARGETS = Object.freeze(
  NATIVE_TARGETS.map((target) =>
    Object.freeze({
      id: target.id,
      platform: target.os,
      arch: target.cpu,
      ...(target.os === "linux"
        ? { libc: target.libc === "glibc" ? "gnu" : "musl" }
        : target.os === "win32"
          ? { libc: "msvc" }
          : {}),
      packageName: `@ferriki/${target.id}`,
      binaryName: `ferriki.${target.id}.node`,
    }),
  ),
);
export function resolveFerrikiPlatformTarget({
  platform = process.platform,
  arch = process.arch,
  libc = detectLinuxLibc(platform),
} = {}) {
  try {
    return FERRIKI_PLATFORM_TARGETS.find(
      (target) => target.id === nativeTarget(platform, arch, libc),
    );
  } catch {
    return undefined;
  }
}
export function formatFerrikiPlatformMatrix() {
  return FERRIKI_PLATFORM_TARGETS.map(
    (target) => `${target.id} (Node >= ${FERRIKI_NODE_MIN_VERSION})`,
  ).join(", ");
}
