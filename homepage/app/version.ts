// The documented version is the published one. Release Please updates
// `node/ferriki/package.json` in the release pull request, and the site reads
// it here at build time, so a release changes the rendered pages without a
// homepage edit. `scripts/verify-build.mjs` fails the build when the
// prerendered landing page does not carry this version.
import packageJson from "../../node/ferriki/package.json";

export const version: string = packageJson.version;
