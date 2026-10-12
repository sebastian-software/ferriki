#!/usr/bin/env node
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, gzipSync, constants as zlibConstants } from "node:zlib";

import { build } from "vite";

import { FERRIKI_PLATFORM_TARGETS, resolveFerrikiPlatformTarget } from "../ferriki/platforms.mjs";
import { ferriki } from "../vite/index.mjs";
import "./test-asset-env.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const nodeRoot = resolve(dirname(scriptPath), "..");
const repoRoot = resolve(nodeRoot, "..");
const benchmarkRoot = join(nodeRoot, "benchmarks", "shadow-dom-spike");
const componentPath = join(nodeRoot, "examples", "shadow-dom", "ShadowCode.mjs");
const referenceComponentPath = join(nodeRoot, "examples", "shadow-dom", "ReferenceCode.mjs");
const browserRuntimePath = join(nodeRoot, "ferriki", "web-component.mjs");
const serverRuntimePath = join(nodeRoot, "ferriki", "web-component-server.mjs");
const fixtureRoot = join(benchmarkRoot, "fixtures");
const fixtureFiles = { medium: "medium.tsx", large: "large.tsx" };
const styleModes = ["inline", "classes"];
const renderers = ["light", "shadow", "reference", "dsd"];
const workloadNames = ["one-large", "twelve-mixed"];
const workloadBlocks = {
  "one-large": [{ source: "large", key: "large-0" }],
  "twelve-mixed": Array.from({ length: 12 }, (_, index) => ({
    source: index % 2 === 0 ? "medium" : "large",
    key: `${index % 2 === 0 ? "medium" : "large"}-${index}`,
  })),
};
const cells = styleModes.flatMap((styleMode) =>
  renderers.map((renderer) => ({
    id: `${styleMode}-${renderer}`,
    styleMode,
    renderer,
  })),
);
const profileCells = ["light", "reference", "dsd"].map((renderer) =>
  cells.find((cell) => cell.styleMode === "inline" && cell.renderer === renderer),
);
const profileWorkload = "twelve-mixed";
let snippets;

function parseArguments(args) {
  const options = {
    samples: 10,
    warmup: 3,
    profile: false,
    profileSamples: 15,
    profileWarmup: 4,
    write: undefined,
    validateOnly: false,
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      console.log(
        [
          "Usage: node scripts/bench-shadow-dom-spike.mjs [options]",
          "",
          "Options:",
          "  --samples <n>       Timed SSR and browser samples per cell/workload (default 10)",
          "  --warmup <n>        Untimed SSR and browser warmups (default 3)",
          "  --profile           Profile inline twelve-mixed light/reference/DSD hydration and mount controls",
          "  --profile-samples <n> Timed samples per focused profile condition (default 15)",
          "  --profile-warmup <n>  Untimed focused profile warmups (default 4)",
          "  --write <path>      JSON report path (default: a timestamped file in /private/tmp)",
          "  --validate-only     Build and run correctness checks without timed samples",
        ].join("\n"),
      );
      process.exit(0);
    }
    if (argument === "--validate-only") {
      options.validateOnly = true;
      continue;
    }
    if (argument === "--profile") {
      options.profile = true;
      continue;
    }
    if (
      !["--samples", "--warmup", "--profile-samples", "--profile-warmup", "--write"].includes(
        argument,
      )
    )
      throw new Error(`Unknown argument: ${argument}`);
    const value = args[++index];
    if (!value) throw new Error(`Missing value for ${argument}`);
    if (argument === "--write") options.write = resolve(value);
    else {
      const parsed = Number(value);
      assert(Number.isInteger(parsed), `${argument} must be an integer`);
      if (argument === "--warmup" || argument === "--profile-warmup") {
        assert(parsed >= 0, `${argument} must not be negative`);
        options[argument === "--warmup" ? "warmup" : "profileWarmup"] = parsed;
      } else {
        assert(parsed >= 1, `${argument} must be positive`);
        options[argument === "--profile-samples" ? "profileSamples" : "samples"] = parsed;
      }
    }
  }
  assert(
    !(options.profile && options.validateOnly),
    "--profile cannot be combined with --validate-only",
  );
  return options;
}

const settings = parseArguments(process.argv.slice(2));
const depsRoot = resolve(
  process.env.FERRIKI_SHADOW_BENCH_DEPS_ROOT ?? join(nodeRoot, "examples", "inline-macro"),
);
const depsNodeModules = join(depsRoot, "node_modules");
const depsRequire = createRequire(join(depsRoot, "__ferriki-shadow-dom-spike__.cjs"));
const { chromium } = depsRequire("playwright");
const tempRoot = await mkdtemp(join(tmpdir(), "ferriki-shadow-dom-spike-"));
const projectRoot = join(tempRoot, "consumer");
const projectNodeModules = join(projectRoot, "node_modules");

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(path) {
  return hash(await readFile(path));
}

async function readPackageVersion(packageName, root) {
  const packagePath = join(root, "node_modules", ...packageName.split("/"), "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  return { path: packagePath, version: manifest.version };
}

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function isReactModule(id) {
  const normalized = id.replaceAll("\\", "/");
  return /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:react|react-dom|scheduler)(?:\/|$)/.test(
    normalized,
  );
}

function compressionBytes(buffer) {
  return {
    raw: buffer.byteLength,
    gzip: gzipSync(buffer, { level: 9, mtime: 0 }).byteLength,
    brotli: brotliCompressSync(buffer, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
    }).byteLength,
  };
}

function moduleIdsForResult(result) {
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.flatMap((output) => output?.output ?? []).filter((item) => item?.type === "chunk");
}

async function collectAssets(outDir, result) {
  const chunks = moduleIdsForResult(result);
  const metadataByName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path);
    }
  }
  await visit(outDir);

  const javascript = [];
  const css = [];
  for (const path of files) {
    const fileName = relative(outDir, path).replaceAll("\\", "/");
    const extension = extname(path);
    if (![".js", ".mjs", ".css"].includes(extension)) continue;
    const buffer = await readFile(path);
    if (extension === ".css") {
      css.push({ fileName, ...compressionBytes(buffer) });
      continue;
    }
    const chunk = metadataByName.get(fileName);
    const modules = Object.keys(chunk?.modules ?? {});
    const reactModules = modules.filter(isReactModule);
    const isDedicatedReact =
      chunk?.name === "react-vendor" &&
      modules.length > 0 &&
      reactModules.length === modules.length;
    javascript.push({
      fileName,
      name: chunk?.name ?? null,
      moduleCount: modules.length,
      modules,
      isDedicatedReact,
      ...compressionBytes(buffer),
    });
  }
  const sum = (assets) => ({
    raw: assets.reduce((total, asset) => total + asset.raw, 0),
    gzip: assets.reduce((total, asset) => total + asset.gzip, 0),
    brotli: assets.reduce((total, asset) => total + asset.brotli, 0),
  });
  const reactAssets = javascript.filter((asset) => asset.isDedicatedReact);
  return {
    javascript,
    css,
    javascriptTotal: sum(javascript),
    javascriptNonReact: reactAssets.length
      ? sum(javascript.filter((asset) => !asset.isDedicatedReact))
      : null,
    dedicatedReactChunks: reactAssets.map((asset) => asset.fileName),
    cssTotal: sum(css),
  };
}

function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  const median =
    sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  return {
    count: sorted.length,
    median,
    p10: percentile(0.1),
    p90: percentile(0.9),
    min: sorted[0],
    max: sorted.at(-1),
    mean,
    standardDeviation: Math.sqrt(variance),
  };
}

async function resolveNativeBuild() {
  const receiptPath = join(nodeRoot, "ferriki", ".benchmark-build.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const targetId = process.env.FERRIKI_PLATFORM_ID ?? resolveFerrikiPlatformTarget()?.id;
  assert(targetId, "FERRIKI_PLATFORM_ID is required on an unsupported native target");
  const target = FERRIKI_PLATFORM_TARGETS.find((entry) => entry.id === targetId);
  assert(target, `unknown Ferriki platform ID ${targetId}`);
  const coreRequire = createRequire(join(nodeRoot, "ferriki", "native.mjs"));
  const candidates = [
    `${target.packageName}/ferriki.node`,
    join(nodeRoot, "platforms", targetId, "ferriki.node"),
    join(nodeRoot, "ferriki", "dist", target.binaryName),
    join(nodeRoot, "ferriki", "dist", "ferriki.node"),
    join(nodeRoot, "ferriki", "ferriki.node"),
  ];
  for (const candidate of candidates) {
    try {
      const addon = await realpath(coreRequire.resolve(candidate));
      const binarySha256 = await hashFile(addon);
      if (binarySha256 !== receipt.binarySha256) continue;
      return { targetId, path: addon, binarySha256, receiptPath, receipt };
    } catch {
      // Try the next normal native resolution path.
    }
  }
  throw new Error(
    "No loaded native addon matches node/ferriki/.benchmark-build.json; run the ordinary build:native first.",
  );
}

function makeBlocksModule(snippets) {
  return [
    'import { code } from "@ferriki/core/macro";',
    "",
    `export const mediumBlock = code(${JSON.stringify(snippets.medium.text)}, { language: "tsx", meta: 'title="Medium shadow benchmark" [benchmark] {2}', lineNumbers: true });`,
    `export const largeBlock = code(${JSON.stringify(snippets.large.text)}, { language: "tsx", meta: 'title="Large shadow benchmark" [benchmark] {2}', lineNumbers: true });`,
    "",
  ].join("\n");
}

function makeAppModule(renderer, profile = false) {
  const usesReferences = renderer === "reference" || renderer === "dsd";
  const componentImport =
    renderer === "shadow"
      ? 'import { ShadowCode } from "./ShadowCode.mjs";'
      : usesReferences
        ? 'import { codeElementSizing } from "@ferriki/core/web-component";\nimport { ReferenceCode } from "./ReferenceCode.mjs";'
        : 'import { codeElementStyles } from "@ferriki/core/web-component";';
  const renderComponent =
    renderer === "shadow"
      ? `function CodeIsland({ code, className, theme }) {
  return React.createElement(ShadowCode, { code, className, theme });
}`
      : usesReferences
        ? `function CodeIsland({ referenceId, className, theme, style }) {
  return React.createElement(ReferenceCode, {
    codeRef: referenceId,
    className,
    theme,
    style,
    "data-code-host": "",
    "data-bench-ref": referenceId,
  });
}`
        : `const LIGHT_CODE_CSS = codeElementStyles(["light", "dark"]).replaceAll(
  /:host\\(([^)]+)\\)/g,
  "[data-code-host]$1",
).replaceAll(":host", "[data-code-host]");

function CodeIsland({ code, className, theme }) {
  return React.createElement(
    "div",
    {
      className,
      "data-code-host": "",
      "data-ferriki-theme": theme,
      "data-light-code": "",
      dangerouslySetInnerHTML: { __html: code.html },
    },
  );
}`;
  const referenceSizing = usesReferences
    ? `const MEDIUM_REFERENCE_STYLE = codeElementSizing(
  mediumBlock.code.split(/\\r\\n|\\r|\\n/u).length,
);
const LARGE_REFERENCE_STYLE = codeElementSizing(
  largeBlock.code.split(/\\r\\n|\\r|\\n/u).length,
);
`
    : "";
  const sharedStyleChild =
    renderer === "light"
      ? '    React.createElement("style", { "data-bench-shared-code-css": "" }, LIGHT_CODE_CSS),'
      : "";
  const codeProp = usesReferences ? "" : "            code,\n";
  const sizingProp = usesReferences
    ? '            style: referenceId === "medium" ? MEDIUM_REFERENCE_STYLE : LARGE_REFERENCE_STYLE,\n'
    : "";
  const source = `import React, { useState } from "react";
import { mediumBlock, largeBlock } from "./snippets.jsx";
${componentImport}

${referenceSizing}
const useCommitEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

${renderComponent}

function blocksFor(workload) {
  if (workload === "one-large")
    return [{ key: "large-0", referenceId: "large", code: largeBlock }];
  return Array.from({ length: 12 }, (_, index) => ({
    key: (index % 2 === 0 ? "medium" : "large") + "-" + index,
    referenceId: index % 2 === 0 ? "medium" : "large",
    code: index % 2 === 0 ? mediumBlock : largeBlock,
  }));
}

function finishPendingCommit() {
  if (typeof window === "undefined") return;
  const phase = window.__shadowPendingPhase;
  if (!phase) return;
  const commit = performance.now();
${profile ? '  if (window.__ferrikiProfile) performance.mark("ferriki:profile:app-commit");\n' : ""}  const current = window.__shadowCaptureNodes();
  if (!window.__shadowIdentityBaseline) window.__shadowIdentityBaseline = current;
  const identity = window.__shadowCompareNodes(window.__shadowIdentityBaseline, current);
  const result = {
    start: window.__shadowPendingStart,
    presentationSetupMs: window.__shadowPresentationSetupMs ?? 0,
    commit,
    identity,
  };
  window.__shadowResults[phase] = result;
  window.__shadowPendingPhase = null;
  requestAnimationFrame(() => {
    result.raf1 = performance.now();
${profile ? '    if (window.__ferrikiProfile) performance.mark("ferriki:profile:post-commit:raf1");\n' : ""}
    requestAnimationFrame(() => {
      result.raf2 = performance.now();
${profile ? '      if (window.__ferrikiProfile) performance.mark("ferriki:profile:post-commit:raf2");\n' : ""}
    });
  });
}

export function App({ workload = "one-large" }) {
  const [theme, setTheme] = useState("light");
  const [revision, setRevision] = useState(0);
  useCommitEffect(finishPendingCommit, [theme, revision]);

  const blocks = blocksFor(workload);
  return React.createElement(
    "main",
    { "data-bench-renderer": "${renderer}", "data-bench-workload": workload, "data-bench-theme": theme },
${sharedStyleChild}
    React.createElement(
      "div",
      { className: "bench-controls" },
      React.createElement(
        "button",
        { type: "button", "data-action": "theme", onClick: () => {
          window.__shadowBeginPhase("theme-update");
          setTheme((value) => value === "light" ? "dark" : "light");
        } },
        "Toggle theme",
      ),
      React.createElement(
        "button",
        { type: "button", "data-action": "rerender", onClick: () => {
          window.__shadowBeginPhase("parent-rerender");
          setRevision((value) => value + 1);
        } },
        "Rerender parent",
      ),
    ),
    React.createElement(
      "div",
      { className: "bench-blocks" },
      blocks.map(({ key, referenceId, code }, index) =>
        React.createElement(
          "section",
          { key, "data-bench-block": String(index), "data-bench-source": key },
          React.createElement(CodeIsland, {
${codeProp}${sizingProp}            referenceId,
            className: "bench-code parent-" + revision,
            theme,
          }),
        ),
      ),
    ),
  );
}
`;
  if (renderer === "reference" || renderer === "dsd")
    assert.doesNotMatch(
      source,
      /React\.createElement\(CodeIsland,\s*\{\s*code,/u,
      `${renderer} lane passed a prepared descriptor as a React prop`,
    );
  if (usesReferences)
    assert.doesNotMatch(
      source,
      /React\.createElement\(CodeIsland,\s*\{[^}]*\bcode\s*(?::|,)/u,
      `${renderer} lane passed code HTML through React props`,
    );
  return source;
}

function makeClientModule(renderer, profile = false) {
  const setup =
    renderer === "shadow"
      ? `const setupStart = performance.now();
defineCodeElement({ css: [mediumBlock.css, largeBlock.css].join("\\n"), themeAliases: ["light", "dark"] });
window.__shadowPresentationSetupMs = performance.now() - setupStart;`
      : renderer === "reference" || renderer === "dsd"
        ? `const setupStart = performance.now();
defineCodeElement({
  css: [mediumBlock.css, largeBlock.css].filter(Boolean).join("\\n"),
  themeAliases: ["light", "dark"],
  blocks: { medium: mediumBlock.html, large: largeBlock.html },
});
window.__shadowPresentationSetupMs = performance.now() - setupStart;`
        : "window.__shadowPresentationSetupMs = 0;";
  const imports =
    renderer === "shadow"
      ? 'import { defineCodeElement } from "@ferriki/core/web-component";\nimport { mediumBlock, largeBlock } from "./snippets.jsx";'
      : renderer === "reference" || renderer === "dsd"
        ? 'import { defineCodeElement } from "@ferriki/core/web-component";\nimport { mediumBlock, largeBlock } from "./snippets.jsx";'
        : "";
  const source = `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./style.css";
${imports}
${setup}

function captureNodes() {
  return [...document.querySelectorAll("[data-bench-block] [data-code-host]")].map((host) => {
    const contentRoot = host.shadowRoot ?? host;
    return {
      host,
      shadowRoot: host.shadowRoot,
      contentRoot,
      pre: contentRoot.querySelector("pre"),
      token: contentRoot.querySelector("pre code span"),
    };
  });
}

function compareNodes(before, after) {
  if (!before || before.length !== after.length)
    return { sameCount: false, sameHosts: false, sameRoots: false, samePres: false, sameTokens: false };
  return {
    sameCount: true,
    sameHosts: before.every((node, index) => node.host === after[index].host),
    sameRoots: before.every((node, index) => node.shadowRoot === after[index].shadowRoot && node.contentRoot === after[index].contentRoot),
    samePres: before.every((node, index) => node.pre === after[index].pre),
    sameTokens: before.every((node, index) => node.token === after[index].token),
  };
}

window.__shadowCaptureNodes = captureNodes;
window.__shadowCompareNodes = compareNodes;
window.__shadowBeginPhase = (phase) => {
  window.__shadowPendingPhase = phase;
  window.__shadowPendingStart = performance.now();
};
window.__shadowResults = {};
window.__shadowRecoverableErrors = [];
window.__shadowIdentityBaseline = null;

const root = document.getElementById("root");
const props = { workload: root.dataset.workload };
if (root.dataset.mode === "hydrate") {
  window.__shadowIdentityBaseline = captureNodes();
  window.__shadowBeginPhase("hydrate");
  hydrateRoot(root, React.createElement(App, props), {
    onRecoverableError(error) {
      window.__shadowRecoverableErrors.push(String(error?.message ?? error));
    },
  });
} else {
  window.__shadowBeginPhase("client-mount");
  createRoot(root).render(React.createElement(App, props));
}
`;
  if (!profile) return source;

  const profiledStartup = `const root = document.getElementById("root");
const props = { workload: root.dataset.workload };
async function startProfile() {
  const control = profileControl;
  if (control === "preflush") {
    performance.mark("ferriki:profile:pre-hydrate-flush:start");
    root.getBoundingClientRect();
    document.body.offsetHeight;
    performance.mark("ferriki:profile:pre-hydrate-flush:end");
  }
  if (control === "two-raf") {
    performance.mark("ferriki:profile:two-raf:start");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    performance.mark("ferriki:profile:two-raf:end");
  }
  if (root.dataset.mode === "hydrate") {
    window.__shadowIdentityBaseline = captureNodes();
    window.__shadowBeginPhase("hydrate");
    const hydrate = () => {
      performance.mark("ferriki:profile:hydrateRoot:start");
      const result = hydrateRoot(root, React.createElement(App, props), {
        onRecoverableError(error) {
          window.__shadowRecoverableErrors.push(String(error?.message ?? error));
        },
      });
      performance.mark("ferriki:profile:hydrateRoot:return");
      return result;
    };
    if (control === "flushsync") {
      performance.mark("ferriki:profile:flushSync:start");
      flushSync(() => hydrate());
      performance.mark("ferriki:profile:flushSync:return");
    } else hydrate();
  } else {
    window.__shadowBeginPhase("client-mount");
    performance.mark("ferriki:profile:createRoot:start");
    const clientRoot = createRoot(root);
    performance.mark("ferriki:profile:createRoot:return");
    clientRoot.render(React.createElement(App, props));
  }
}
void startProfile();`;
  const defaultStartup = `const root = document.getElementById("root");
const props = { workload: root.dataset.workload };
if (root.dataset.mode === "hydrate") {
  window.__shadowIdentityBaseline = captureNodes();
  window.__shadowBeginPhase("hydrate");
  hydrateRoot(root, React.createElement(App, props), {
    onRecoverableError(error) {
      window.__shadowRecoverableErrors.push(String(error?.message ?? error));
    },
  });
} else {
  window.__shadowBeginPhase("client-mount");
  createRoot(root).render(React.createElement(App, props));
}`;
  const profilePrelude = `const profileControl = new URLSearchParams(location.search).get("profile") ?? "immediate";
window.__ferrikiProfile = { control: profileControl };
performance.mark("ferriki:profile:module-entry");`;
  let profiled = source.replace(defaultStartup, profiledStartup);
  assert.notEqual(profiled, source, "profile client did not replace its startup path");
  const setupSource = `${imports}\n${setup}`;
  const measuredSetup = `${imports}\n${profilePrelude}\nperformance.mark("ferriki:setup:start");\n${setup}\nperformance.mark("ferriki:setup:end");`;
  profiled = profiled.replace(setupSource, measuredSetup);
  assert.notEqual(
    profiled,
    source.replace(defaultStartup, profiledStartup),
    "profile setup markers were not inserted",
  );
  profiled = profiled.replace(
    'import { createRoot, hydrateRoot } from "react-dom/client";',
    'import { createRoot, hydrateRoot } from "react-dom/client";\nimport { flushSync } from "react-dom";',
  );
  return profiled;
}

async function writeProject(snippets, cell) {
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await mkdir(join(projectNodeModules, "@ferriki"), { recursive: true });
  await writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "ferriki-shadow-dom-spike-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  for (const packageName of ["react", "react-dom", "scheduler"]) {
    const packagePath = await realpath(join(depsNodeModules, packageName));
    const linkPath = join(projectNodeModules, packageName);
    try {
      await stat(linkPath);
    } catch {
      await symlink(packagePath, linkPath, "dir");
    }
  }
  const ferrikiLink = join(projectNodeModules, "@ferriki", "core");
  try {
    await stat(ferrikiLink);
  } catch {
    await symlink(await realpath(join(nodeRoot, "ferriki")), ferrikiLink, "dir");
  }
  const componentSource = await readFile(componentPath, "utf8");
  assert.match(componentSource, /export function ShadowCode\s*\(/);
  await writeFile(join(projectRoot, "src", "ShadowCode.mjs"), componentSource);
  await writeFile(
    join(projectRoot, "src", "ReferenceCode.mjs"),
    await readFile(referenceComponentPath, "utf8"),
  );
  await writeFile(join(projectRoot, "src", "snippets.jsx"), makeBlocksModule(snippets));
  await writeFile(
    join(projectRoot, "src", "App.jsx"),
    makeAppModule(cell.renderer, settings.profile),
  );
  await writeFile(
    join(projectRoot, "src", "client.jsx"),
    makeClientModule(cell.renderer, settings.profile),
  );
  await writeFile(
    join(projectRoot, "src", "server.jsx"),
    cell.renderer === "dsd"
      ? `import React from "react";
import { renderToString } from "react-dom/server";
import { codeElementStyles } from "@ferriki/core/web-component";
import { renderCodeElementShadows } from "@ferriki/core/web-component/server";
import { mediumBlock, largeBlock } from "./snippets.jsx";
import { App } from "./App.jsx";

const blocks = { medium: mediumBlock.html, large: largeBlock.html };
export const codeElementCss = [
  codeElementStyles(["light", "dark"]),
  mediumBlock.css,
  largeBlock.css,
].filter(Boolean).join("\\n");

export function render(workload) {
  const markup = renderToString(React.createElement(App, { workload }));
  return renderCodeElementShadows(markup, {
    blocks,
    stylesheetHref: "/ferriki-code.css",
  });
}
`
      : `import React from "react";
import { renderToString } from "react-dom/server";
import { App } from "./App.jsx";
export function render(workload) { return renderToString(React.createElement(App, { workload })); }
`,
  );
  await writeFile(
    join(projectRoot, "src", "style.css"),
    `:root { color-scheme: light; font-family: system-ui, sans-serif; }\nbody { margin: 1rem; }\n.bench-controls { display: flex; gap: .5rem; margin-block-end: 1rem; }\n.bench-blocks { display: grid; gap: 1rem; }\n.bench-code { display: block; }\n`,
  );
}

function makeTimedPlugin(cell, target, records) {
  const plugin = ferriki({
    themes: { light: "github-light-default", dark: "github-dark-default" },
    styleMode: cell.styleMode,
    lineNumbers: true,
    assets: { remote: false },
  });
  const hook = plugin.transform;
  assert(hook && typeof hook === "object" && typeof hook.handler === "function");
  const original = hook.handler;
  hook.handler = async function (source, id, ...rest) {
    const start = performance.now();
    let result;
    try {
      result = await original.call(this, source, id, ...rest);
      return result;
    } finally {
      if (id.split("?", 1)[0].endsWith("/src/snippets.jsx"))
        records.push({
          cell: cell.id,
          styleMode: cell.styleMode,
          renderer: cell.renderer,
          target,
          durationMs: performance.now() - start,
          inputBytes: Buffer.byteLength(source),
          outputBytes: result?.code === undefined ? null : Buffer.byteLength(result.code),
        });
    }
  };
  return plugin;
}

function createViteConfig(cell, target, outDir, transformRecords) {
  const server = target === "server";
  const entry = join(projectRoot, "src", server ? "server.jsx" : "client.jsx");
  return {
    configFile: false,
    root: projectRoot,
    mode: "production",
    appType: "custom",
    logLevel: "silent",
    plugins: [makeTimedPlugin(cell, target, transformRecords)],
    oxc: { jsx: { runtime: "automatic" } },
    resolve: { preserveSymlinks: true },
    build: {
      outDir,
      emptyOutDir: true,
      manifest: !server,
      sourcemap: false,
      minify: true,
      cssCodeSplit: true,
      ...(server ? { ssr: entry } : {}),
      rollupOptions: {
        input: entry,
        output: {
          ...(server ? { entryFileNames: "server.mjs" } : { manualChunks: splitReactChunk }),
        },
      },
    },
  };
}

function splitReactChunk(id) {
  return isReactModule(id) ? "react-vendor" : undefined;
}

async function buildCell(cell, buildRecords, transformRecords) {
  await writeProject(snippets, cell);
  const outputs = {};
  for (const target of ["client", "server"]) {
    const outDir = join(projectRoot, ".benchmark-builds", cell.id, target);
    await mkdir(dirname(outDir), { recursive: true });
    const start = performance.now();
    const result = await build(createViteConfig(cell, target, outDir, transformRecords));
    const durationMs = performance.now() - start;
    const record = {
      cell: cell.id,
      styleMode: cell.styleMode,
      renderer: cell.renderer,
      target,
      durationMs,
      outDir,
    };
    if (target === "client") {
      record.assets = await collectAssets(outDir, result);
      outputs.clientAssets = record.assets;
    }
    buildRecords.push(record);
    outputs[`${target}OutDir`] = outDir;
  }
  return outputs;
}

async function findServerEntry(outDir) {
  const entry = join(outDir, "server.mjs");
  await stat(entry);
  return entry;
}

async function loadServerRenderer(outputs, cell) {
  const entry = await findServerEntry(outputs.serverOutDir);
  const serverRequire = createRequire(entry);
  const reactPath = await realpath(serverRequire.resolve("react"));
  const serverPath = await realpath(serverRequire.resolve("react-dom/server"));
  assert.equal(
    reactPath,
    await realpath(depsRequire.resolve("react")),
    "SSR resolved a different React copy",
  );
  assert.equal(
    serverPath,
    await realpath(depsRequire.resolve("react-dom/server")),
    "SSR resolved a different ReactDOM copy",
  );
  const serverModule = await import(
    `${pathToFileURL(entry).href}?cell=${encodeURIComponent(cell.id)}`
  );
  assert.equal(typeof serverModule.render, "function");
  serverModule.render.codeElementCss = serverModule.codeElementCss ?? "";
  return serverModule.render;
}

function markupEvidence(markup, externalCodeStylesheetCss = "") {
  const styleMatches = [...markup.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/giu)];
  const styleTexts = styleMatches.map((match) => match[1]);
  const sharedStyleTexts = styleMatches
    .filter((match) => /\bdata-bench-shared-code-css[=\s>]/iu.test(match[0]))
    .map((match) => match[1]);
  const shadowTemplateTexts = [
    ...markup.matchAll(/<template\s+shadowrootmode=["']open["'][^>]*>([\s\S]*?)<\/template>/giu),
  ].map((match) => match[1]);
  const shadowLocalStyleTexts = shadowTemplateTexts.flatMap((template) =>
    [...template.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/giu)].map((match) => match[1]),
  );
  const styleBytes = Buffer.from(styleTexts.join("\n"));
  const sharedStyleBytes = Buffer.from(sharedStyleTexts.join("\n"));
  const shadowLocalStyleBytes = Buffer.from(shadowLocalStyleTexts.join("\n"));
  const markedCodeStylesheetTags = [...markup.matchAll(/<link\b[^>]*>/giu)]
    .map(([tag]) => tag)
    .filter((tag) => /\sdata-ferriki-code-css(?:\s|>|$)/u.test(tag));
  return {
    html: compressionBytes(Buffer.from(markup)),
    styleCount: styleTexts.length,
    embeddedCssText: compressionBytes(styleBytes),
    embeddedCssBytesPerStyle: styleTexts.map((style) => Buffer.byteLength(style)),
    sharedStyleCount: sharedStyleTexts.length,
    sharedCssText: compressionBytes(sharedStyleBytes),
    shadowLocalStyleCount: shadowLocalStyleTexts.length,
    shadowLocalCssText: compressionBytes(shadowLocalStyleBytes),
    externalCodeStylesheet: externalCodeStylesheetCss
      ? compressionBytes(Buffer.from(externalCodeStylesheetCss))
      : null,
    markedCodeStylesheetLinkCount: markedCodeStylesheetTags.length,
    markedCodeStylesheetUrls: markedCodeStylesheetTags
      .map((tag) => tag.match(/\shref="([^"]+)"/u)?.[1])
      .filter(Boolean),
    declarativeShadowTemplateCount: [
      ...markup.matchAll(/<template\s+shadowrootmode=["']open["']/giu),
    ].length,
    hostCount: [...markup.matchAll(/data-code-host[=\s>]/giu)].length,
  };
}

function assertMarkupLane(cell, workload, evidence) {
  const expectedHostCount = workloadBlocks[workload].length;
  const expectsDsd = cell.renderer === "dsd";
  assert.equal(evidence.hostCount, expectedHostCount);
  assert.equal(
    evidence.declarativeShadowTemplateCount,
    expectsDsd ? expectedHostCount : 0,
    `${cell.id}/${workload} emitted the wrong number of declarative shadow roots`,
  );
  assert.equal(
    evidence.markedCodeStylesheetLinkCount,
    expectsDsd ? expectedHostCount : 0,
    `${cell.id}/${workload} emitted the wrong number of DSD stylesheet links`,
  );
  if (expectsDsd) {
    assert.deepEqual(
      [...new Set(evidence.markedCodeStylesheetUrls)],
      ["/ferriki-code.css"],
      `${cell.id}/${workload} did not use exactly one shared stylesheet URL`,
    );
    assert.equal(evidence.styleCount, 0, `${cell.id}/${workload} duplicated CSS inline`);
    assert.equal(evidence.shadowLocalStyleCount, 0, `${cell.id}/${workload} duplicated CSS in DSD`);
    assert(
      evidence.externalCodeStylesheet?.raw > 0,
      `${cell.id}/${workload} shared DSD stylesheet was empty`,
    );
  }
}

async function benchmarkSsr(renderers, report) {
  for (const workload of workloadNames) {
    const evidenceByCell = new Map();
    for (const cell of cells) {
      const render = renderers.get(cell.id);
      const evidence = markupEvidence(
        render(workload),
        cell.renderer === "dsd" ? render.codeElementCss : "",
      );
      assertMarkupLane(cell, workload, evidence);
      evidenceByCell.set(cell.id, evidence);
    }
    for (
      let iteration = 0;
      iteration < settings.warmup + (settings.validateOnly ? 0 : settings.samples);
      iteration++
    ) {
      const order = [...cells];
      const pairIndex = styleModes.indexOf(order[0].styleMode);
      if ((iteration + workloadNames.indexOf(workload) + pairIndex) % 2) order.reverse();
      for (const cell of order) {
        const start = performance.now();
        renderers.get(cell.id)(workload);
        const durationMs = performance.now() - start;
        const evidence = evidenceByCell.get(cell.id);
        report.measurements.ssr.push({
          cell: cell.id,
          styleMode: cell.styleMode,
          renderer: cell.renderer,
          workload,
          iteration,
          phase: iteration < settings.warmup ? "warmup" : "sample",
          durationMs,
          ...evidence,
        });
      }
    }
  }
}

function createIndexHtml(cell, mode, workload, markup, entryFile, cssFiles) {
  const cssLinks = cssFiles.map((file) => `<link rel="stylesheet" href="/${file}">`).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ferriki Shadow DOM benchmark</title>
    ${cssLinks}
  </head>
  <body>
    <div id="root" data-mode="${mode}" data-workload="${workload}" data-style="${cell.styleMode}" data-renderer="${cell.renderer}">${markup}</div>
    <script type="module" src="/${entryFile}"></script>
  </body>
</html>`;
}

async function startProductionServer(cell, outputs, render) {
  const manifest = JSON.parse(
    await readFile(join(outputs.clientOutDir, ".vite", "manifest.json"), "utf8"),
  );
  const entry = Object.values(manifest).find((item) => item.isEntry);
  assert(entry?.file, `Vite did not emit a client entry for ${cell.id}`);
  const cssFiles = [...new Set(entry.css ?? [])];
  const markupByWorkload = Object.fromEntries(
    workloadNames.map((workload) => [workload, render(workload)]),
  );

  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/favicon.ico") {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (url.pathname === "/ferriki-code.css") {
        response.statusCode = 200;
        response.setHeader("content-type", "text/css; charset=utf-8");
        response.end(render.codeElementCss ?? "");
        return;
      }
      if (url.pathname.startsWith("/assets/") || url.pathname.endsWith(".css")) {
        const assetPath = resolve(outputs.clientOutDir, `.${url.pathname}`);
        const relativePath = relative(outputs.clientOutDir, assetPath);
        assert(!relativePath.startsWith(".."), "asset request escaped production output");
        response.statusCode = 200;
        response.setHeader(
          "content-type",
          extname(assetPath) === ".css"
            ? "text/css; charset=utf-8"
            : "text/javascript; charset=utf-8",
        );
        response.end(await readFile(assetPath));
        return;
      }
      if (url.pathname !== "/") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const mode = url.searchParams.get("mode") ?? "hydrate";
      const workload = url.searchParams.get("workload") ?? "one-large";
      assert(["hydrate", "mount"].includes(mode), `unknown browser mode ${mode}`);
      assert(workloadNames.includes(workload), `unknown workload ${workload}`);
      const markup = mode === "hydrate" ? markupByWorkload[workload] : "";
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(createIndexHtml(cell, mode, workload, markup, entry.file, cssFiles));
    } catch (error) {
      response.statusCode = 500;
      response.end(error?.stack ?? String(error));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    markupByWorkload,
    close: () =>
      new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
  };
}

function browserSnapshotScript() {
  return `() => {
    const sections = [...document.querySelectorAll("[data-bench-block]")];
    return sections.map((section) => {
      const host = section.querySelector("[data-code-host]");
      const tree = host?.shadowRoot ?? host;
      const pre = tree?.querySelector("pre");
      const code = pre?.querySelector("code");
      const token = code?.querySelector("span");
      const line = tree?.querySelector('.ferriki-highlight-line[data-ln="1"]');
      const selected = tree?.querySelector('.ferriki-highlight-line[data-ln="2"]');
      const styleTags = tree ? [...tree.querySelectorAll("style")] : [];
      const sharedStyleTags = [...document.querySelectorAll("style[data-bench-shared-code-css]")];
      return {
        sourceKey: section.dataset.benchSource,
        text: pre?.textContent ?? "",
        hostPresent: Boolean(host),
        codeRef: host?.getAttribute("code-ref") ?? null,
        isShadowRoot: Boolean(host?.shadowRoot),
        adoptedSheetCount: host?.shadowRoot?.adoptedStyleSheets.length ?? 0,
        sharedSheetIdentity: host?.shadowRoot ? host.shadowRoot.adoptedStyleSheets[0] === sections[0].querySelector("[data-code-host]")?.shadowRoot?.adoptedStyleSheets[0] : false,
        fallbackText: host?.querySelector("pre code")?.textContent ?? "",
        fallbackSpanCount: host?.querySelectorAll("pre code span").length ?? 0,
        styleTagCount: styleTags.length,
        embeddedStyleBytes: styleTags.reduce((sum, style) => sum + new TextEncoder().encode(style.textContent ?? "").length, 0),
        markedCodeStylesheetLinkCount: tree?.querySelectorAll("link[data-ferriki-code-css]").length ?? 0,
        markedCodeStylesheetUrls: [...(tree?.querySelectorAll("link[data-ferriki-code-css]") ?? [])].map((link) => link.getAttribute("href")),
        sharedStyleTagCount: sharedStyleTags.length,
        sharedStyleBytes: sharedStyleTags.reduce((sum, style) => sum + new TextEncoder().encode(style.textContent ?? "").length, 0),
        elementCount: tree ? tree.querySelectorAll("*").length : 0,
        spanCount: tree?.querySelectorAll("span").length ?? 0,
        preDisplay: pre ? getComputedStyle(pre).display : "",
        preColor: pre ? getComputedStyle(pre).color : "",
        preBackground: pre ? getComputedStyle(pre).backgroundColor : "",
        tokenColor: token ? getComputedStyle(token).color : "",
        tokenFontStyle: token ? getComputedStyle(token).fontStyle : "",
        tokenFontWeight: token ? getComputedStyle(token).fontWeight : "",
        tokenTextDecoration: token ? getComputedStyle(token).textDecoration : "",
        lineCount: tree?.querySelectorAll(".ferriki-highlight-line[data-ln]").length ?? 0,
        firstLineNumber: line ? getComputedStyle(line, "::before").content : "",
        selectedLine: selected?.classList.contains("highlighted") ?? false,
        hostClass: host?.getAttribute("class") ?? "",
      };
    });
  }`;
}

function attachBrowserDiagnostics(page, cell, workload, warnings) {
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error")
      warnings.push(`${cell.id}/${workload}: ${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) =>
    warnings.push(`${cell.id}/${workload}: pageerror: ${error.message}`),
  );
  page.on("requestfailed", (request) =>
    warnings.push(
      `${cell.id}/${workload}: requestfailed: ${request.url()} (${request.failure()?.errorText})`,
    ),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      warnings.push(`${cell.id}/${workload}: HTTP ${response.status()}: ${response.url()}`);
  });
}

async function waitForPhase(page, phase) {
  await page.waitForFunction(
    (name) => Number.isFinite(window.__shadowResults?.[name]?.raf2),
    phase,
    { timeout: 20_000 },
  );
  return page.evaluate((name) => window.__shadowResults[name], phase);
}

function phaseTiming(result) {
  return {
    presentationSetupMs: result.presentationSetupMs ?? 0,
    commitMs: result.commit - result.start,
    commitToSecondRafMs: result.raf2 - result.commit,
    identity: result.identity,
  };
}

async function runBrowserPage(browser, cell, workload, mode, production, warnings, verify) {
  const page = await browser.newPage();
  attachBrowserDiagnostics(page, cell, workload, warnings);
  try {
    await page.goto(`${production.baseUrl}/?mode=${mode}&workload=${workload}`, {
      waitUntil: "load",
    });
    const initialPhase = mode === "hydrate" ? "hydrate" : "client-mount";
    const initialResult = await waitForPhase(page, initialPhase);
    const sourceByKey = Object.fromEntries(
      Object.entries(snippets).map(([name, value]) => [name, value.text]),
    );
    const expected = workloadBlocks[workload].map((block) => sourceByKey[block.source]);
    const hasShadowRoot = ["shadow", "reference", "dsd"].includes(cell.renderer);
    const initialNodes = await page.evaluate(`(${browserSnapshotScript()})()`);
    assert.equal(
      initialNodes.length,
      expected.length,
      `${cell.id}/${workload} block count changed`,
    );
    for (let index = 0; index < expected.length; index++) {
      assert.equal(
        initialNodes[index].text,
        expected[index],
        `${cell.id}/${workload} block ${index} text mismatch`,
      );
      assert(initialNodes[index].hostPresent, `${cell.id}/${workload} host is missing`);
      assert.equal(
        initialNodes[index].isShadowRoot,
        hasShadowRoot,
        `${cell.id}/${workload} block ${index} has the wrong DOM root type`,
      );
      assert.equal(
        initialNodes[index].styleTagCount,
        0,
        `${cell.id}/${workload} block ${index} has the wrong local style count`,
      );
      assert.equal(
        initialNodes[index].sharedStyleTagCount,
        cell.renderer === "light" ? 1 : 0,
        `${cell.id}/${workload} has the wrong shared component style count`,
      );
      assert.equal(initialNodes[index].adoptedSheetCount, hasShadowRoot ? 1 : 0);
      assert.equal(initialNodes[index].markedCodeStylesheetLinkCount, 0);
      if (hasShadowRoot) {
        assert(initialNodes[index].sharedSheetIdentity, "code roots did not share one stylesheet");
        if (cell.renderer === "shadow") {
          assert.equal(initialNodes[index].fallbackText, expected[index]);
          assert.equal(initialNodes[index].fallbackSpanCount, 0);
        } else {
          assert.equal(initialNodes[index].fallbackText, "");
          assert.equal(initialNodes[index].fallbackSpanCount, 0);
        }
      }
      assert.equal(initialNodes[index].preDisplay, "block");
      assert(initialNodes[index].tokenColor, `${cell.id}/${workload} token style missing`);
      assert(initialNodes[index].tokenFontStyle, `${cell.id}/${workload} token font style missing`);
      assert(
        initialNodes[index].tokenFontWeight,
        `${cell.id}/${workload} token font weight missing`,
      );
      assert(
        initialNodes[index].tokenTextDecoration,
        `${cell.id}/${workload} token text decoration missing`,
      );
      assert(initialNodes[index].lineCount > 0, `${cell.id}/${workload} annotations missing`);
      assert(
        initialNodes[index].firstLineNumber.includes('"1"'),
        `${cell.id}/${workload} line-number CSS missing`,
      );
      assert(
        initialNodes[index].selectedLine,
        `${cell.id}/${workload} selected-line annotation missing`,
      );
    }
    const recoverableErrors = await page.evaluate(() => window.__shadowRecoverableErrors ?? []);
    assert.deepEqual(
      recoverableErrors,
      [],
      `${cell.id}/${workload} React render reported recoverable errors`,
    );

    let themeResult;
    let parentResult;
    let darkNodes;
    let parentNodes;
    if (verify || mode === "mount") {
      await page.locator('[data-action="theme"]').click();
      themeResult = await waitForPhase(page, "theme-update");
      darkNodes = await page.evaluate(`(${browserSnapshotScript()})()`);
      assert.deepEqual(
        darkNodes.map((node) => node.text),
        expected,
        `${cell.id}/${workload} text changed after theme update`,
      );
      assert.equal(await page.locator("main").getAttribute("data-bench-theme"), "dark");
      await page.locator('[data-action="rerender"]').click();
      parentResult = await waitForPhase(page, "parent-rerender");
      parentNodes = await page.evaluate(`(${browserSnapshotScript()})()`);
      assert.deepEqual(
        parentNodes.map((node) => node.text),
        expected,
        `${cell.id}/${workload} text changed after parent rerender`,
      );
      assert(parentNodes.every((item) => item.hostClass.includes("parent-1")));
      assert.deepEqual(await page.evaluate(() => window.__shadowRecoverableErrors ?? []), []);
    }

    if (verify) {
      const identityChecks = [
        initialResult,
        ...(themeResult ? [themeResult] : []),
        ...(parentResult ? [parentResult] : []),
      ].map((result) => result.identity);
      for (const identity of identityChecks) {
        assert(
          identity.sameCount &&
            identity.sameHosts &&
            identity.sameRoots &&
            identity.samePres &&
            identity.sameTokens,
          `${cell.id}/${workload}/${mode} changed code nodes: ${JSON.stringify(identity)}`,
        );
      }
      assert(darkNodes && parentNodes);
    }

    if (!verify) {
      return {
        initial: phaseTiming(initialResult),
        themeUpdate: themeResult ? phaseTiming(themeResult) : null,
        parentRerender: parentResult ? phaseTiming(parentResult) : null,
      };
    }
    return {
      initialNodes,
      darkNodes,
      parentNodes,
      identity: {
        afterInitial: initialResult.identity,
        afterTheme: themeResult?.identity ?? null,
        afterParent: parentResult?.identity ?? null,
      },
      initialTiming: phaseTiming(initialResult),
      themeTiming: themeResult ? phaseTiming(themeResult) : null,
      parentTiming: parentResult ? phaseTiming(parentResult) : null,
    };
  } finally {
    await page.close();
  }
}

async function validateNoJs(browser, cell, workload, production) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(`${production.baseUrl}/?mode=hydrate&workload=${workload}`, {
      waitUntil: "load",
    });
    const nodes = await page.evaluate(`(${browserSnapshotScript()})()`);
    const reservedGeometry = ["reference", "dsd"].includes(cell.renderer)
      ? await page.evaluate(() => ({
          rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
          hosts: [...document.querySelectorAll("[data-bench-block] [data-code-host]")].map(
            (host) => {
              const style = getComputedStyle(host);
              const rect = host.getBoundingClientRect();
              return {
                height: rect.height,
                minBlockSize: Number.parseFloat(style.minBlockSize),
                display: style.display,
                boxSizing: style.boxSizing,
                hasShadowRoot: Boolean(host.shadowRoot),
              };
            },
          ),
        }))
      : null;
    const expected = workloadBlocks[workload].map((block) =>
      cell.renderer === "reference" ? "" : snippets[block.source].text,
    );
    assert.equal(nodes.length, expected.length);
    const hasDeclarativeShadowRoot = cell.renderer === "dsd";
    for (let index = 0; index < nodes.length; index++) {
      assert.equal(nodes[index].text, expected[index]);
      assert.equal(nodes[index].styleTagCount, 0);
      assert.equal(nodes[index].sharedStyleTagCount, cell.renderer === "light" ? 1 : 0);
      assert.equal(nodes[index].isShadowRoot, hasDeclarativeShadowRoot);
      assert.equal(nodes[index].adoptedSheetCount, 0);
      if (cell.renderer === "shadow") {
        assert.equal(nodes[index].spanCount, 0);
        assert.equal(
          nodes[index].fallbackText,
          snippets[workloadBlocks[workload][index].source].text,
        );
      }
      if (cell.renderer === "reference") assert.equal(nodes[index].spanCount, 0);
      if (cell.renderer === "dsd") {
        assert.equal(nodes[index].markedCodeStylesheetLinkCount, 1);
        assert.deepEqual(nodes[index].markedCodeStylesheetUrls, ["/ferriki-code.css"]);
        assert(
          nodes[index].spanCount > 0,
          "DSD did not include highlighted token spans without JavaScript",
        );
        assert(
          nodes[index].tokenColor,
          "DSD stylesheet did not style token text without JavaScript",
        );
      }
      if (reservedGeometry) {
        const source = snippets[workloadBlocks[workload][index].source].text;
        const lineCount = source.split(/\r\n|\r|\n/u).length;
        const expectedMinBlockSize = lineCount * reservedGeometry.rootFontSize * 1.3125;
        const geometry = reservedGeometry.hosts[index];
        assert.equal(geometry.display, "block");
        assert.equal(geometry.boxSizing, "content-box");
        assert.equal(geometry.hasShadowRoot, cell.renderer === "dsd");
        assert(
          Math.abs(geometry.minBlockSize - expectedMinBlockSize) < 1,
          `${cell.id}/${workload} ${index} reserved min-block-size for the wrong source line count`,
        );
        assert(
          geometry.height >= expectedMinBlockSize - 1,
          `${cell.id}/${workload} ${index} did not reserve height before JavaScript`,
        );
      }
    }
    return {
      workload,
      serverRenderedBlocks: nodes.length,
      declarativeShadowRoots: nodes.filter((node) => node.isShadowRoot).length,
      sourceTextExact: cell.renderer !== "reference",
      highlightedBeforeJavaScript: ["light", "dsd"].includes(cell.renderer),
      cssPresent: nodes.every(
        (node) =>
          node.styleTagCount === 0 &&
          node.sharedStyleTagCount === (cell.renderer === "light" ? 1 : 0) &&
          node.markedCodeStylesheetLinkCount === (cell.renderer === "dsd" ? 1 : 0),
      ),
      reservedGeometry,
    };
  } finally {
    await context.close();
  }
}

function comparableStyles(nodes) {
  return nodes.map(
    ({
      sourceKey,
      text,
      preDisplay,
      preColor,
      preBackground,
      tokenColor,
      tokenFontStyle,
      tokenFontWeight,
      tokenTextDecoration,
      lineCount,
      firstLineNumber,
      selectedLine,
    }) => ({
      sourceKey,
      text,
      preDisplay,
      preColor,
      preBackground,
      tokenColor,
      tokenFontStyle,
      tokenFontWeight,
      tokenTextDecoration,
      lineCount,
      firstLineNumber,
      selectedLine,
    }),
  );
}

async function validateCells(browser, productions) {
  const validation = [];
  const warnings = [];
  for (const workload of workloadNames) {
    for (const cell of cells) {
      const production = productions.get(cell.id);
      const noJs = await validateNoJs(browser, cell, workload, production);
      const browserEvidence = await runBrowserPage(
        browser,
        cell,
        workload,
        "hydrate",
        production,
        warnings,
        true,
      );
      const clientMountEvidence = await runBrowserPage(
        browser,
        cell,
        workload,
        "mount",
        production,
        warnings,
        true,
      );
      validation.push({
        cell: cell.id,
        styleMode: cell.styleMode,
        renderer: cell.renderer,
        workload,
        noJs,
        ...browserEvidence,
        clientMount: clientMountEvidence,
      });
    }
  }
  assert.deepEqual(
    warnings,
    [],
    "correctness pages logged browser warnings/errors or request failures",
  );
  for (const styleMode of styleModes) {
    for (const workload of workloadNames) {
      const reference = validation.find(
        (item) =>
          item.styleMode === styleMode &&
          item.renderer === "reference" &&
          item.workload === workload,
      );
      const dsd = validation.find(
        (item) =>
          item.styleMode === styleMode && item.renderer === "dsd" && item.workload === workload,
      );
      assert(reference?.noJs.reservedGeometry);
      assert(dsd?.noJs.reservedGeometry);
      assert.equal(
        reference.noJs.reservedGeometry.hosts.length,
        dsd.noJs.reservedGeometry.hosts.length,
      );
      for (let index = 0; index < reference.noJs.reservedGeometry.hosts.length; index++) {
        const referenceHost = reference.noJs.reservedGeometry.hosts[index];
        const dsdHost = dsd.noJs.reservedGeometry.hosts[index];
        assert(
          Math.abs(referenceHost.minBlockSize - dsdHost.minBlockSize) < 1 &&
            Math.abs(referenceHost.height - dsdHost.height) < 1,
          `${styleMode}/${workload} reference and DSD no-JS host geometry diverged`,
        );
      }

      const light = validation.find(
        (item) =>
          item.styleMode === styleMode && item.renderer === "light" && item.workload === workload,
      );
      assert(light);
      for (const renderer of renderers.slice(1)) {
        const candidate = validation.find(
          (item) =>
            item.styleMode === styleMode &&
            item.renderer === renderer &&
            item.workload === workload,
        );
        assert(candidate);
        assert.deepEqual(
          comparableStyles(light.initialNodes),
          comparableStyles(candidate.initialNodes),
          `${styleMode}/${workload} light and ${renderer} computed styles differ`,
        );
        assert.deepEqual(
          comparableStyles(light.darkNodes),
          comparableStyles(candidate.darkNodes),
          `${styleMode}/${workload} dark light and ${renderer} computed styles differ`,
        );
        assert.deepEqual(
          comparableStyles(light.clientMount.initialNodes),
          comparableStyles(candidate.clientMount.initialNodes),
          `${styleMode}/${workload} client-mount light and ${renderer} computed styles differ`,
        );
        assert.deepEqual(
          comparableStyles(light.clientMount.darkNodes),
          comparableStyles(candidate.clientMount.darkNodes),
          `${styleMode}/${workload} client-mount dark light and ${renderer} computed styles differ`,
        );
      }
    }
  }
  return { cells: validation, browserWarnings: warnings, passed: true };
}

async function validateProfileCells(browser, productions) {
  const validation = [];
  const warnings = [];
  for (const cell of profileCells) {
    const production = productions.get(cell.id);
    const noJs = await validateNoJs(browser, cell, profileWorkload, production);
    const hydration = await runBrowserPage(
      browser,
      cell,
      profileWorkload,
      "hydrate",
      production,
      warnings,
      true,
    );
    const clientMount = await runBrowserPage(
      browser,
      cell,
      profileWorkload,
      "mount",
      production,
      warnings,
      true,
    );
    validation.push({ cell: cell.id, renderer: cell.renderer, noJs, hydration, clientMount });
  }
  const light = validation.find((item) => item.renderer === "light");
  assert(light);
  for (const renderer of ["reference", "dsd"]) {
    const candidate = validation.find((item) => item.renderer === renderer);
    assert(candidate);
    for (const mode of ["hydration", "clientMount"]) {
      assert.deepEqual(
        comparableStyles(light[mode].initialNodes),
        comparableStyles(candidate[mode].initialNodes),
        `inline/${profileWorkload} light and ${renderer} ${mode} styles differ`,
      );
      assert.deepEqual(
        comparableStyles(light[mode].darkNodes),
        comparableStyles(candidate[mode].darkNodes),
        `inline/${profileWorkload} light and ${renderer} dark ${mode} styles differ`,
      );
    }
  }
  assert.deepEqual(warnings, [], "profile validation pages logged browser warnings/errors");
  return { cells: validation, browserWarnings: warnings, passed: true };
}

async function benchmarkBrowser(browser, productions, report) {
  for (const styleMode of styleModes) {
    for (const workload of workloadNames) {
      for (let iteration = 0; iteration < settings.warmup + settings.samples; iteration++) {
        const renderOrder = iteration % 2 === 0 ? renderers : [...renderers].reverse();
        for (const renderer of renderOrder) {
          const cell = cells.find(
            (item) => item.styleMode === styleMode && item.renderer === renderer,
          );
          const production = productions.get(cell.id);
          const warnings = report.measurements.browserWarnings;
          for (const mode of ["hydrate", "mount"]) {
            const result = await runBrowserPage(
              browser,
              cell,
              workload,
              mode,
              production,
              warnings,
              false,
            );
            for (const phase of mode === "hydrate"
              ? ["initial"]
              : ["initial", "themeUpdate", "parentRerender"]) {
              const item = result[phase];
              report.measurements.browser.push({
                cell: cell.id,
                styleMode,
                renderer,
                workload,
                phase:
                  phase === "initial" ? (mode === "hydrate" ? "hydration" : "clientMount") : phase,
                iteration,
                samplePhase: iteration < settings.warmup ? "warmup" : "sample",
                presentationSetupMs: phase === "initial" ? item.presentationSetupMs : 0,
                commitMs: item.commitMs,
                commitToSecondRafMs: item.commitToSecondRafMs,
                identity: item.identity,
              });
            }
          }
        }
      }
    }
  }
  assert.deepEqual(
    report.measurements.browserWarnings,
    [],
    "timed browser pages logged warnings/errors",
  );
}

function summarizeCpuProfile(profile) {
  const frameById = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
  const weightById = new Map();
  const countById = new Map();
  let sampleDurationMicros = 0;
  for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
    const nodeId = profile.samples[index];
    const weight = profile.timeDeltas?.[index] ?? 0;
    sampleDurationMicros += weight;
    weightById.set(nodeId, (weightById.get(nodeId) ?? 0) + weight);
    countById.set(nodeId, (countById.get(nodeId) ?? 0) + 1);
  }
  const topFrames = [...weightById.entries()]
    .map(([nodeId, durationMicros]) => ({
      frame: frameById.get(nodeId) ?? null,
      durationMicros,
      sampleCount: countById.get(nodeId) ?? 0,
    }))
    .sort((left, right) => right.durationMicros - left.durationMicros)
    .slice(0, 40);
  return {
    intervalMicros: sampleDurationMicros,
    sampleCount: profile.samples?.length ?? 0,
    nodeCount: profile.nodes.length,
    topFrames,
  };
}

function profileIntervals(marks) {
  const times = Object.fromEntries(marks.map((mark) => [mark.name, mark.startTime]));
  const delta = (start, end) =>
    Number.isFinite(times[start]) && Number.isFinite(times[end]) ? times[end] - times[start] : null;
  return {
    registrySetupMs: delta("ferriki:setup:start", "ferriki:setup:end"),
    setupEndToHydrateStartMs: delta("ferriki:setup:end", "ferriki:profile:hydrateRoot:start"),
    preHydrateFlushMs: delta(
      "ferriki:profile:pre-hydrate-flush:start",
      "ferriki:profile:pre-hydrate-flush:end",
    ),
    twoRafWaitMs: delta("ferriki:profile:two-raf:start", "ferriki:profile:two-raf:end"),
    hydrateRootCallMs: delta(
      "ferriki:profile:hydrateRoot:start",
      "ferriki:profile:hydrateRoot:return",
    ),
    hydrateStartToCommitMs: delta(
      "ferriki:profile:hydrateRoot:start",
      "ferriki:profile:app-commit",
    ),
    hydrateReturnToCommitMs: delta(
      "ferriki:profile:hydrateRoot:return",
      "ferriki:profile:app-commit",
    ),
    moduleEntryToCommitMs: delta("ferriki:profile:module-entry", "ferriki:profile:app-commit"),
    setupToCommitMs: delta("ferriki:setup:start", "ferriki:profile:app-commit"),
    flushSyncCallMs: delta("ferriki:profile:flushSync:start", "ferriki:profile:flushSync:return"),
    createRootCallMs: delta(
      "ferriki:profile:createRoot:start",
      "ferriki:profile:createRoot:return",
    ),
    commitToRaf1Ms: delta("ferriki:profile:app-commit", "ferriki:profile:post-commit:raf1"),
    commitToRaf2Ms: delta("ferriki:profile:app-commit", "ferriki:profile:post-commit:raf2"),
  };
}

async function runProfilePage(browser, cell, mode, control, production, warnings, trace = false) {
  const page = await browser.newPage();
  attachBrowserDiagnostics(page, cell, profileWorkload, warnings);
  let cdp;
  const traceEvents = [];
  let traceComplete;
  let resolveTraceComplete;
  let traceTimeout;
  if (trace) {
    cdp = await page.context().newCDPSession(page);
    traceComplete = new Promise((resolveTrace) => {
      resolveTraceComplete = resolveTrace;
    });
    cdp.on("Tracing.dataCollected", (event) => traceEvents.push(...event.value));
    cdp.on("Tracing.tracingComplete", (event) => resolveTraceComplete(event));
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
    await cdp.send("Profiler.start");
    await cdp.send("Tracing.start", {
      categories:
        "devtools.timeline,blink.user_timing,toplevel,v8,disabled-by-default-devtools.timeline",
      options: "record-until-full",
      transferMode: "ReportEvents",
    });
  }
  try {
    await page.goto(
      `${production.baseUrl}/?mode=${mode}&workload=${profileWorkload}&profile=${control}`,
      { waitUntil: "load" },
    );
    const phase = mode === "hydrate" ? "hydrate" : "client-mount";
    const result = await waitForPhase(page, phase);
    const recoverableErrors = await page.evaluate(() => window.__shadowRecoverableErrors ?? []);
    const codeNodeCount = await page.evaluate(() => window.__shadowCaptureNodes().length);
    assert.deepEqual(recoverableErrors, [], `${cell.id}/${control} produced hydration errors`);
    assert.equal(codeNodeCount, workloadBlocks[profileWorkload].length);
    assert(
      result.identity?.sameCount &&
        result.identity.sameHosts &&
        result.identity.sameRoots &&
        result.identity.samePres &&
        result.identity.sameTokens,
      `${cell.id}/${control} changed code nodes: ${JSON.stringify(result.identity)}`,
    );
    const pageProfile = await page.evaluate(() => ({
      control: window.__ferrikiProfile?.control ?? null,
      timeOrigin: performance.timeOrigin,
      marks: performance
        .getEntriesByType("mark")
        .filter((entry) => entry.name.startsWith("ferriki:"))
        .map(({ name, startTime, duration, detail }) => ({ name, startTime, duration, detail })),
    }));
    assert.equal(pageProfile.control, control, `${cell.id} did not activate profile ${control}`);
    const profile = {
      cell: cell.id,
      renderer: cell.renderer,
      styleMode: cell.styleMode,
      workload: profileWorkload,
      mode,
      control,
      baseline: phaseTiming(result),
      profileScope: trace ? "navigation-through-post-commit" : null,
      timeOrigin: pageProfile.timeOrigin,
      marks: pageProfile.marks,
      intervals: profileIntervals(pageProfile.marks),
    };
    if (!trace) return { profile, trace: null };

    const cpuProfileResponse = await cdp.send("Profiler.stop");
    await cdp.send("Tracing.end");
    const traceCompletion = await Promise.race([
      traceComplete,
      new Promise(
        (_, reject) =>
          (traceTimeout = setTimeout(
            () => reject(new Error("Timed out waiting for Chrome trace completion")),
            30_000,
          )),
      ),
    ]);
    assert(traceCompletion, "Chrome tracing ended without a completion event");
    const traceResult = {
      events: traceEvents,
      completion: traceCompletion,
      cpuProfile: summarizeCpuProfile(cpuProfileResponse.profile),
    };
    return { profile, trace: traceResult };
  } finally {
    clearTimeout(traceTimeout);
    if (cdp) await cdp.detach();
    await page.close();
  }
}

function profileConditionId(condition) {
  return `inline-${condition.cell?.renderer ?? condition.renderer}-${condition.mode}-${condition.control}`;
}

async function benchmarkProfile(browser, productions, report, outputPath) {
  const conditions = [
    ...profileCells.map((cell) => ({ cell, mode: "hydrate", control: "immediate" })),
    {
      cell: profileCells.find((item) => item.renderer === "reference"),
      mode: "hydrate",
      control: "preflush",
    },
    {
      cell: profileCells.find((item) => item.renderer === "reference"),
      mode: "hydrate",
      control: "two-raf",
    },
    {
      cell: profileCells.find((item) => item.renderer === "reference"),
      mode: "hydrate",
      control: "flushsync",
    },
    ...profileCells.map((cell) => ({ cell, mode: "mount", control: "immediate" })),
  ];
  const rows = [];
  for (
    let iteration = 0;
    iteration < settings.profileWarmup + settings.profileSamples;
    iteration++
  ) {
    const rotation = iteration % conditions.length;
    const order = [...conditions.slice(rotation), ...conditions.slice(0, rotation)];
    for (const condition of order) {
      const cell = condition.cell;
      const warnings = report.measurements.browserWarnings;
      const measured = await runProfilePage(
        browser,
        cell,
        condition.mode,
        condition.control,
        productions.get(cell.id),
        warnings,
      );
      rows.push({
        ...measured.profile,
        condition: profileConditionId(condition),
        iteration,
        samplePhase: iteration < settings.profileWarmup ? "warmup" : "sample",
      });
    }
  }
  const traceDirectory = `${outputPath.replace(/\.[^.]+$/u, "")}-traces`;
  await mkdir(traceDirectory, { recursive: true });
  const traceConditions = [
    {
      cell: profileCells.find((item) => item.renderer === "reference"),
      mode: "hydrate",
      control: "immediate",
    },
    {
      cell: profileCells.find((item) => item.renderer === "reference"),
      mode: "hydrate",
      control: "preflush",
    },
    {
      cell: profileCells.find((item) => item.renderer === "reference"),
      mode: "hydrate",
      control: "flushsync",
    },
    {
      cell: profileCells.find((item) => item.renderer === "light"),
      mode: "hydrate",
      control: "immediate",
    },
  ];
  const traces = [];
  for (const condition of traceConditions) {
    const result = await runProfilePage(
      browser,
      condition.cell,
      condition.mode,
      condition.control,
      productions.get(condition.cell.id),
      report.measurements.browserWarnings,
      true,
    );
    const traceData = {
      traceEvents: result.trace.events,
      displayTimeUnit: "ms",
      metadata: {
        renderer: condition.cell.renderer,
        styleMode: condition.cell.styleMode,
        workload: profileWorkload,
        mode: condition.mode,
        control: condition.control,
        cpuProfileScope: result.profile.profileScope,
        browser: report.provenance.environment.browser,
        timeOrigin: result.profile.timeOrigin,
      },
    };
    const tracePath = join(
      traceDirectory,
      `${condition.cell.renderer}-${condition.control}.trace.json.gz`,
    );
    const traceBytes = Buffer.from(JSON.stringify(traceData));
    const compressedTrace = gzipSync(traceBytes, { level: 9, mtime: 0 });
    await writeFile(tracePath, compressedTrace);
    traces.push({
      condition: profileConditionId(condition),
      path: relative(repoRoot, tracePath),
      sha256: hash(compressedTrace),
      compressedBytes: compressedTrace.byteLength,
      uncompressedBytes: traceBytes.byteLength,
      eventCount: traceData.traceEvents.length,
      categories: [
        ...new Set(traceData.traceEvents.map((event) => event.cat).filter(Boolean)),
      ].sort(),
      cpuProfile: result.trace.cpuProfile,
      cpuProfileScope: result.profile.profileScope,
      marks: result.profile.marks,
      intervals: result.profile.intervals,
    });
  }
  assert.deepEqual(
    report.measurements.browserWarnings,
    [],
    "profile pages logged browser warnings/errors",
  );
  report.measurements.profile = {
    controls: conditions.map(({ cell, mode, control }) => ({
      condition: profileConditionId({ cell, mode, control }),
      renderer: cell.renderer,
      mode,
      control,
    })),
    warmupCount: settings.profileWarmup,
    sampleCount: settings.profileSamples,
    samples: rows,
    diagnosticTraces: traces,
    traceDirectory: relative(repoRoot, traceDirectory),
  };
}

function assertSampleCounts(report) {
  const browserPhases = ["hydration", "clientMount", "themeUpdate", "parentRerender"];
  for (const cell of cells) {
    for (const workload of workloadNames) {
      const ssrRows = report.measurements.ssr.filter(
        (row) => row.cell === cell.id && row.workload === workload,
      );
      assert.equal(
        ssrRows.filter((row) => row.phase === "sample").length,
        settings.samples,
        `expected ${settings.samples} timed SSR samples for ${cell.id}/${workload}`,
      );
      assert.equal(
        ssrRows.filter((row) => row.phase === "warmup").length,
        settings.warmup,
        `expected ${settings.warmup} SSR warmups for ${cell.id}/${workload}`,
      );
      for (const phase of browserPhases) {
        const browserRows = report.measurements.browser.filter(
          (row) => row.cell === cell.id && row.workload === workload && row.phase === phase,
        );
        assert.equal(
          browserRows.filter((row) => row.samplePhase === "sample").length,
          settings.samples,
          `expected ${settings.samples} timed ${phase} samples for ${cell.id}/${workload}`,
        );
        assert.equal(
          browserRows.filter((row) => row.samplePhase === "warmup").length,
          settings.warmup,
          `expected ${settings.warmup} ${phase} warmups for ${cell.id}/${workload}`,
        );
      }
    }
  }
}

function summarizeReport(report) {
  const ssrSampleRows = (rows) => rows.filter((row) => row.phase === "sample");
  const browserSampleRows = (rows) => rows.filter((row) => row.samplePhase === "sample");
  const cellsSummary = cells.map((cell) => {
    const builds = report.measurements.builds.filter((row) => row.cell === cell.id);
    const client = builds.find((row) => row.target === "client");
    const server = builds.find((row) => row.target === "server");
    const ssrByWorkload = Object.fromEntries(
      workloadNames.map((workload) => {
        const values = ssrSampleRows(report.measurements.ssr).filter(
          (row) => row.cell === cell.id && row.workload === workload,
        );
        return [
          workload,
          {
            renderMs: summarize(values.map((row) => row.durationMs)),
            htmlBytes: summarize(values.map((row) => row.html.raw)),
            htmlGzipBytes: summarize(values.map((row) => row.html.gzip)),
            htmlBrotliBytes: summarize(values.map((row) => row.html.brotli)),
            inlineCssBytes: summarize(values.map((row) => row.embeddedCssText.raw)),
            inlineCssGzipBytes: summarize(values.map((row) => row.embeddedCssText.gzip)),
            sharedCssBytes: summarize(values.map((row) => row.sharedCssText.raw)),
            shadowLocalCssBytes: summarize(values.map((row) => row.shadowLocalCssText.raw)),
            externalCodeStylesheetBytes: summarize(
              values.flatMap((row) =>
                row.externalCodeStylesheet ? [row.externalCodeStylesheet.raw] : [],
              ),
            ),
            externalCodeStylesheetGzipBytes: summarize(
              values.flatMap((row) =>
                row.externalCodeStylesheet ? [row.externalCodeStylesheet.gzip] : [],
              ),
            ),
            externalCodeStylesheetBrotliBytes: summarize(
              values.flatMap((row) =>
                row.externalCodeStylesheet ? [row.externalCodeStylesheet.brotli] : [],
              ),
            ),
            sharedStyleCount: summarize(values.map((row) => row.sharedStyleCount)),
            shadowLocalStyleCount: summarize(values.map((row) => row.shadowLocalStyleCount)),
            styleCount: summarize(values.map((row) => row.styleCount)),
          },
        ];
      }),
    );
    const browserByWorkload = Object.fromEntries(
      workloadNames.map((workload) => [
        workload,
        Object.fromEntries(
          ["hydration", "clientMount", "themeUpdate", "parentRerender"].map((phase) => {
            const values = browserSampleRows(report.measurements.browser).filter(
              (row) => row.cell === cell.id && row.workload === workload && row.phase === phase,
            );
            return [
              phase,
              {
                commitMs: summarize(values.map((row) => row.commitMs)),
                commitToSecondRafMs: summarize(values.map((row) => row.commitToSecondRafMs)),
                presentationSetupMs: summarize(values.map((row) => row.presentationSetupMs)),
              },
            ];
          }),
        ),
      ]),
    );
    const transforms = report.measurements.transforms.filter(
      (row) => row.cell === cell.id && row.target === "client",
    );
    return {
      cell: cell.id,
      styleMode: cell.styleMode,
      renderer: cell.renderer,
      clientBuildMs: client?.durationMs ?? null,
      serverBuildMs: server?.durationMs ?? null,
      assets: client?.assets ?? null,
      transformMs: summarize(transforms.map((row) => row.durationMs)),
      ssrByWorkload,
      browserByWorkload,
    };
  });
  return { cells: cellsSummary };
}

function summarizeProfile(report) {
  const profile = report.measurements.profile;
  const conditions = profile.controls.map((condition) => {
    const rows = profile.samples.filter(
      (row) => row.condition === condition.condition && row.samplePhase === "sample",
    );
    const intervalNames = Object.keys(rows[0]?.intervals ?? {});
    return {
      ...condition,
      sampleCount: rows.length,
      baselineCommitMs: summarize(rows.map((row) => row.baseline.commitMs)),
      presentationSetupMs: summarize(rows.map((row) => row.baseline.presentationSetupMs)),
      intervals: Object.fromEntries(
        intervalNames.map((name) => [
          name,
          summarize(
            rows.map((row) => row.intervals[name]).filter((value) => Number.isFinite(value)),
          ),
        ]),
      ),
    };
  });
  return { controls: conditions, diagnosticTraces: profile.diagnosticTraces };
}

async function main() {
  process.env.NODE_ENV = "production";
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  assert(
    nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13),
    "Node 22.13 or newer is required",
  );
  await stat(join(nodeRoot, "node_modules", "vite", "package.json"));
  await stat(join(depsNodeModules, "react", "package.json"));
  await stat(join(depsNodeModules, "react-dom", "package.json"));
  await stat(join(depsNodeModules, "playwright", "package.json"));
  const native = await resolveNativeBuild();
  const componentSource = await readFile(componentPath, "utf8");
  snippets = {};
  for (const [name, file] of Object.entries(fixtureFiles)) {
    const path = join(fixtureRoot, file);
    const text = await readFile(path, "utf8");
    snippets[name] = {
      path,
      file,
      text,
      sha256: hash(text),
      bytes: Buffer.byteLength(text),
      lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
    };
  }
  const fixtureVersions = {
    react: await readPackageVersion("react", depsRoot),
    reactDom: await readPackageVersion("react-dom", depsRoot),
    scheduler: await readPackageVersion("scheduler", depsRoot),
    playwright: await readPackageVersion("playwright", depsRoot),
    vite: await readPackageVersion("vite", nodeRoot),
  };
  assert.equal(fixtureVersions.react.version, "19.3.0");
  assert.equal(fixtureVersions.reactDom.version, "19.3.0");
  assert.equal(fixtureVersions.scheduler.version, "0.28.0");
  assert.equal(fixtureVersions.playwright.version, "1.63.0");
  assert.equal(fixtureVersions.vite.version, "8.3.2");

  await mkdir(projectRoot, { recursive: true });
  await mkdir(benchmarkRoot, { recursive: true });
  const sourceHashes = {};
  for (const path of [
    join(nodeRoot, "vite", "index.mjs"),
    join(nodeRoot, "vite", "macro-scan.mjs"),
    join(nodeRoot, "ferriki", "src", "index.mjs"),
    join(nodeRoot, "ferriki", "classes.mjs"),
    join(nodeRoot, "ferriki", "transformers.mjs"),
    browserRuntimePath,
    serverRuntimePath,
    componentPath,
    referenceComponentPath,
    join(fixtureRoot, fixtureFiles.medium),
    join(fixtureRoot, fixtureFiles.large),
    scriptPath,
  ])
    sourceHashes[relative(repoRoot, path)] = await hashFile(path);

  const outputPath =
    settings.write ??
    join(
      tmpdir(),
      `${settings.profile ? "ferriki-shadow-dom-profile" : "ferriki-shadow-dom-spike"}-${Date.now()}.json`,
    );
  const report = {
    schemaVersion: 1,
    benchmark: settings.profile
      ? "shadow-dom-inline-hydration-profile"
      : "shadow-dom-prepared-code-spike",
    question: settings.profile
      ? "Which setup, hydrateRoot, scheduled React, and browser rendering intervals contribute to the historical inline twelve-mixed reference hydration wall time?"
      : "How do prepared Ferriki code blocks compare across light DOM, property-initialized Shadow DOM, reference-backed hosts, and Declarative Shadow DOM for SSR bytes/time, hydration, client-only mount/update commits, and CSS/JS payload?",
    measuredAt: new Date().toISOString(),
    method: {
      build:
        "Production Vite client and SSR builds; each cell uses the same code() prepared descriptors and styleMode. Reference and DSD lanes are thin React adapters that pass short reference IDs; DSD uses the standalone server helper to postprocess those hosts. Browser setup times the direct public registry call, not the full generated-default React helper startup. Renderer order alternates by style/workload/sample.",
      workloads:
        "one-large is one large.tsx block; twelve-mixed is six medium.tsx and six large.tsx blocks alternating, with the same prepared descriptors reused in all four renderers.",
      cssOrder:
        "Light DOM emits one page-level stylesheet with :host scoped to [data-code-host]. The property, reference, and DSD lanes register one constructed stylesheet for their document; class-based descriptor CSS is included in that shared sheet. DSD starts with one marked external stylesheet URL per root and removes the per-root link when its block is registered.",
      ssrBoundary:
        "Warm renderToString call for light, property, and reference lanes. The DSD lane times renderToString plus renderCodeElementShadows postprocessing, including template and stylesheet-link injection. Source fixture loading, SSR module import, CSS response, output inspection, and network response are outside the timed interval.",
      browserCommitBoundary:
        "Hydration, createRoot client mount, theme update, and parent rerender start immediately before the triggering React call/event and stop at the App useLayoutEffect timestamp before DOM identity inspection. Custom-element registration and reference/block setup happen before hydration; their synchronous interval is recorded separately as presentationSetupMs. These are elapsed wall-clock intervals to the React commit boundary, not isolated React CPU measurements and not evidence that React walks or owns shadow-tree nodes. Page parsing and asset/module loading are outside these intervals.",
      nextFrameProxy:
        "The separately reported commit-to-second-requestAnimationFrame interval is a next-frame proxy only; it includes the following DOM identity inspection and frame scheduling and is not exact paint timing.",
      browserNetwork:
        "All browser checks use production Vite builds served locally; asset loading and page parsing happen before the measured phase starts.",
      profileProbe: settings.profile
        ? "Focused inline twelve-mixed probes use immediate hydration, a forced pre-hydration style/layout read, a two-requestAnimationFrame wait, flushSync-wrapped hydrateRoot, and createRoot client mounts. These diagnostic controls are separate from and do not change the default timed benchmark methodology. Untraced samples use performance marks; four separate diagnostic runs also collect Chrome timeline and V8 CPU profiles. Trace marks separate registration, React calls, and commit; V8 CPU samples span navigation through post-commit and are not phase-isolated."
        : null,
      cssPayload:
        "The light-DOM shared style tag is included in SSR HTML totals. The property lane transports highlighted HTML plus plain source fallback. The reference lane sends empty hosts and registers trusted blocks in JavaScript. DSD transports highlighted HTML in declarative roots with one marked URL per host; CSS declarations are available from one shared CSS asset URL without duplicate style tags in the roots. Raw, gzip, and Brotli sizes for that external CSS asset are recorded separately from SSR HTML. Shared constructed CSS is included in the browser registration payload.",
      noThreshold: true,
    },
    provenance: {
      repository: {
        commit: git("rev-parse", "HEAD"),
        branch: git("branch", "--show-current"),
        status: git("status", "--short", "--untracked-files=all"),
      },
      environment: {
        platform: platform(),
        osRelease: release(),
        arch: arch(),
        cpu: cpus()[0]?.model ?? null,
        cpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        loadAverageBefore: loadavg(),
        node: process.version,
        nodeEnv: process.env.NODE_ENV,
        v8: process.versions.v8,
        versions: fixtureVersions,
        browser: null,
      },
      native,
      sourceHashes,
      fixtures: Object.fromEntries(
        Object.entries(snippets).map(([name, snippet]) => [
          name,
          {
            path: relative(repoRoot, snippet.path),
            bytes: snippet.bytes,
            lines: snippet.lines,
            sha256: snippet.sha256,
          },
        ]),
      ),
      component: {
        path: relative(repoRoot, componentPath),
        sha256: hash(componentSource),
      },
      browserRuntime: {
        path: relative(repoRoot, browserRuntimePath),
        sha256: sourceHashes[relative(repoRoot, browserRuntimePath)],
      },
      serverRuntime: {
        path: relative(repoRoot, serverRuntimePath),
        sha256: sourceHashes[relative(repoRoot, serverRuntimePath)],
      },
      referenceComponent: {
        path: relative(repoRoot, referenceComponentPath),
        sha256: sourceHashes[relative(repoRoot, referenceComponentPath)],
      },
    },
    settings: {
      samples: settings.samples,
      warmup: settings.warmup,
      profile: settings.profile,
      profileSamples: settings.profile ? settings.profileSamples : null,
      profileWarmup: settings.profile ? settings.profileWarmup : null,
      validateOnly: settings.validateOnly,
      cells: (settings.profile ? profileCells : cells).map((cell) => ({ ...cell })),
      workloads: Object.fromEntries(
        (settings.profile ? [profileWorkload] : workloadNames).map((name) => [
          name,
          workloadBlocks[name].map((item) => item.source),
        ]),
      ),
      themes: { light: "github-light-default", dark: "github-dark-default" },
      lineNumbers: true,
      compression: {
        gzipLevel: 9,
        brotliQuality: 6,
        assetsCompressedPerFile: true,
      },
    },
    validation: { cells: [], browserWarnings: [], passed: false },
    measurements: {
      builds: [],
      transforms: [],
      ssr: [],
      browser: [],
      browserWarnings: [],
      profile: null,
    },
    summary: null,
  };

  const outputsByCell = new Map();
  const buildOrder = settings.profile ? [...profileCells] : [];
  if (!settings.profile) {
    for (const styleMode of styleModes) {
      for (const renderer of renderers) {
        const cell = cells.find(
          (item) => item.styleMode === styleMode && item.renderer === renderer,
        );
        buildOrder.push(cell);
      }
    }
  }
  if (!settings.profile && styleModes.length > 1) {
    for (let index = 1; index < buildOrder.length; index += 2) {
      const previous = buildOrder[index - 1];
      const current = buildOrder[index];
      if (previous.styleMode === current.styleMode)
        [buildOrder[index - 1], buildOrder[index]] = [current, previous];
    }
  }

  let browser;
  const productions = new Map();
  try {
    for (const cell of buildOrder) {
      const outputs = await buildCell(
        cell,
        report.measurements.builds,
        report.measurements.transforms,
      );
      outputsByCell.set(cell.id, outputs);
    }
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      throw new Error(
        "Chromium is not installed for Playwright 1.63.0. Run `playwright install chromium` using the pinned benchmark dependency prefix.",
        { cause: error },
      );
    }
    report.provenance.environment.browser = browser.version();
    const renderersByCell = new Map();
    for (const cell of buildOrder) {
      const outputs = outputsByCell.get(cell.id);
      const render = await loadServerRenderer(outputs, cell);
      renderersByCell.set(cell.id, render);
      productions.set(cell.id, await startProductionServer(cell, outputs, render));
    }

    report.validation = settings.profile
      ? await validateProfileCells(browser, productions)
      : await validateCells(browser, productions);
    assert(report.validation.passed, "Shadow DOM correctness validation failed");
    if (!settings.validateOnly) {
      if (settings.profile) {
        await benchmarkProfile(browser, productions, report, outputPath);
      } else {
        await benchmarkSsr(renderersByCell, report);
        await benchmarkBrowser(browser, productions, report);
        assertSampleCounts(report);
      }
    }
    report.provenance.environment.loadAverageAfter = loadavg();
    report.summary = settings.profile ? summarizeProfile(report) : summarizeReport(report);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Shadow DOM spike completed. Report: ${outputPath}`);
    if (settings.profile) {
      console.log(
        `Validated ${report.validation.cells.length} focused production cells; ${report.measurements.profile.samples.filter((row) => row.samplePhase === "sample").length} profile samples and ${report.measurements.profile.diagnosticTraces.length} diagnostic traces recorded.`,
      );
    } else {
      console.log(
        `Validated ${report.validation.cells.length} production cell/workload pairs; ${settings.validateOnly ? "timed samples skipped" : `${report.measurements.browser.filter((row) => row.samplePhase === "sample").length} browser phase samples recorded`}.`,
      );
    }
  } finally {
    if (browser) await browser.close();
    for (const production of productions.values()) await production.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
