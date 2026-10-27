import process from "node:process";
import { fileURLToPath } from "node:url";
import { publishWithNpm as publishNativePackage } from "ferramenta-native";
import { createNativeRelease } from "ferramenta-native/release";
import config from "../native-npm.config.mjs";
const release = createNativeRelease(config);
export const {
  attestationUrl,
  distTagsUrl,
  verifyExistingPackage,
  lookupPackage,
  lookupDistTag,
  publishPhase,
  readReleasePackages,
} = release;
export const publishWithNpm = (pkg, tag, _phase, options) =>
  publishNativePackage(pkg, tag, options);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await release.publish({
    phase: process.argv[2],
    sourceSha: process.env.FERRIKI_RELEASE_SHA,
    releaseTag: process.env.FERRIKI_RELEASE_TAG,
    tag: process.env.NPM_DIST_TAG,
    recovery: process.env.FERRIKI_RECOVERY === "true",
  });
}
