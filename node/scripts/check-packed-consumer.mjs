import { verifyPackedConsumer } from "ferramenta-native";
import config from "../native-npm.config.mjs";
import "./test-asset-env.mjs";
await verifyPackedConsumer(config);
