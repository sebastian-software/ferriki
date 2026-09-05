import assert from 'node:assert/strict'
import { createHighlighter, ShikiError } from '../ferriki/index.mjs'

const highlighter = await createHighlighter({
  langs: ['javascript'],
  themes: ['nord'],
})

try {
  const calls = []
  const html = highlighter.codeToHtml('const answer = 42', {
    lang: 'javascript',
    theme: 'nord',
    meta: { title: 'demo' },
    transformers: [{
      preprocess(code) {
        calls.push('preprocess')
        return code
      },
      tokens(tokens) {
        calls.push('tokens')
        return tokens
      },
      span(node) {
        calls.push('span')
        node.properties.class = 'token'
        return node
      },
      line(node) {
        calls.push('line')
        return node
      },
      code(node) {
        calls.push('code')
        return node
      },
      pre(node) {
        calls.push('pre')
        return node
      },
      root(node) {
        calls.push('root')
        return node
      },
      postprocess(value) {
        calls.push('postprocess')
        return `${value}<!-- transformed -->`
      },
    }],
  })
  assert.match(html, /title="demo"/)
  assert.match(html, /class="token"/)
  assert.match(html, /<!-- transformed -->/)
  assert.deepEqual(calls.slice(0, 3), ['preprocess', 'tokens', 'span'])
  assert.equal(calls.at(-1), 'postprocess')
  assert(calls.includes('line'))
  assert(calls.includes('code'))
  assert(calls.includes('pre'))
  assert(calls.includes('root'))

  const decorated = highlighter.codeToHtml('alpha\nbeta', {
    lang: 'text',
    theme: 'nord',
    decorations: [{
      start: { line: 0, character: 1 },
      end: { line: 1, character: 2 },
      properties: { class: 'marked' },
    }],
  })
  assert.match(decorated, /class="marked"/)

  assert.throws(
    () => highlighter.codeToHtml('alpha', {
      lang: 'text',
      theme: 'nord',
      decorations: [{ start: 3, end: 1 }],
    }),
    error => error instanceof ShikiError && error.code === 'ERR_USAGE',
  )
}
finally {
  highlighter.dispose()
}

console.log('Ferriki transformer and decoration contract verified')
