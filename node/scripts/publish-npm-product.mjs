import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { FERRIKI_PLATFORM_TARGETS } from "../ferriki/platforms.mjs";
import { registryVersionUrl } from "./verify-npm-publish.mjs";

const REPOSITORY = "https://github.com/sebastian-software/ferriki";
const WORKFLOW = ".github/workflows/publish.yml";
const PROVENANCE_TYPE = "https://slsa.dev/provenance/v1";
const REGISTRY = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 10_000;
const RECOVERY_LOOKUP_ATTEMPTS = 3;
const RECOVERY_LOOKUP_DELAY_MS = 5_000;
const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export function attestationUrl(name, version) {
  return `${REGISTRY}/-/npm/v1/attestations/${name.toLowerCase().replace("/", "%2f")}@${encodeURIComponent(version)}`;
}

export function distTagsUrl(name) {
  return `${REGISTRY}/-/package/${name.toLowerCase().replace("/", "%2f")}/dist-tags`;
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function registryDigest(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? "");
  if (!match) throw new Error("registry metadata has no SHA-512 tarball integrity");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== match[1])
    throw new Error("registry metadata has invalid SHA-512 tarball integrity");
  return bytes.toString("hex");
}

export function verifyExistingPackage({
  name,
  version,
  sourceSha,
  releaseTag,
  metadata,
  attestations,
}) {
  assert.equal(metadata?.name, name, `registry returned the wrong package for ${name}@${version}`);
  assert.equal(
    metadata?.version,
    version,
    `registry returned the wrong version for ${name}@${version}`,
  );
  const digest = registryDigest(metadata.dist?.integrity);
  assert.equal(
    metadata.dist?.attestations?.url,
    attestationUrl(name, version),
    `${name}@${version} has an unexpected provenance endpoint`,
  );
  assert.equal(
    metadata.dist?.attestations?.provenance?.predicateType,
    PROVENANCE_TYPE,
    `${name}@${version} has no expected npm provenance`,
  );
  const expectedSubject = `pkg:npm/${encodeURIComponent(name).replace("%2F", "/")}@${version}`;
  const permittedRefs = new Set(["refs/heads/main", `refs/tags/${releaseTag}`]);
  const evidence =
    attestations?.attestations?.filter((item) => item.predicateType === PROVENANCE_TYPE) ?? [];
  const valid = evidence.some((item) => {
    try {
      const bundle = item.bundle;
      const envelope = bundle?.dsseEnvelope;
      if (envelope?.payloadType !== "application/vnd.in-toto+json") return false;
      const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
      if (statement.predicateType !== PROVENANCE_TYPE) return false;
      if (
        !statement.subject?.some(
          (subject) => subject.name === expectedSubject && subject.digest?.sha512 === digest,
        )
      )
        return false;
      const build = statement.predicate?.buildDefinition;
      const workflow = build?.externalParameters?.workflow;
      if (workflow?.repository !== REPOSITORY || workflow.path !== WORKFLOW) return false;
      if (!permittedRefs.has(workflow.ref)) return false;
      if (
        !build.resolvedDependencies?.some(
          (dependency) =>
            dependency.uri === `git+${REPOSITORY}@${workflow.ref}` &&
            dependency.digest?.gitCommit === sourceSha,
        )
      )
        return false;
      const cert = new X509Certificate(
        Buffer.from(bundle.verificationMaterial?.certificate?.rawBytes ?? "", "base64"),
      );
      return cert.subjectAltName === `URI:${REPOSITORY}/${WORKFLOW}@${workflow.ref}`;
    } catch {
      return false;
    }
  });
  assert(
    valid,
    `${name}@${version} provenance does not match the release commit, workflow, and tarball`,
  );
}

export async function lookupPackage({
  name,
  version,
  sourceSha,
  releaseTag,
  recovery,
  fetchImpl = fetch,
  sleepImpl = sleep,
}) {
  const attempts = recovery ? RECOVERY_LOOKUP_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const metadata = await fetchJson(registryVersionUrl(name, version), fetchImpl);
    if (metadata) {
      const attestations = await fetchJson(attestationUrl(name, version), fetchImpl);
      if (!attestations)
        throw new Error(`${name}@${version} exists but its provenance is not available`);
      verifyExistingPackage({ name, version, sourceSha, releaseTag, metadata, attestations });
      return "existing";
    }
    if (attempt < attempts) await sleepImpl(RECOVERY_LOOKUP_DELAY_MS);
  }
  return "missing";
}

export async function lookupDistTag({ name, tag, fetchImpl = fetch }) {
  const tags = await fetchJson(distTagsUrl(name), fetchImpl);
  if (!tags || typeof tags !== "object")
    throw new Error(`cannot read public npm dist-tags for ${name}`);
  const version = tags[tag];
  if (version !== undefined && typeof version !== "string")
    throw new Error(`npm returned invalid ${tag} dist-tag for ${name}`);
  return version;
}

export async function publishPhase({
  packages,
  phase,
  sourceSha,
  releaseTag,
  tag,
  recovery = false,
  fetchImpl = fetch,
  sleepImpl = sleep,
  publishImpl,
  promoteImpl,
}) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? ""))
    throw new Error("release source is not a commit SHA");
  if (releaseTag !== `v${packages[0]?.version}`)
    throw new Error("release tag does not match the package version");
  if (!["latest", "next"].includes(tag)) throw new Error("unexpected npm dist-tag");
  for (const pkg of packages) {
    if (pkg.version !== packages[0].version)
      throw new Error(`${pkg.name} has a mismatched release version`);
    const state = await lookupPackage({
      ...pkg,
      sourceSha,
      releaseTag,
      recovery,
      fetchImpl,
      sleepImpl,
    });
    if (state === "existing") {
      const taggedVersion = await lookupDistTag({ name: pkg.name, tag, fetchImpl });
      if (taggedVersion === pkg.version) {
        console.log(`Verified existing ${pkg.name}@${pkg.version} and ${tag} dist-tag; skipping`);
      } else {
        console.log(`Verified existing ${pkg.name}@${pkg.version}; promoting ${tag}`);
        await promoteImpl(pkg, tag);
      }
      continue;
    }
    console.log(`Publishing missing ${pkg.name}@${pkg.version}`);
    // A publish error is always fatal. An accepted write that is not yet
    // visible can be recovered by a later run after registry propagation.
    await publishImpl(pkg, tag, phase);
  }
}

export async function readReleasePackages(root = fileURLToPath(new URL("..", import.meta.url))) {
  const core = JSON.parse(await readFile(join(root, "ferriki", "package.json"), "utf8"));
  const vite = JSON.parse(await readFile(join(root, "vite", "package.json"), "utf8"));
  assert.equal(core.name, "@ferriki/core");
  assert.equal(vite.name, "@ferriki/vite");
  assert.equal(vite.version, core.version);
  assert.equal(vite.dependencies?.[core.name], core.version);
  const sidecars = [];
  for (const target of FERRIKI_PLATFORM_TARGETS) {
    const path = join(root, "platforms", target.id);
    const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    assert.equal(manifest.name, target.packageName);
    assert.equal(manifest.version, core.version);
    assert.equal(core.optionalDependencies?.[manifest.name], core.version);
    sidecars.push({ name: manifest.name, version: core.version, path });
  }
  return {
    sidecars,
    core: [{ name: core.name, version: core.version, path: join(root, "ferriki") }],
    vite: [{ name: vite.name, version: core.version, path: join(root, "vite") }],
  };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
}

function readPackedManifest(filename) {
  const result = spawnSync("tar", ["-xOf", filename, "package/package.json"], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cannot inspect packed manifest: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

export async function publishWithNpm(
  pkg,
  tag,
  _phase,
  { runImpl = run, spawnImpl = spawnSync, inspectPackImpl = readPackedManifest } = {},
) {
  const temp = await mkdtemp(join(tmpdir(), "ferriki-npm-pack-"));
  try {
    const result = spawnImpl(
      "pnpm",
      ["--dir", pkg.path, "pack", "--pack-destination", temp, "--json"],
      { cwd: pkg.path, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`pnpm pack failed for ${pkg.name}: ${result.stderr}`);
    const pack = JSON.parse(result.stdout);
    if (pack.name !== pkg.name || pack.version !== pkg.version)
      throw new Error(`pnpm packed the wrong package for ${pkg.name}@${pkg.version}`);
    const filename = pack.filename;
    if (typeof filename !== "string" || !resolve(filename).startsWith(`${temp}/`))
      throw new Error("pnpm did not return a tarball in the temporary directory");
    const packedManifest = inspectPackImpl(filename);
    if (packedManifest.name !== pkg.name || packedManifest.version !== pkg.version)
      throw new Error(`packed tarball identity differs from ${pkg.name}@${pkg.version}`);
    if (/\b(?:catalog|workspace):/.test(JSON.stringify(packedManifest)))
      throw new Error(
        `packed ${pkg.name}@${pkg.version} still has workspace dependency specifiers`,
      );
    runImpl(
      "npm",
      ["publish", filename, "--access", "public", "--provenance", "--tag", tag],
      pkg.path,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const phase = process.argv[2];
    if (!["sidecars", "core", "vite"].includes(phase))
      throw new Error("expected sidecars, core, or vite phase");
    const all = await readReleasePackages();
    const sourceSha = process.env.FERRIKI_RELEASE_SHA;
    if (sourceSha !== process.env.GITHUB_SHA)
      throw new Error("workflow run SHA differs from the immutable release source");
    if (all.core[0].version !== process.env.FERRIKI_RELEASE_VERSION)
      throw new Error("checked-out package version differs from the verified release version");
    await publishPhase({
      packages: all[phase],
      phase,
      sourceSha,
      releaseTag: process.env.FERRIKI_RELEASE_TAG,
      tag: process.env.NPM_DIST_TAG,
      recovery: process.env.FERRIKI_RECOVERY === "true",
      publishImpl: publishWithNpm,
      promoteImpl: async (pkg, distTag) =>
        run("npm", ["dist-tag", "add", `${pkg.name}@${pkg.version}`, distTag], pkg.path),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
