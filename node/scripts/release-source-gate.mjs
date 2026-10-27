import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReleaseSourceGate } from "ferramenta-native/release-source";
import config from "../native-npm.config.mjs";
const gate = createReleaseSourceGate(config);
export const {
  releaseTarget,
  resolveTag,
  inspectCiRuns,
  inspectCiJobs,
  fetchCiRuns,
  checkManifestVersions,
} = gate;
if (process.argv[1] === fileURLToPath(import.meta.url)) await gate.run(process.argv[2]);
