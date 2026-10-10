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

  // The peer range floor and the current Vite 8 release.
  for (const viteVersion of ["8.0.0", "8.3.2"]) {
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
        "hast-util-from-html@2.0.3",
        "magic-string@0.30.21",
        "@types/react@19.3.0",
        "react@19.3.0",
        "react-dom@19.3.0",
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
        "hast-util-from-html@2.0.3",
        "@types/react@19.3.0",
        "react@19.3.0",
        "react-dom@19.3.0",
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
      "macro-scan.mjs",
    ])
      await stat(join(consumer, "node_modules", "@ferriki", "vite", required));
    // Vite's own parser is the only JavaScript parser; no HTML tree library is shipped.
    assert.deepEqual(Object.keys(installedManifest.dependencies).sort(), [
      "@ferriki/core",
      "magic-string",
    ]);
    assert.deepEqual(installedManifest.peerDependencies, { vite: "^8.0.0" });
    for (const [name, version] of Object.entries(installedManifest.dependencies))
      assert(
        !version.startsWith("catalog:"),
        `${name} retained an unpublished pnpm catalog specifier`,
      );

    await writeFile(
      join(project, "index.html"),
      '<!doctype html><html><head></head><body><script type="module" src="/src/example.tsx"></script></body></html>',
    );
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "src", "example.tsx"),
      [
        '"use client";',
        "import { code } from '@ferriki/core/macro'",
        "import { plain } from './plain.ts'",
        "export const block = code('const packedValue = 42;', { language: 'ts', meta: '{1}' })",
        "console.log(block, plain)",
        "",
      ].join("\n"),
    );
    await writeFile(join(project, "src", "plain.ts"), "export const plain = 'no macro import';\n");
    await writeFile(
      join(project, "src", "macro-ssr.jsx"),
      [
        "import React from 'react'",
        "import { code as prepareCode } from '@ferriki/core/macro'",
        "import { Code } from '@ferriki/core/react/macro'",
        "",
        `export const block = prepareCode("const exact = '& <SSR>';\\nconsole.log(exact);", { language: 'ts', meta: 'title=\"SSR Fixture\" [packed] {2}', lineNumbers: true })`,
        "export let renderCalls = 0",
        "const runtimeTitle = 'Runtime custom title'",
        "const runtimeClassName = 'custom-packed-class'",
        "export function CodeExample() {",
        "  return React.createElement('section', { 'data-original': block.code }, React.createElement('div', { dangerouslySetInnerHTML: { __html: block.html } }))",
        "}",
        "function CustomCodeBlock({ code, className, title }) {",
        "  return <section data-react-code={code.code} data-render-class={className} data-runtime-title={title}><div className={className} dangerouslySetInnerHTML={{ __html: code.html }} /></section>",
        "}",
        "function renderCustomCode({ code, className }) {",
        "  renderCalls += 1",
        "  return <CustomCodeBlock code={code} className={className} title={runtimeTitle} />",
        "}",
        "const customMacroElement = <Code language='ts' source={`const packedCustom = 'react';\\nconsole.log(packedCustom);`} meta='title=\"Custom macro\"' lineNumbers className={runtimeClassName} render={renderCustomCode} />",
        "export function DefaultCodeMacroExample() {",
        "  return <Code language='ts' source={`const packedDefault = 'react';\\nconsole.log(packedDefault);`} meta='title=\"Default macro\"' lineNumbers className='default-packed-class' />",
        "}",
        "export function CustomCodeMacroExample() {",
        "  return <article data-packed-wrapper='custom'>{customMacroElement}</article>",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(project, "src", "invalid-spread.jsx"),
      [
        "import { Code } from '@ferriki/core/react/macro'",
        "const macroProps = { source: 'const invalid = true', language: 'ts' }",
        "export const invalidSpread = <Code {...macroProps} />",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(project, "src", "invalid-dynamic-meta.jsx"),
      [
        "import { Code } from '@ferriki/core/react/macro'",
        "const runtimeMeta = 'title=Dynamic'",
        "export const invalidMeta = <Code source='const invalid = true' language='ts' meta={runtimeMeta} />",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(project, "src", "invalid-dynamic-highlighting.jsx"),
      [
        "import { Code } from '@ferriki/core/react/macro'",
        "const runtimeLineNumbers = true",
        "export const invalidHighlighting = <Code source='const invalid = true' language='ts' lineNumbers={runtimeLineNumbers} />",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(project, "src", "invalid-children.jsx"),
      [
        "import { Code } from '@ferriki/core/react/macro'",
        "export const invalidChildren = <Code source='const invalid = true' language='ts'>child</Code>",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(project, "src", "invalid-reserved.jsx"),
      [
        "import { code } from '@ferriki/core/macro'",
        "export const render = ({ code }) => code.html",
        "",
      ].join("\n"),
    );

    const probe = join(consumer, "probe.mjs");
    await writeFile(
      probe,
      `
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build, createServer } from 'vite'
import { fromHtml } from 'hast-util-from-html'
import { ferriki } from '@ferriki/vite'
import { ferrikiVersion } from '@ferriki/core'

const project = ${JSON.stringify(project)}
assert(ferrikiVersion(), 'packed Ferriki native binding did not load')
const options = { theme: 'github-dark-default', styleMode: 'classes', lineNumbers: true, assets: { remote: false }, transformers: [{ name: 'packed-vite-check', preprocess(code) { this.options.decorations = [{ start: 0, end: Math.min(5, code.length), alwaysWrap: true, properties: { class: 'packed-decoration', 'data-native-decoration': 'yes' } }]; return code }, pre(node) { node.properties['data-packed-transformer'] = 'yes' } }] }
function hastText(node) { return node.type === 'text' ? node.value : (node.children ?? []).map(hastText).join('') }
function hastProperty(node, name) { if (node.type === 'element' && node.properties?.[name] !== undefined) return node.properties[name]; for (const child of node.children ?? []) { const value = hastProperty(child, name); if (value !== undefined) return value } }
const oxcConfig = { jsx: { runtime: 'automatic', development: false } }
const plugin = ferriki(options)
const server = await createServer({ configFile: false, root: project, plugins: [plugin], oxc: oxcConfig, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, fs: { allow: [project] } }, appType: 'custom' })
try {
  for (const [file, reason] of [
    ['/src/invalid-spread.jsx', 'the packed React macro accepted a JSX spread'],
    ['/src/invalid-dynamic-meta.jsx', 'the packed React macro accepted dynamic meta'],
    ['/src/invalid-dynamic-highlighting.jsx', 'the packed React macro accepted dynamic highlighting'],
    ['/src/invalid-children.jsx', 'the packed React macro accepted JSX children'],
    ['/src/invalid-reserved.jsx', 'the packed macro accepted a declaration that reuses its name'],
  ]) {
    await assert.rejects(server.transformRequest(file), (error) => error.code === 'FERRIKI_MACRO' && error.loc?.line > 0 && typeof error.frame === 'string', reason)
  }
  const module = await server.transformRequest('/src/example.tsx')
  const plain = await server.transformRequest('/src/plain.ts')
  assert(module?.code.includes('packedValue') && module.code.includes('virtual:ferriki-vite/') && module.code.includes('data-packed-transformer') && module.code.includes('data-native-decoration'), 'packed Vite macro transform, callback, or CSS import failed')
  assert(!module.code.includes('@ferriki/core/macro'), 'the packed macro import was not removed')
  assert(module.code.indexOf('"use client"') < module.code.indexOf('virtual:ferriki-vite/'), 'the macro transform moved the directive prologue')
  assert(plain?.code.includes('no macro import') && !plain.code.includes('virtual:ferriki-vite/'), 'a module without a macro import was changed')
  const ssrModule = await server.ssrLoadModule('/src/macro-ssr.jsx')
  const ssrMarkup = renderToStaticMarkup(React.createElement(ssrModule.CodeExample))
  assert.equal(ssrModule.block.code, "const exact = '& <SSR>';\\nconsole.log(exact);")
  assert.equal(ssrModule.block.language, 'ts')
  assert.deepEqual(ssrModule.block.metadata, { title: 'SSR Fixture', label: 'packed', lineNumbers: true, highlightedLines: [2] })
  assert(ssrMarkup.includes(ssrModule.block.html), 'React SSR did not preserve the macro HTML through dangerouslySetInnerHTML')
  assert.match(ssrModule.block.css, /ferriki-style-[a-f0-9]{64}/, 'the packed macro omitted its generated styles')
  assert.equal(ssrModule.renderCalls, 0, 'the packed render callback ran during module transformation')
  const defaultCodeMarkup = renderToStaticMarkup(React.createElement(ssrModule.DefaultCodeMacroExample))
  const defaultCodeTree = fromHtml(defaultCodeMarkup, { fragment: true })
  assert(hastText(defaultCodeTree).includes("const packedDefault = 'react';\\nconsole.log(packedDefault);"), 'the default React Code macro did not render source in SSR')
  assert(defaultCodeMarkup.includes('data-title="Default macro"'), 'the default React Code macro omitted metadata in SSR')
  assert.match(defaultCodeMarkup, /<div\\b[^>]*class="default-packed-class"/, 'the default React Code macro did not forward className to its div in SSR')
  const customCodeMarkup = renderToStaticMarkup(React.createElement(ssrModule.CustomCodeMacroExample))
  const customCodeTree = fromHtml(customCodeMarkup, { fragment: true })
  assert.match(customCodeMarkup, /<article data-packed-wrapper="custom"><section\\b/, 'the packed render callback did not return its React element inside a parent JSX child')
  assert.equal(hastProperty(customCodeTree, 'dataReactCode'), "const packedCustom = 'react';\\nconsole.log(packedCustom);")
  assert(hastText(customCodeTree).includes("const packedCustom = 'react';\\nconsole.log(packedCustom);"), 'the custom React Code macro did not render its prepared HTML in SSR')
  assert(customCodeMarkup.includes('data-title="Custom macro"'), 'the custom React Code macro omitted metadata in SSR')
  assert.equal(hastProperty(customCodeTree, 'dataRenderClass'), 'custom-packed-class', 'the render callback did not receive and forward className in SSR')
  assert.equal(hastProperty(customCodeTree, 'dataRuntimeTitle'), 'Runtime custom title', 'the render callback did not forward its closure value in SSR')
  assert.equal(ssrModule.renderCalls, 1, 'the render callback did not run during React SSR')
} finally {
  await server.close()
}
const output = await build({ configFile: false, root: project, plugins: [ferriki(options)], oxc: oxcConfig, build: { write: false, minify: false } })
const outputs = Array.isArray(output) ? output.flatMap((item) => item.output) : output.output
const text = outputs.map((item) => ('source' in item ? String(item.source) : item.code)).join('\\n')
assert(text.includes('packedValue') && text.includes('ferriki-highlight-line') && text.includes('no macro import'), 'packed Vite production build omitted the prepared macro or its CSS')
`,
    );
    run(process.execPath, [probe], {
      cwd: consumer,
      stdio: "pipe",
      env: { FERRIKI_PLATFORM_ID: platformId },
    });
    const typeProbe = join(consumer, "packed-vite-types.tsx");
    await writeFile(
      typeProbe,
      [
        "import { ferriki } from '@ferriki/vite'",
        "import type { ShikiTransformer } from '@ferriki/core'",
        "import { code } from '@ferriki/core/macro'",
        "import type { FerrikiCodeOptions, PreparedCodeBlock } from '@ferriki/core/macro'",
        "import { Code, type CodeRenderProps } from '@ferriki/core/react/macro'",
        "import type { Plugin } from 'vite'",
        "",
        "const transformer: ShikiTransformer = { line(node) { return node } }",
        "const plugin: Plugin = ferriki({",
        "  themes: { light: 'github-light-default', dark: 'github-dark-default' },",
        "  styleMode: 'classes',",
        "  include: id => id.endsWith('.mdx'),",
        "  transformers: [transformer],",
        "})",
        "const macroOptions: FerrikiCodeOptions = { language: 'ts', meta: 'title=Packed', lineNumbers: true }",
        "const prepared: PreparedCodeBlock = code('const packed = true', macroOptions)",
        "const runtimeTitle: string = 'typed closure title'",
        "const runtimeClassName: string = 'typed-runtime-class'",
        "const invalidClassName: number = 42",
        "const CustomCodeBlock = ({ code, className, title }: { code: PreparedCodeBlock; className?: string | undefined; title: string }) => null",
        "const exportedRenderer = ({ code, className }: CodeRenderProps) => <CustomCodeBlock code={code} className={className} title={runtimeTitle} />",
        "const defaultCodeElement = <Code language='ts' source={`const packedDefault = true`} meta='title=Default' lineNumbers className='default-typed-class' />",
        "const customCodeElement = <Code language='ts' source={`const packedCustom = true`} className={runtimeClassName} render={({ code, className }) => { const inferredCode: PreparedCodeBlock = code; const inferredClassName: string | undefined = className; return <CustomCodeBlock code={inferredCode} className={inferredClassName} title={runtimeTitle} /> }} />",
        "const exportedRenderTypeElement = <Code language='ts' source={`const exported = true`} className={undefined} render={exportedRenderer} />",
        "// @ts-expect-error React Code requires a source string.",
        "const missingSource = <Code language='ts' />",
        "// @ts-expect-error React Code does not accept children.",
        "const withChildren = <Code language='ts' source='const child = true'>child</Code>",
        "// @ts-expect-error unknown JSX properties are rejected.",
        "const unknownProperty = <Code language='ts' source='const property = true' unsupported />",
        "// @ts-expect-error the unreleased component prop is not part of the render-function API.",
        "const legacyComponent = <Code language='ts' source='const component = true' component={CustomCodeBlock} />",
        "// @ts-expect-error render must be a function, not a JSX element.",
        "const renderElement = <Code language='ts' source='const render = true' render={<span />} />",
        "const undefinedClassName = <Code language='ts' source='const className = true' className={undefined} />",
        "// @ts-expect-error className must be a string.",
        "const invalidClassNameElement = <Code language='ts' source='const className = true' className={invalidClassName} />",
        "const undefinedRenderer = <Code language='ts' source='const render = true' render={undefined} />",
        "const RequiresTitle = ({ code, title }: { code: PreparedCodeBlock; title: string }) => null",
        "// @ts-expect-error renderer-owned required props must be passed explicitly.",
        "const missingRendererProp = <Code language='ts' source='const renderer = true' render={({ code }) => <RequiresTitle code={code} />} />",
        "const highlightedLines: readonly number[] = prepared.metadata.highlightedLines",
        "void highlightedLines",
        "void defaultCodeElement",
        "void customCodeElement",
        "void exportedRenderTypeElement",
        "void missingSource",
        "void withChildren",
        "void unknownProperty",
        "void legacyComponent",
        "void renderElement",
        "void undefinedClassName",
        "void invalidClassNameElement",
        "void undefinedRenderer",
        "void missingRendererProp",
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
        "--exactOptionalPropertyTypes",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--jsx",
        "react-jsx",
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
