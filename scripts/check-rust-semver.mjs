#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const publicCrates = [
  ["ferriki", "Cargo.toml"],
  ["ferriki-textmate", "crates/ferriki-textmate/Cargo.toml"],
  ["ferriki-asset-gen", "crates/ferriki-asset-gen/Cargo.toml"],
];

export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`Expected a stable X.Y.Z version, got ${JSON.stringify(value)}`);
  return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return Math.sign(left[index] - right[index]);
  }
  return 0;
}

export function selectBaseline(candidate, versions, allowedMajor) {
  const current = parseVersion(candidate);
  if (current[0] < 1)
    throw new Error("The released-baseline gate requires a 1.x or later candidate");
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error("crates.io returned no version records");
  }
  const released = versions
    .map((entry) => {
      if (typeof entry?.num !== "string" || typeof entry.yanked !== "boolean") {
        throw new Error("crates.io returned a malformed version record");
      }
      if (entry.yanked || entry.num.includes("-") || entry.num.includes("+")) return null;
      return { num: entry.num, tuple: parseVersion(entry.num) };
    })
    .filter(Boolean)
    .sort((a, b) => compareVersions(b.tuple, a.tuple));
  if (released.length === 0) throw new Error("crates.io has no non-yanked stable baseline");

  const sameMajor = released.find((entry) => entry.tuple[0] === current[0]);
  const newest = released[0];
  if (newest.tuple[0] > current[0]) {
    throw new Error(`Candidate ${candidate} predates released ${newest.num}`);
  }
  if (sameMajor) {
    if (allowedMajor !== undefined) {
      throw new Error(
        `--allow-major ${allowedMajor} is stale: ${sameMajor.num} is already released`,
      );
    }
    if (compareVersions(current, sameMajor.tuple) < 0) {
      throw new Error(`Candidate ${candidate} predates released ${sameMajor.num}`);
    }
    const releaseType =
      current[1] > sameMajor.tuple[1] || compareVersions(current, sameMajor.tuple) === 0
        ? "minor"
        : "patch";
    return { baseline: sameMajor.num, releaseType };
  }

  if (current[0] !== newest.tuple[0] + 1 || current[1] !== 0 || current[2] !== 0) {
    throw new Error(`No same-major baseline for ${candidate}; latest stable is ${newest.num}`);
  }
  if (allowedMajor !== current[0]) {
    throw new Error(`Major ${candidate} needs explicit --allow-major ${current[0]} in CI`);
  }
  return { baseline: newest.num, releaseType: "major" };
}

export async function readManifestVersion(path, expectedName) {
  const contents = await readFile(path, "utf8");
  const packageSection = /^\[package\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(contents)?.[1];
  if (!packageSection) throw new Error(`${path} has no [package] section`);
  const name = /^name\s*=\s*"([^"]+)"/m.exec(packageSection)?.[1];
  const version = /^version\s*=\s*"([^"]+)"/m.exec(packageSection)?.[1];
  if (name !== expectedName || !version) throw new Error(`${path} has unexpected package metadata`);
  parseVersion(version);
  return version;
}

export async function registryVersions(name, fetcher = fetch) {
  const versions = [];
  let url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/versions?per_page=100`;
  const seen = new Set();
  while (url) {
    if (seen.has(url) || seen.size >= 20) throw new Error(`${name}: invalid crates.io pagination`);
    seen.add(url);
    const response = await fetcher(url, {
      headers: {
        "User-Agent": "ferriki-rust-semver-ci (https://github.com/sebastian-software/ferriki)",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`${name}: crates.io returned HTTP ${response.status}`);
    const body = await response.json();
    if (
      !Array.isArray(body?.versions) ||
      !body.meta ||
      !(body.meta.next_page === null || typeof body.meta.next_page === "string")
    ) {
      throw new Error(`${name}: malformed crates.io response`);
    }
    versions.push(...body.versions);
    if (body.meta.next_page) {
      const next = new URL(body.meta.next_page, "https://crates.io");
      if (
        next.origin !== "https://crates.io" ||
        !next.pathname.startsWith(`/api/v1/crates/${name}/versions`)
      ) {
        throw new Error(`${name}: unexpected crates.io next page`);
      }
      url = next.href;
    } else {
      url = null;
    }
  }
  return versions;
}

async function main() {
  const args = process.argv.slice(2);
  let allowedMajor;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--allow-major" || !/^[1-9]\d*$/.test(args[1])) {
      throw new Error("Usage: node scripts/check-rust-semver.mjs [--allow-major <major>]");
    }
    allowedMajor = Number(args[1]);
  }
  const versions = await Promise.all(
    publicCrates.map(([name, manifest]) => readManifestVersion(join(root, manifest), name)),
  );
  if (new Set(versions).size !== 1)
    throw new Error(`Public crate versions differ: ${versions.join(", ")}`);
  for (const [name, manifest] of publicCrates) {
    const candidate = versions[0];
    const { baseline, releaseType } = selectBaseline(
      candidate,
      await registryVersions(name),
      allowedMajor,
    );
    for (const featureFlag of ["--default-features", "--all-features"]) {
      console.log(`${name}: ${baseline} -> ${candidate}, ${releaseType}, ${featureFlag}`);
      const result = spawnSync(
        "cargo",
        [
          "semver-checks",
          "check-release",
          "--manifest-path",
          join(root, manifest),
          "--package",
          name,
          "--baseline-version",
          baseline,
          "--release-type",
          releaseType,
          featureFlag,
        ],
        { cwd: root, stdio: "inherit" },
      );
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(`${name} ${featureFlag}: cargo-semver-checks exited ${result.status}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
