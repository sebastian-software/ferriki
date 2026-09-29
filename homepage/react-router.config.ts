import type { Config } from "@react-router/dev/config";

import { withArdoGitHubPages } from "ardo/vite";

const config = {
  ssr: false,
  prerender: true,
} satisfies Config;

// The site is served from the root of its own domain (ferriki.dev), not from
// the repository path GitHub Pages would otherwise detect.
export default withArdoGitHubPages(config, { basename: "/" });
