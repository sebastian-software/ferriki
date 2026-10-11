import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registryVersions, selectBaseline } from "./check-rust-semver.mjs";

const released = (num, yanked = false) => ({ num, yanked });

test("same-version work is checked as a minor update", () => {
  assert.deepEqual(selectBaseline("1.0.0", [released("1.0.0")]), {
    baseline: "1.0.0",
    releaseType: "minor",
  });
});

test("selects the newest stable non-yanked same-major version", () => {
  assert.deepEqual(
    selectBaseline("1.2.0", [
      released("1.0.0"),
      released("1.1.0"),
      released("1.2.0-rc.1"),
      released("1.2.0", true),
    ]),
    {
      baseline: "1.1.0",
      releaseType: "minor",
    },
  );
  assert.deepEqual(selectBaseline("1.1.1", [released("1.1.0")]), {
    baseline: "1.1.0",
    releaseType: "patch",
  });
});

test("fails closed on stale, missing, malformed, and prerelease metadata", () => {
  assert.throws(() => selectBaseline("1.0.0", [released("1.1.0")]), /predates released/);
  assert.throws(() => selectBaseline("1.0.0", []), /no version records/);
  assert.throws(() => selectBaseline("1.0.0", [{ num: "1.0.0" }]), /malformed/);
  assert.throws(() => selectBaseline("1.0.0-rc.1", [released("1.0.0")]), /stable X.Y.Z/);
  assert.throws(() => selectBaseline("1.0.0", [released("1.0.0", true)]), /no non-yanked/);
});

test("first next-major release requires explicit, non-stale CI opt-in", () => {
  assert.throws(() => selectBaseline("2.0.0", [released("1.9.0")]), /--allow-major 2/);
  assert.deepEqual(selectBaseline("2.0.0", [released("1.9.0")], 2), {
    baseline: "1.9.0",
    releaseType: "major",
  });
  assert.throws(() => selectBaseline("2.0.0", [released("2.0.0"), released("1.9.0")], 2), /stale/);
  assert.throws(() => selectBaseline("3.0.0", [released("1.9.0")], 3), /No same-major baseline/);
});

test("registry pagination is followed and malformed pages are rejected", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () =>
        calls.length === 1
          ? {
              versions: [released("1.0.0")],
              meta: { next_page: "/api/v1/crates/ferriki/versions?page=2" },
            }
          : { versions: [released("1.1.0")], meta: { next_page: null } },
    };
  };
  assert.deepEqual(await registryVersions("ferriki", fetcher), [
    released("1.0.0"),
    released("1.1.0"),
  ]);
  assert.equal(calls.length, 2);
  await assert.rejects(
    registryVersions("ferriki", async () => ({ ok: true, json: async () => ({ versions: [] }) })),
    /malformed/,
  );
  await assert.rejects(
    registryVersions("ferriki", async () => ({ ok: false, status: 503 })),
    /HTTP 503/,
  );
});

test("real checker denies removal of a released public type", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferriki-semver-negative-"));
  try {
    await mkdir(join(directory, "src"));
    await writeFile(
      join(directory, "Cargo.toml"),
      '[package]\nname = "ferriki-asset-gen"\nversion = "1.0.0"\nedition = "2024"\n',
    );
    await writeFile(join(directory, "src/lib.rs"), "pub struct OnlyAPlaceholder;\n");
    const result = spawnSync(
      "cargo",
      [
        "semver-checks",
        "check-release",
        "--manifest-path",
        join(directory, "Cargo.toml"),
        "--baseline-version",
        "1.0.0",
        "--release-type",
        "minor",
        "--default-features",
      ],
      { encoding: "utf8", timeout: 115_000 },
    );
    assert.ifError(result.error);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 100, output);
    assert.match(output, /ReleaseManifest/);
    assert.match(output, /struct_missing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
