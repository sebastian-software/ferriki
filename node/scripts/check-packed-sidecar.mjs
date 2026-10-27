import { verifyPackedConsumer } from "ferramenta-native";
import config from "../native-npm.config.mjs";
import "./test-asset-env.mjs";
await verifyPackedConsumer(
  config,
  `
  import { createHighlighterCoreSync, ferrikiVersion } from "@ferriki/core";
  createHighlighterCoreSync().dispose();
  if (!ferrikiVersion()) throw new Error("Native version missing");
`,
);
