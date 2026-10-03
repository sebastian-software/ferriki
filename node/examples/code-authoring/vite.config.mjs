import { fileURLToPath } from "node:url";
import {
  transformerNotationDiff,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { ferriki } from "../../vite/index.mjs";

export default {
  plugins: [
    ferriki({
      themes: { light: "github-light-default", dark: "github-dark-default" },
      styleMode: "classes",
      lineNumbers: true,
      assets: {
        remote: false,
        cacheDir: fileURLToPath(new URL("../../.cache/ferriki-assets/", import.meta.url)),
      },
      transformers: [
        transformerNotationDiff(),
        transformerNotationFocus(),
        transformerNotationHighlight(),
        transformerNotationWordHighlight(),
      ],
    }),
  ],
};
