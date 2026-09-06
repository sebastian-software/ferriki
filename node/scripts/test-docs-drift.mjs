import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkDocsDrift,
  FERRIKI_PACKAGE,
  NODE_FLOOR_DOCS,
  SHIKI_BASELINE_DOCS,
  SHIKI_SOURCE,
  STALE_GUIDANCE,
} from "./check-docs-drift.mjs";

// The fixture is a copy of the real documents, so every case below starts
// from a tree the checker accepts and injects exactly one kind of drift.
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const fixtureFiles = [
  ...new Set([
    "CLAUDE.md",
    SHIKI_SOURCE,
    FERRIKI_PACKAGE,
    ...STALE_GUIDANCE.map(([relative]) => relative),
    ...SHIKI_BASELINE_DOCS,
    ...NODE_FLOOR_DOCS,
  ]),
];

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "ferriki-docs-drift-"));
  try {
    for (const relative of fixtureFiles) {
      const target = join(root, relative);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(repoRoot, relative), target);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function edit(root, relative, transform) {
  const path = join(root, relative);
  const source = await readFile(path, "utf8");
  const next = transform(source);
  assert.notEqual(next, source, `fixture edit of ${relative} must change the file`);
  await writeFile(path, next);
}

async function editJson(root, relative, transform) {
  await edit(
    root,
    relative,
    (source) => `${JSON.stringify(transform(JSON.parse(source)), null, 2)}\n`,
  );
}

const shikiRef = JSON.parse(await readFile(join(repoRoot, SHIKI_SOURCE), "utf8")).ref;
const nodeFloor = JSON.parse(
  await readFile(join(repoRoot, FERRIKI_PACKAGE), "utf8"),
).engines.node.replace(/^\D*/, "");
const staleShikiRef = "v4.3.1";
const staleNodeFloor = "20";
// Documents write the baseline as `Shiki v4.4.3` or `Shiki **v4.4.3**`.
const pinnedShikiMention = new RegExp(`Shiki (\\*{0,2})${shikiRef.replaceAll(".", "\\.")}`);
assert.notEqual(
  staleShikiRef,
  shikiRef,
  "the injected Shiki version must differ from the pinned one",
);
assert.notEqual(
  staleNodeFloor,
  nodeFloor,
  "the injected Node version must differ from the declared floor",
);

// The document lists are hard-coded in the checker; keep the entry points a
// contributor reads first under the check even if the lists are trimmed.
for (const relative of [
  "README.md",
  "CONTRIBUTING.md",
  "docs/compatibility.md",
  "node/ferriki/README.md",
]) {
  assert(
    SHIKI_BASELINE_DOCS.includes(relative),
    `${relative} must stay under the Shiki baseline check`,
  );
  assert(NODE_FLOOR_DOCS.includes(relative), `${relative} must stay under the Node floor check`);
}
assert(NODE_FLOOR_DOCS.includes("AGENTS.md"), "AGENTS.md must stay under the Node floor check");

test("accepts the checked-in documents and reports both sources", async () => {
  await withFixture(async (root) => {
    assert.deepEqual(await checkDocsDrift(root), { shikiRef, nodeFloor });
  });
});

for (const relative of SHIKI_BASELINE_DOCS) {
  test(`rejects a stale Shiki baseline in ${relative}`, async () => {
    await withFixture(async (root) => {
      await edit(root, relative, (source) =>
        source.replace(pinnedShikiMention, `Shiki $1${staleShikiRef}`),
      );
      await assert.rejects(checkDocsDrift(root), {
        message: `${relative} names a stale Shiki baseline (${staleShikiRef}); the mirror pins ${shikiRef}`,
      });
    });
  });
}

test("rejects a document that stops naming the Shiki baseline", async () => {
  await withFixture(async (root) => {
    await edit(root, "docs/compatibility.md", (source) =>
      source.replaceAll(new RegExp(pinnedShikiMention, "g"), "Shiki"),
    );
    await assert.rejects(checkDocsDrift(root), {
      message: `docs/compatibility.md must name the pinned Shiki baseline (${shikiRef})`,
    });
  });
});

for (const relative of NODE_FLOOR_DOCS) {
  test(`rejects a stale Node floor in ${relative}`, async () => {
    await withFixture(async (root) => {
      await edit(root, relative, (source) => `${source}\nRequires Node.js >= ${staleNodeFloor}.\n`);
      await assert.rejects(checkDocsDrift(root), {
        message: `${relative} states a Node version other than the declared floor ${nodeFloor}: ${staleNodeFloor}`,
      });
    });
  });
}

test("rejects a document that stops stating the Node floor", async () => {
  await withFixture(async (root) => {
    await edit(root, "AGENTS.md", (source) => source.replaceAll(nodeFloor, "a supported version"));
    await assert.rejects(checkDocsDrift(root), {
      message: `AGENTS.md must state the Node floor ${nodeFloor} declared by ${FERRIKI_PACKAGE}`,
    });
  });
});

test("fails every baseline document when the Shiki source moves ahead of the prose", async () => {
  await withFixture(async (root) => {
    await editJson(root, SHIKI_SOURCE, (source) => ({ ...source, ref: "v9.9.9" }));
    await assert.rejects(checkDocsDrift(root), {
      message: `${SHIKI_BASELINE_DOCS[0]} names a stale Shiki baseline (${shikiRef}); the mirror pins v9.9.9`,
    });
  });
});

test("fails every floor document when engines.node moves ahead of the prose", async () => {
  await withFixture(async (root) => {
    await editJson(root, FERRIKI_PACKAGE, (pkg) => ({
      ...pkg,
      engines: { ...pkg.engines, node: ">=99.0.0" },
    }));
    await assert.rejects(checkDocsDrift(root), {
      message: `${NODE_FLOOR_DOCS[0]} must state the Node floor 99.0.0 declared by ${FERRIKI_PACKAGE}`,
    });
  });
});

test("rejects a Shiki source that is not an exact release tag", async () => {
  await withFixture(async (root) => {
    await editJson(root, SHIKI_SOURCE, (source) => ({ ...source, ref: "main" }));
    await assert.rejects(checkDocsDrift(root), {
      message: `${SHIKI_SOURCE} must pin an exact Shiki release tag`,
    });
  });
});

test("rejects an engines.node range without an exact floor", async () => {
  await withFixture(async (root) => {
    await editJson(root, FERRIKI_PACKAGE, (pkg) => ({
      ...pkg,
      engines: { ...pkg.engines, node: ">=22" },
    }));
    await assert.rejects(checkDocsDrift(root), {
      message: `${FERRIKI_PACKAGE} must declare an exact Node floor in \`engines.node\``,
    });
  });
});

test("still rejects stale guidance phrases", async () => {
  await withFixture(async (root) => {
    await edit(
      root,
      "AGENTS.md",
      (source) => `${source}\nSet FERRIKI_BACKEND=js to use the JS engine.\n`,
    );
    await assert.rejects(checkDocsDrift(root), {
      message: "AGENTS.md contains stale guidance: FERRIKI_BACKEND",
    });
  });
});

test("still requires CLAUDE.md to be the pointer line", async () => {
  await withFixture(async (root) => {
    await edit(root, "CLAUDE.md", () => "# Claude guidance\n");
    await assert.rejects(checkDocsDrift(root), /CLAUDE\.md must be exactly the pointer line/);
  });
});
