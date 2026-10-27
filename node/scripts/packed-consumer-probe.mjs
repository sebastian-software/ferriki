import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const nodeRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(nodeRoot, "ferriki");
const examplePath = join(nodeRoot, "..", "docs", "examples", "ferromark-ardo.mjs");

// Product assertions run inside a real installation prepared by Ferramenta.
export default async function verify({ consumer, run }) {
  await import("./test-asset-env.mjs");
  const consumerExample = join(consumer, "ferromark-ardo.mjs");
  await cp(examplePath, consumerExample);
  run(process.execPath, [consumerExample], { cwd: consumer, stdio: "inherit" });

  const grammarInput = join(consumer, "external.tmLanguage.json");
  await writeFile(
    grammarInput,
    JSON.stringify({
      scopeName: "source.packed-external",
      patterns: [{ match: "\\bTODO\\b", name: "keyword.control" }],
    }),
  );
  const grammarBin = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "ferriki.cmd" : "ferriki",
  );
  const importedGrammar = JSON.parse(
    run(
      grammarBin,
      ["grammar", "fetch", grammarInput, "--name", "packed-external", "--aliases", "pext"],
      { cwd: consumer },
    ).stdout,
  );
  assert.equal(importedGrammar.name, "packed-external");
  await writeFile(join(consumer, "external.ferriki.json"), JSON.stringify(importedGrammar));

  const consumerProbe = join(consumer, "packed-probe.mjs");
  await writeFile(
    consumerProbe,
    `
import * as ferriki from '@ferriki/core'
import externalGrammar from './external.ferriki.json' with { type: 'json' }
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
await highlighter.loadLanguage(externalGrammar)
if (!highlighter.codeToHtml('TODO', { lang: 'pext', theme: 'nord' }).includes('color:'))
  throw new Error('the packed grammar CLI did not produce a usable registration')
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
  assert(
    installedReadme === (await readFile(join(packageRoot, "README.md"), "utf8")),
    "packed README does not match the package source README",
  );
}
