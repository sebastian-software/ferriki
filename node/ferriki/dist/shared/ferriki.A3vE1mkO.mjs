import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const candidates = [
  "shiki-rust.node",
  "index.node",
  join("native", "shiki-rust.node"),
  join("native", "index.node")
];
function loadFerrikiNativeBinding() {
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  const errors = [];
  for (const candidate of candidates) {
    const absPath = join(here, "..", candidate);
    try {
      return require(absPath);
    } catch (error) {
      errors.push(`${absPath}: ${String(error)}`);
    }
  }
  throw new Error([
    "[shiki-rust] Failed to load native Ferriki binding.",
    "This package is currently Node.js-only and requires a built .node addon.",
    "Tried:",
    ...errors.map((e) => `- ${e}`)
  ].join("\n"));
}
function tryLoadFerrikiNativeBinding() {
  try {
    return loadFerrikiNativeBinding();
  } catch {
    return void 0;
  }
}

export { loadFerrikiNativeBinding as l, tryLoadFerrikiNativeBinding as t };
