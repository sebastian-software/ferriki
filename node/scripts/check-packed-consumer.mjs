import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { FERRIKI_PLATFORM_TARGETS, resolveFerrikiPlatformTarget } from "../ferriki/platforms.mjs";

import "./test-asset-env.mjs";

const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const packageRoot = join(nodeRoot, "ferriki");
const examplePath = join(nodeRoot, "..", "docs", "examples", "ferromark-ardo.mjs");
// The main package ships no native addon; a consumer loads it from the
// matching platform package, so this gate installs both tarballs.
const platformId = process.env.FERRIKI_PLATFORM_ID ?? resolveFerrikiPlatformTarget()?.id;
assert(
  platformId,
  "FERRIKI_PLATFORM_ID is required on a platform Ferriki does not support natively",
);
const target = FERRIKI_PLATFORM_TARGETS.find((entry) => entry.id === platformId);
assert(target, `unknown Ferriki platform id ${platformId}`);
const sidecarRoot = join(nodeRoot, "platforms", platformId);
await stat(join(sidecarRoot, "ferriki.node")).catch(() => {
  throw new Error(
    `${sidecarRoot}/ferriki.node is missing; run build:native with FERRIKI_PLATFORM_ID=${platformId} first`,
  );
});
const tempRoot = await mkdtemp(join(tmpdir(), "ferriki-docs-consumer-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || packageRoot,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    shell: process.platform === "win32" && command === "npm.cmd",
    env: {
      ...process.env,
      npm_config_cache: join(tempRoot, "npm-cache"),
      npm_config_update_notifier: "false",
      ...options.env,
    },
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.error || ""}\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
  return result;
}

try {
  const packed = run(npmCommand, ["pack", "--json", "--pack-destination", tempRoot]);
  const metadata = JSON.parse(packed.stdout)[0];
  const files = new Set(metadata.files.map((file) => file.path));
  for (const required of ["index.mjs", "index.d.mts", "native.mjs", "assets/shiki/catalog.mjs"])
    assert(files.has(required), `packed Ferriki package is missing ${required}`);
  assert(
    ![...files].some((file) => file.endsWith(".node")),
    "the main package must not ship a native addon; platform packages carry it",
  );
  const forbidden = [
    (file) => file.startsWith("dist/chunks/"),
    (file) => file.endsWith(".wasm"),
    (file) => file.includes("shiki-rust"),
    (file) => file.includes("createJavaScriptRegexEngine"),
  ];
  for (const file of files)
    assert(
      !forbidden.some((predicate) => predicate(file)),
      `packed Ferriki package contains forbidden runtime file ${file}`,
    );
  assert(
    metadata.unpackedSize < 20_000_000,
    `packed Ferriki package exceeds the 20 MB unpacked budget (${metadata.unpackedSize})`,
  );

  const tarball = join(tempRoot, metadata.filename);
  const sidecar = JSON.parse(
    run(npmCommand, ["pack", "--json", "--pack-destination", tempRoot], { cwd: sidecarRoot })
      .stdout,
  )[0];
  assert.equal(sidecar.name, target.packageName, `sidecar tarball is ${sidecar.name}`);
  const consumer = await mkdtemp(join(tempRoot, "consumer-"));
  run(npmCommand, ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
  // Offline, so the release's other optional platform packages are skipped and
  // the gate stays runnable before they are on npm.
  run(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      tarball,
      join(tempRoot, sidecar.filename),
    ],
    { cwd: consumer, stdio: "ignore" },
  );
  const consumerExample = join(consumer, "ferromark-ardo.mjs");
  await cp(examplePath, consumerExample);
  run(process.execPath, [consumerExample], { cwd: consumer, stdio: "inherit" });

  const consumerProbe = join(consumer, "packed-probe.mjs");
  await writeFile(
    consumerProbe,
    `
import * as ferriki from '@ferriki/core'
const { codeToHtml, codeToHtmlWithCss, createHighlighter, ferrikiVersion } = ferriki
const removedOutputs = ['codeToHast', 'codeToTokens', 'codeToTokensBase', 'codeToTokensWithThemes', 'hastToHtml']
for (const name of removedOutputs)
  if (name in ferriki)
    throw new Error('removed output is still exported by the packed package: ' + name)

if (!ferrikiVersion())
  throw new Error('the packed @ferriki/core native binding did not load')

let nativeSubpathExported = true
try {
  await import('@ferriki/core/native')
}
catch (error) {
  if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED')
    throw error
  nativeSubpathExported = false
}
if (nativeSubpathExported)
  throw new Error('the internal native loader must not be exported as @ferriki/core/native')

const firstCss = await codeToHtmlWithCss('{"x":1}', { lang: 'json', theme: 'nord' })
if (!firstCss.html.includes('token') || !firstCss.css.includes('.ferriki-style-'))
  throw new Error('the packed CSS shorthand did not render on first use')

const highlighter = await createHighlighter({ themes: ['nord'] })
for (const name of removedOutputs)
  if (name in highlighter)
    throw new Error('removed output is still on the packed highlighter: ' + name)
await highlighter.loadLanguage('javascript')
const options = { lang: 'javascript', theme: 'nord' }
let tokenHookRan = false
let preHookRan = false
const html = highlighter.codeToHtml('const answer = 42', {
  ...options,
  transformers: [{
    tokens(tokens) {
      tokenHookRan = tokens.flat().map(token => token.content).join('') === 'const answer = 42'
      if ('codeToTokens' in this || 'codeToHast' in this)
        throw new Error('removed nested output methods remain in packed transformer context')
    },
    pre(node) {
      preHookRan = node.tagName === 'pre' && this.root.type === 'root'
      this.addClassToHast(node, 'packed-hook')
    },
  }],
})
if (!html.includes('const') || !html.includes('packed-hook') || !tokenHookRan || !preHookRan)
  throw new Error('the packed Ferriki HTML transformer pipeline did not produce the expected output')
let decorationCallbackRan = false
const decorated = highlighter.codeToHtml('const answer = 42', {
  ...options,
  decorations: [{ start: 6, end: 12, properties: { class: 'packed-decoration' }, transform(node, type) {
    decorationCallbackRan = type === 'token' && this.start.offset === 6
    node.properties['data-decoration-callback'] = 'yes'
    return node
  } }],
})
if (!decorated.includes('packed-decoration') || !decorated.includes('data-decoration-callback') || !decorationCallbackRan)
  throw new Error('the packed native decoration bridge or JS callback failed')
const classOutput = highlighter.codeToHtmlWithCss('const answer = 42', options)
if (!classOutput.html.includes('const') || !classOutput.css || classOutput.html.includes(' style='))
  throw new Error('the packed Ferriki CSS-class renderer did not produce HTML and CSS')

try {
  await codeToHtml('const missing = true', { lang: 'not-a-real-ferriki-language', theme: 'nord' })
  throw new Error('missing language unexpectedly rendered')
}
catch (error) {
  if (error?.code !== 'ERR_UNSUPPORTED')
    throw error
}

const lazy = await createHighlighter({ themes: ['nord'] })
await lazy.loadLanguage('typescript')
if (!lazy.codeToHtml('const answer: number = 42', { lang: 'typescript', theme: 'nord' }).includes('answer'))
  throw new Error('packed lazy language loading did not produce HTML')
lazy.dispose()
highlighter.dispose()
`,
  );
  run(process.execPath, [consumerProbe], { cwd: consumer, stdio: "inherit" });

  const typecheck = join(consumer, "packed-types.mts");
  await writeFile(
    typecheck,
    `
import * as ferriki from '@ferriki/core'
import type { Highlighter, ShikiTransformerContextCommon } from '@ferriki/core'
// @ts-expect-error Standalone structured-output results are removed from the public contract.
import type { TokensResult } from '@ferriki/core'
const { codeToHtml, createHighlighter } = ferriki
type Assert<T extends true> = T
type RemovedOutputs = 'codeToHast' | 'codeToTokens' | 'codeToTokensBase' | 'codeToTokensWithThemes' | 'hastToHtml'
type _NoOutputExports = Assert<Extract<keyof typeof ferriki, RemovedOutputs> extends never ? true : false>
type _NoOutputMethods = Assert<Extract<keyof Highlighter, RemovedOutputs> extends never ? true : false>
type _NoNestedOutputs = Assert<Extract<keyof ShikiTransformerContextCommon, RemovedOutputs> extends never ? true : false>

const highlighter = await createHighlighter({ themes: ['nord'] })
const html: string = highlighter.codeToHtml('const answer = 42', { lang: 'javascript', theme: 'nord' })
const oneShot: Promise<string> = codeToHtml('const answer = 42', { lang: 'javascript', theme: 'nord' })
void html
void oneShot
`,
  );
  const tsc = join(nodeRoot, "node_modules", "typescript", "bin", "tsc");
  run(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      typecheck,
    ],
    {
      cwd: consumer,
    },
  );

  const installedReadme = await readFile(
    join(consumer, "node_modules", "@ferriki", "core", "README.md"),
    "utf8",
  );
  const { description } = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert(
    installedReadme.replace(/\s+/g, " ").includes(`Ferriki is ${description}`),
    `packed README was not installed, or its tagline no longer matches the package description: ${description}`,
  );
  console.log(
    `Ferriki packed consumer verified (${metadata.filename}, ${metadata.unpackedSize} bytes unpacked, ${files.size} files)`,
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
