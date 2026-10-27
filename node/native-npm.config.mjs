import path from "node:path";
const root = import.meta.dirname;
export default {
  name: "ferriki",
  packageDir: path.join(root, "ferriki"),
  platformDir: path.join(root, "platforms"),
  packagePattern: "@ferriki/{target}",
  binaryPattern: "ferriki.node",
  runtimeFile: "native-runtime.mjs",
  repositoryPlatformDir: "node/platforms",
  licenses: ["LICENSE-APACHE", "LICENSE-MIT"],
  workspaceProtocol: false,
};
