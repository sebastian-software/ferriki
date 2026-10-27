import { createNativeLoader } from "./native-runtime.mjs";
const load = createNativeLoader(import.meta.url, {
  name: "ferriki",
  packagePattern: "@ferriki/{target}",
  binaryPattern: "ferriki.node",
  localPatterns: ["dist/ferriki.{target}.node", "dist/ferriki.node", "ferriki.node"],
});
export function loadFerrikiNativeBinding() {
  return load();
}
export function tryLoadFerrikiNativeBinding() {
  try {
    return load();
  } catch {
    return undefined;
  }
}
