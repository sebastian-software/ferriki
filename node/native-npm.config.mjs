import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NATIVE_TARGETS } from "ferramenta-native/targets";
import verifyConsumer from "./scripts/packed-consumer-probe.mjs";
import { verifyPublicPackage } from "./scripts/public-package-probes.mjs";
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
  minimumBinarySize: 100_000,
  pack: {
    required: [
      "index.mjs",
      "index.d.mts",
      "native.mjs",
      "grammar.mjs",
      "assets/standard/catalog.mjs",
      "assets/standard/GRAMMAR-NOTICES.md",
    ],
    forbidden: [/^dist\/chunks\//, /\.wasm$/, /shiki-rust/, /createJavaScriptRegexEngine/],
    maxUnpackedSize: 20_000_000,
  },
  consumer: {
    smoke:
      'import { createHighlighterCoreSync, ferrikiVersion } from "@ferriki/core"; createHighlighterCoreSync().dispose(); if (!ferrikiVersion()) throw new Error("Native binding did not load");',
    verify: verifyConsumer,
  },
  release: {
    repository: "https://github.com/sebastian-software/ferriki",
    tagPrefix: "v",
    manifestKey: ".",
    ci: {
      requiredJobs: [
        "workflow-pins",
        "Decision records",
        "rust",
        "rust-semver",
        "msrv",
        "rust-docs",
        "cargo-deny",
        "coverage",
        "lint",
        "typecheck",
        "textmate-compat",
        "core-compat",
        "Test on macos-latest",
        "Test on windows-latest",
      ],
      platformJobs: NATIVE_TARGETS.map(({ id }) => ({
        pattern: `^native-smoke \\(.*${id}`,
        label: `native-smoke ${id}`,
      })),
    },
    async verifyMetadata(root) {
      const release = JSON.parse(
        await readFile(path.join(root, "assets/catalog.json"), "utf8"),
      ).release;
      assert.equal(release.manifestVersion, 1, "release asset manifest version is unsupported");
      assert.ok(Object.keys(release.assets ?? {}).length, "release asset manifest is empty");
    },
    verifyPublic: verifyPublicPackage,
    cargoFiles: [
      "Cargo.toml",
      "crates/ferriki-textmate/Cargo.toml",
      "crates/ferriki-asset-gen/Cargo.toml",
    ],
    extraPackages: [{ name: "@ferriki/vite", phase: "vite", path: path.join(root, "vite") }],
  },
};
