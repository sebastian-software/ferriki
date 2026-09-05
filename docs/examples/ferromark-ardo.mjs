import { fileURLToPath } from 'node:url'

const { createHighlighter } = await import(process.env.FERRIKI_PACKAGE_PATH || 'ferriki')

/**
 * Build the synchronous highlighter contract consumed by Ferromark 0.8.
 *
 * The async factory boundary is intentional: Ardo/Ferromark must finish
 * loading every language used by a document before fenced rendering starts.
 * Ardo still owns the surrounding figure, title, label, line metadata, and
 * trusted-output decision.
 */
export async function createFerrikiCodeHighlighter({
  languages = ['typescript', 'markdown'],
  lightTheme = 'vitesse-light',
  darkTheme = 'nord',
  onDiagnostic = diagnostic => console.warn(`[ferriki] ${diagnostic.message}`),
} = {}) {
  const highlighter = await createHighlighter({
    langs: languages,
    themes: [lightTheme, darkTheme],
  })

  return {
    codeToHtml(code, { lang = 'text', meta = {} } = {}) {
      const rawMeta = typeof meta?.__raw === 'string' ? meta.__raw : ''
      try {
        return highlighter.codeToHtml(code, {
          lang,
          themes: {
            light: lightTheme,
            dark: darkTheme,
          },
          defaultColor: false,
          // Ferromark's fence parser owns this opaque string. Ferriki never
          // interpolates it into HTML; Ardo parses title/label attributes.
          meta: { __raw: rawMeta },
        })
      }
      catch (cause) {
        const message = `Code highlighting failed for language ${JSON.stringify(lang)}; using escaped plaintext.`
        onDiagnostic({
          code: 'FERRIKI_HIGHLIGHT_FALLBACK',
          language: lang,
          message,
          cause,
        })
        return `<pre class="ferriki-fallback language-${escapeAttribute(lang)}"><code>${escapeHtml(code)}</code></pre>`
      }
    },
    dispose() {
      highlighter.dispose()
    },
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function escapeAttribute(value) {
  return escapeHtml(value)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const adapter = await createFerrikiCodeHighlighter()
  const rendered = adapter.codeToHtml('const answer = 42', {
    lang: 'typescript',
    meta: { __raw: '{title="example.ts"}' },
  })
  if (!rendered.includes('shiki-themes') || !rendered.includes('class="line"'))
    throw new Error('Ferriki example did not render the dual-theme line contract')

  const hastHighlighter = await createHighlighter({ langs: ['typescript'], themes: ['nord'] })
  const hast = hastHighlighter.codeToHast('const answer = 42', {
    lang: 'typescript',
    theme: 'nord',
  })
  if (hast.type !== 'root')
    throw new Error('Ferriki example did not produce HAST output')

  adapter.dispose()
  hastHighlighter.dispose()
  console.log('Ferriki + Ferromark adapter example rendered successfully')
}
