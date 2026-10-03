import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { FERRIKI_PLATFORM_TARGETS, resolveFerrikiPlatformTarget } from "../ferriki/platforms.mjs";
import "./test-asset-env.mjs";

const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const coreRoot = join(nodeRoot, "ferriki");
const viteRoot = join(nodeRoot, "vite");
const platformId = process.env.FERRIKI_PLATFORM_ID ?? resolveFerrikiPlatformTarget()?.id;
assert(platformId, "FERRIKI_PLATFORM_ID is required on an unsupported native target");
const target = FERRIKI_PLATFORM_TARGETS.find((entry) => entry.id === platformId);
assert(target, `unknown Ferriki platform id ${platformId}`);
const sidecarRoot = join(nodeRoot, "platforms", platformId);
await stat(join(sidecarRoot, "ferriki.node")).catch(() => {
  throw new Error(`build the ${platformId} sidecar before running the packed Vite consumer check`);
});

const tempRoot = await mkdtemp(join(tmpdir(), "ferriki-vite-packed-consumer-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cacheDir = join(tempRoot, "npm-cache");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? nodeRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" && (command === "npm.cmd" || command === "pnpm.cmd"),
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
      npm_config_update_notifier: "false",
      ...options.env,
    },
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.error ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  return result;
}

function npmPack(directory) {
  const result = run(npm, ["pack", "--json", "--pack-destination", tempRoot], { cwd: directory });
  return JSON.parse(result.stdout)[0];
}

try {
  const vitePack = run(pnpm, ["pack", "--pack-destination", tempRoot], { cwd: viteRoot });
  const viteTarball = vitePack.stdout.trim().split("\n").at(-1);
  assert(
    viteTarball.endsWith(".tgz"),
    `pnpm pack did not return a Vite package tarball: ${vitePack.stdout}`,
  );
  const viteTarballPath = viteTarball.startsWith(tempRoot)
    ? viteTarball
    : join(tempRoot, viteTarball);
  const vitePackage = JSON.parse(await readFile(join(viteRoot, "package.json"), "utf8"));
  const corePack = npmPack(coreRoot);
  const sidecarPack = npmPack(sidecarRoot);
  const coreTarball = join(tempRoot, corePack.filename);
  const sidecarTarball = join(tempRoot, sidecarPack.filename);
  const tsc = join(nodeRoot, "node_modules", "typescript", "bin", "tsc");
  await stat(tsc);

  for (const viteVersion of ["7.3.1", "8.0.0"]) {
    const consumer = join(tempRoot, `consumer-vite-${viteVersion}`);
    const projectPath = join(consumer, "app");
    await mkdir(projectPath, { recursive: true });
    const project = await realpath(projectPath);
    const cacheWarm = join(tempRoot, `cache-warm-vite-${viteVersion}`);
    await mkdir(cacheWarm, { recursive: true });
    run(npm, ["init", "--yes"], { cwd: cacheWarm, stdio: "ignore" });
    run(
      npm,
      [
        "install",
        "--no-audit",
        "--no-fund",
        `vite@${viteVersion}`,
        "@types/node@25.3.3",
        "@babel/parser@7.29.9",
        "hast-util-from-html@2.0.3",
        "hast-util-to-html@9.0.5",
        "magic-string@0.30.21",
      ],
      { cwd: cacheWarm },
    );
    run(npm, ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
    run(
      npm,
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `vite@${viteVersion}`,
        "@types/node@25.3.3",
        coreTarball,
        sidecarTarball,
        viteTarballPath,
      ],
      { cwd: consumer, stdio: "ignore" },
    );

    const installedManifest = JSON.parse(
      await readFile(join(consumer, "node_modules", "@ferriki", "vite", "package.json"), "utf8"),
    );
    assert.equal(installedManifest.name, "@ferriki/vite");
    assert.equal(installedManifest.version, vitePackage.version);
    for (const required of [
      "README.md",
      "LICENSE-MIT",
      "LICENSE-APACHE",
      "index.mjs",
      "index.d.mts",
    ])
      await stat(join(consumer, "node_modules", "@ferriki", "vite", required));
    for (const [name, version] of Object.entries(installedManifest.dependencies))
      assert(
        !version.startsWith("catalog:"),
        `${name} retained an unpublished pnpm catalog specifier`,
      );

    await writeFile(
      join(project, "index.html"),
      '<!doctype html><html><head></head><body><pre data-highlight="auto" data-language="ts"><code>const htmlValue = 42;</code></pre><script type="module" src="/src/example.tsx"></script></body></html>',
    );
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "src", "example.tsx"),
      '"use client"; const block = <pre data-highlight="auto" data-language="ts" data-meta="{1}"><code>const jsxValue = 42;</code></pre>; console.log(block);',
    );

    const probe = join(consumer, "probe.mjs");
    await writeFile(
      probe,
      `
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build, createServer } from 'vite'
import { ferriki } from '@ferriki/vite'
import { ferrikiVersion } from '@ferriki/core'

const project = ${JSON.stringify(project)}
assert(ferrikiVersion(), 'packed Ferriki native binding did not load')
const options = { theme: 'github-dark-default', styleMode: 'classes', lineNumbers: true, assets: { remote: false }, transformers: [{ name: 'packed-vite-check', pre(node) { node.properties['data-packed-transformer'] = 'yes' } }] }
const jsxConfig = { jsx: 'transform', jsxFactory: 'Object.createElement' }
const plugin = ferriki(options)
const server = await createServer({ configFile: false, root: project, plugins: [plugin], esbuild: jsxConfig, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, fs: { allow: [project] } }, appType: 'custom' })
try {
  const html = await server.transformIndexHtml('/', await readFile(project + '/index.html', 'utf8'))
  const module = await server.transformRequest('/src/example.tsx')
  assert(html.includes('htmlValue') && html.includes('data-ferriki-vite') && html.includes('data-packed-transformer="yes"'), 'packed Vite HTML transform, callback, or stylesheet injection failed')
  assert(module?.code.includes('jsxValue') && module.code.includes('virtual:ferriki-vite/') && module.code.includes('data-packed-transformer'), 'packed Vite JSX transform, callback, or CSS import failed')
  assert(module.code.indexOf('"use client"') < module.code.indexOf('virtual:ferriki-vite/'), 'the JSX transform moved the directive prologue')
} finally {
  await server.close()
}
const output = await build({ configFile: false, root: project, plugins: [ferriki(options)], esbuild: jsxConfig, build: { write: false, minify: false } })
const outputs = Array.isArray(output) ? output.flatMap((item) => item.output) : output.output
const text = outputs.map((item) => ('source' in item ? String(item.source) : item.code)).join('\\n')
assert(text.includes('jsxValue') && text.includes('ferriki-highlight-line'), 'packed Vite production build omitted highlighted JSX or CSS')
`,
    );
    run(process.execPath, [probe], {
      cwd: consumer,
      stdio: "pipe",
      env: { FERRIKI_PLATFORM_ID: platformId },
    });
    const typeProbe = join(consumer, "packed-vite-types.mts");
    await writeFile(
      typeProbe,
      [
        "import { ferriki } from '@ferriki/vite'",
        "import type { ShikiTransformer } from '@ferriki/core'",
        "import type { Plugin } from 'vite'",
        "",
        "const transformer: ShikiTransformer = { line(node) { return node } }",
        "const plugin: Plugin = ferriki({",
        "  themes: { light: 'github-light-default', dark: 'github-dark-default' },",
        "  styleMode: 'classes',",
        "  include: id => id.endsWith('.mdx'),",
        "  transformers: [transformer],",
        "})",
        "void plugin",
        "",
      ].join("\n"),
    );
    run(
      process.execPath,
      [
        tsc,
        "--noEmit",
        "--strict",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2022",
        "--skipLibCheck",
        typeProbe,
      ],
      { cwd: consumer, stdio: "pipe" },
    );
    console.log(
      `Packed @ferriki/vite@${vitePackage.version} consumer passed with Vite ${viteVersion}`,
    );
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
