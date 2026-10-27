import process from "node:process";
import { fileURLToPath } from "node:url";
import { createNativeRelease } from "ferramenta-native/release";
import config from "../native-npm.config.mjs";
export {
  ASSETS_BASE_URL,
  verifyCdnPayloads,
  verifyPublicAssetCache,
} from "./public-package-probes.mjs";
export {
  MAX_ATTEMPTS,
  registryVersionUrl,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAY_MS,
  runPublicNpmInstall,
  verifyNpmPublication,
} from "ferramenta-native/publication";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await createNativeRelease(config).verify();
}
