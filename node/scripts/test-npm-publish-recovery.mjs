import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

import {
  attestationUrl,
  distTagsUrl,
  lookupPackage,
  publishPhase,
  publishWithNpm,
  readReleasePackages,
  verifyExistingPackage,
} from "./publish-npm-product.mjs";
import { registryVersionUrl } from "./verify-npm-publish.mjs";

const sha = "a".repeat(40);
const version = "0.14.0";
const releaseTag = `v${version}`;
const cert = (
  await readFile(new URL("./npm-provenance-cert.fixture.txt", import.meta.url), "utf8")
).trim();
const digest = Buffer.alloc(64, 3);
const integrity = `sha512-${digest.toString("base64")}`;
const pkg = (name) => ({ name, version });

function evidence(name, changes = {}) {
  const ref = changes.ref ?? "refs/heads/main";
  const statement = {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: `pkg:npm/${encodeURIComponent(name).replace("%2F", "/")}@${version}`,
        digest: { sha512: changes.digest ?? digest.toString("hex") },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref,
            repository: changes.repository ?? "https://github.com/sebastian-software/ferriki",
            path: changes.path ?? ".github/workflows/publish.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/sebastian-software/ferriki@${ref}`,
            digest: { gitCommit: changes.sha ?? sha },
          },
        ],
      },
    },
  };
  return {
    metadata: {
      name,
      version,
      dist: {
        integrity,
        attestations: {
          url: attestationUrl(name, version),
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
      },
    },
    attestations: {
      attestations: [
        {
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: {
            dsseEnvelope: {
              payloadType: "application/vnd.in-toto+json",
              payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
            },
            verificationMaterial: { certificate: { rawBytes: cert } },
          },
        },
      ],
    },
  };
}

function fakeTransport(states) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url) => {
      requests.push(url);
      const state = states.get(url);
      if (state instanceof Error) throw state;
      if (state === undefined) return { ok: false, status: 404 };
      if (typeof state === "number") return { ok: false, status: state };
      const value = Array.isArray(state) ? state.shift() : state;
      if (value === undefined) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => value };
    },
  };
}

function storeExisting(states, name, changes, tags = { next: version }) {
  const { metadata, attestations } = evidence(name, changes);
  states.set(registryVersionUrl(name, version), metadata);
  states.set(attestationUrl(name, version), attestations);
  states.set(distTagsUrl(name), tags);
}

const sidecars = [
  pkg("@ferriki/linux-x64-gnu"),
  pkg("@ferriki/linux-arm64-gnu"),
  pkg("@ferriki/linux-x64-musl"),
];
const states = new Map();
storeExisting(states, sidecars[0].name, undefined, { next: "0.13.0" });
storeExisting(states, sidecars[1].name, undefined, { next: "0.13.0" });
const transport = fakeTransport(states);
const published = [];
const promoted = [];
const options = {
  sourceSha: sha,
  releaseTag,
  tag: "next",
  fetchImpl: transport.fetchImpl,
  sleepImpl: async () => {},
  publishImpl: async (item) => published.push(item.name),
  promoteImpl: async (item) => promoted.push(item.name),
};
await publishPhase({ ...options, phase: "sidecars", packages: sidecars });
assert.deepEqual(
  promoted,
  sidecars.slice(0, 2).map((item) => item.name),
);
assert.deepEqual(published, [sidecars[2].name]);

// Core already succeeded, while Vite's publish fails: the failure is not
// treated as a harmless duplicate, and a later run can retry Vite only.
const core = pkg("@ferriki/core");
const vite = pkg("@ferriki/vite");
storeExisting(states, core.name);
await publishPhase({ ...options, packages: [core], phase: "core" });
assert.equal(promoted.length, 2, "an already-correct dist-tag must cause no write");
await assert.rejects(
  publishPhase({
    ...options,
    packages: [vite],
    phase: "vite",
    publishImpl: async () => {
      throw new Error("npm publish failed");
    },
  }),
  /npm publish failed/,
);
storeExisting(states, vite.name);
await publishPhase({
  ...options,
  packages: [core, vite],
  phase: "vite",
  publishImpl: async () => {
    throw new Error("must not republish");
  },
});
assert.equal(promoted.length, 2, "all existing versions with correct tags remain read-only");

// A recovery lookup tolerates short registry lag, but only 404 means absent.
const lagged = pkg("@ferriki/darwin-arm64");
storeExisting(states, lagged.name);
const metadata = states.get(registryVersionUrl(lagged.name, version));
states.set(registryVersionUrl(lagged.name, version), [undefined, metadata]);
const lagTransport = fakeTransport(states);
assert.equal(
  await lookupPackage({
    ...lagged,
    sourceSha: sha,
    releaseTag,
    recovery: true,
    fetchImpl: lagTransport.fetchImpl,
    sleepImpl: async () => {},
  }),
  "existing",
);
assert.equal(
  lagTransport.requests.filter((url) => url === registryVersionUrl(lagged.name, version)).length,
  2,
);

for (const [label, changes] of [
  ["source", { sha: "b".repeat(40) }],
  ["digest", { digest: "f".repeat(128) }],
  ["repository", { repository: "https://github.com/foreign/repo" }],
  ["workflow", { path: ".github/workflows/foreign.yml" }],
  ["certificate identity", { ref: "refs/tags/v0.14.0" }],
]) {
  assert.throws(
    () =>
      verifyExistingPackage({
        name: core.name,
        version,
        sourceSha: sha,
        releaseTag,
        ...evidence(core.name, changes),
      }),
    /provenance does not match/,
    label,
  );
}
const wrongMetadata = evidence(core.name);
wrongMetadata.metadata.dist.integrity = `sha512-${Buffer.alloc(64, 8).toString("base64")}`;
assert.throws(
  () =>
    verifyExistingPackage({
      name: core.name,
      version,
      sourceSha: sha,
      releaseTag,
      ...wrongMetadata,
    }),
  /provenance does not match/,
);
for (const failure of [401, 403, 500, new Error("network down")]) {
  const badTransport = fakeTransport(new Map([[registryVersionUrl(core.name, version), failure]]));
  await assert.rejects(
    lookupPackage({
      ...core,
      sourceSha: sha,
      releaseTag,
      recovery: true,
      fetchImpl: badTransport.fetchImpl,
      sleepImpl: async () => {},
    }),
  );
}
const unavailableTags = new Map();
storeExisting(unavailableTags, core.name);
unavailableTags.set(distTagsUrl(core.name), 403);
await assert.rejects(
  publishPhase({
    ...options,
    packages: [core],
    phase: "core",
    fetchImpl: fakeTransport(unavailableTags).fetchImpl,
    publishImpl: async () => {
      throw new Error("must not publish");
    },
  }),
  /HTTP 403/,
);

const actual = await readReleasePackages();
assert.equal(actual.sidecars.length, 7);
assert.equal(actual.core[0].name, "@ferriki/core");
assert.equal(actual.vite[0].name, "@ferriki/vite");

for (const [item, phase] of [
  [core, "core"],
  [sidecars[0], "sidecars"],
  [vite, "vite"],
]) {
  const commands = [];
  await publishWithNpm({ ...item, path: `/source/node/${phase}` }, "next", phase, {
    spawnImpl: (command, args) => {
      commands.push([command, args]);
      const destination = args[args.indexOf("--pack-destination") + 1];
      return {
        status: 0,
        stdout: JSON.stringify({
          name: item.name,
          version: item.version,
          filename: `${destination}/ferriki-package.tgz`,
        }),
      };
    },
    inspectPackImpl: () => ({ name: item.name, version: item.version, dependencies: {} }),
    runImpl: (...args) => commands.push(args),
  });
  assert.equal(commands[0][0], "pnpm");
  assert.deepEqual(commands[0][1].slice(0, 3), ["--dir", `/source/node/${phase}`, "pack"]);
  assert.equal(commands[1][0], "npm");
  assert.equal(commands[1][1][0], "publish");
  assert.match(commands[1][1][1], /ferriki-package\.tgz$/);
  assert.deepEqual(commands[1][1].slice(2), [
    "--access",
    "public",
    "--provenance",
    "--tag",
    "next",
  ]);
}
console.log("Ferriki npm publish recovery verified with fake transport");
