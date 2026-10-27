import process from "node:process";
import { runNativeCommand } from "ferramenta-native/cli";
import config from "../native-npm.config.mjs";
await runNativeCommand(config, ["platform", process.env.FERRIKI_PLATFORM_ID]);
