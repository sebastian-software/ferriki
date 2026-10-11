import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const expectedFerromarkBinaryDigest = process.argv[2];
assert.match(expectedFerromarkBinaryDigest, /^[a-f0-9]{64}$/);
const ardoEntry = import.meta.resolve("ardo/vite");
const requireFromArdo = createRequire(ardoEntry);
const coreEntry = requireFromArdo.resolve("@ferriki/core");
const ferromarkEntry = requireFromArdo.resolve("ferromark");
const coreRequire = createRequire(coreEntry);
const ferromarkRequire = createRequire(ferromarkEntry);
const corePackage = coreRequire.resolve("@ferriki/core/package.json");
const ferromarkPackage = ferromarkRequire.resolve("ferromark/package.json");
const coreBinary = coreRequire.resolve("@ferriki/darwin-arm64");
const ferromarkBinary = ferromarkRequire.resolve("ferromark-darwin-arm64");
const parse = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const core = parse(corePackage);
const ferromark = parse(ferromarkPackage);
const coreSidecar = parse(join(dirname(coreBinary), "package.json"));
const ferromarkSidecar = parse(join(dirname(ferromarkBinary), "package.json"));
const lockPath = join(process.cwd(), "pnpm-lock.yaml");
const lock = readFileSync(lockPath, "utf8");
assert.equal(core.name, "@ferriki/core");
assert.equal(core.version, "0.14.0");
assert.equal(coreSidecar.name, "@ferriki/darwin-arm64");
assert.equal(coreSidecar.version, "0.14.0");
assert.equal(ferromark.name, "ferromark");
assert.equal(ferromark.version, "3.1.0");
assert.equal(ferromarkSidecar.name, "ferromark-darwin-arm64");
assert.equal(ferromarkSidecar.version, "3.1.0");
assert.equal(hash(ferromarkBinary), expectedFerromarkBinaryDigest);
assert.match(lock, /'@ferriki\/core@0\.14\.0':/);
assert.doesNotMatch(lock, /'@ferriki\/core@0\.10\.0':/);
const coreModule = await import(coreEntry);
assert.equal(coreModule.ferrikiVersion(), "0.14.0");
console.log(
  JSON.stringify(
    {
      core: {
        version: core.version,
        packagePath: corePackage,
        binaryPath: coreBinary,
        binarySha256: hash(coreBinary),
      },
      ferromark: {
        version: ferromark.version,
        packagePath: ferromarkPackage,
        binaryPath: ferromarkBinary,
        binarySha256: hash(ferromarkBinary),
      },
      ardo: ardoEntry,
      lockSha256: hash(lockPath),
      fourFenceSourceSha256: hash(join(process.cwd(), "app/routes/evidence/compatibility.mdx")),
    },
    null,
    2,
  ),
);
