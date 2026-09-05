import { createHighlighter } from 'ferriki'

const highlighter = await createHighlighter({
  langs: ['typescript', 'markdown'],
  themes: ['nord', 'vitesse-light'],
})

/**
 * Minimal synchronous adapter shape consumed by Ferromark 0.8.
 * Ardo remains responsible for the surrounding code-block container.
 */
export function createFerrikiCodeHighlighter() {
  return {
    codeToHtml(code, { lang = 'text', meta = {} } = {}) {
      try {
        return highlighter.codeToHtml(code, {
          lang,
          themes: {
            light: 'vitesse-light',
            dark: 'nord',
          },
          defaultColor: false,
          meta: {
            __raw: String(meta.__raw || ''),
          },
        })
      }
      catch (error) {
        console.warn(`[ferriki] falling back to escaped ${lang} block: ${error}`)
        return escapeHtml(code)
      }
    },
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

const adapter = createFerrikiCodeHighlighter()
const rendered = adapter.codeToHtml('const answer = 42', {
  lang: 'typescript',
  meta: { __raw: '{title="example.ts"}' },
})
if (!rendered.includes('shiki'))
  throw new Error('Ferriki example did not render highlighted HTML')

console.log('Ferriki + Ferromark adapter example rendered successfully')
