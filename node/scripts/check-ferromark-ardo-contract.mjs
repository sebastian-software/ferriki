import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

process.env.FERRIKI_PACKAGE_PATH = new URL('../ferriki/index.mjs', import.meta.url).href
const exampleModuleUrl = new URL('../../docs/examples/ferromark-ardo.mjs', import.meta.url)
const { createFerrikiCodeHighlighter } = await import(exampleModuleUrl.href)

const exampleSource = await readFile(fileURLToPath(new URL('../../docs/examples/ferromark-ardo.mjs', import.meta.url)), 'utf8')
assert(!exampleSource.includes('native.'))
assert(!exampleSource.includes('resolveGrammarScope'))

const diagnostics = []
const adapter = await createFerrikiCodeHighlighter({
  languages: ['typescript'],
  onDiagnostic: diagnostic => diagnostics.push(diagnostic),
})

try {
  const html = adapter.codeToHtml('const answer = 42', {
    lang: 'typescript',
    meta: { __raw: '{title="trusted-by-ardo" label="example"}' },
  })
  assert.match(html, /class="shiki-themes vitesse-light nord"/)
  assert.match(html, /class="line"/)
  assert.match(html, /--shiki-light:/)
  assert.match(html, /--shiki-dark:/)
  assert(!html.includes('trusted-by-ardo'))
  assert(!html.includes('example'))

  const escaped = adapter.codeToHtml('<script>alert("x")</script>', { lang: 'text' })
  assert(!escaped.includes('<script>'))
  assert(escaped.includes('&#x3C;script>'))

  const fallback = adapter.codeToHtml('<img src=x onerror=alert(1)>', {
    lang: 'missing-language',
    meta: { __raw: '{title="untrusted"}' },
  })
  assert.match(fallback, /ferriki-fallback language-missing-language/)
  assert(fallback.includes('&lt;img'))
  assert(!fallback.includes('untrusted'))
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].code, 'FERRIKI_HIGHLIGHT_FALLBACK')
  assert.match(diagnostics[0].message, /missing-language/)
}
finally {
  adapter.dispose()
}

console.log('Ferriki + Ferromark + Ardo contract verified')
