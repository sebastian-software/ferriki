import process from "node:process";
// Repository checks read standard payloads from the cache that `build:native`
// seeds from assets/shiki, never from the network: the package ships no
// payloads (ADR 0013), and a checkout has no release commit to download from.
// Explicit FERRIKI_CACHE_DIR / FERRIKI_ASSETS_REMOTE values win, so a check can
// still be pointed at a real mirror.
import { fileURLToPath } from "node:url";

export const TEST_ASSET_CACHE_DIR = fileURLToPath(
  new URL("../.cache/ferriki-assets", import.meta.url),
);

process.env.FERRIKI_CACHE_DIR ??= TEST_ASSET_CACHE_DIR;
process.env.FERRIKI_ASSETS_REMOTE ??= "0";
