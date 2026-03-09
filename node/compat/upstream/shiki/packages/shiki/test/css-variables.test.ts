import { codeToHtml } from 'shiki/bundle/full'
import { describe, expect, it } from 'vitest'
import { createCssVariablesTheme } from '../src'

describe('css-variables', () => {
  it('css-variable-factory', async () => {
    const theme = createCssVariablesTheme({
      variablePrefix: '--my-',
      variableDefaults: {
        background: '#000',
      },
    })

    const html = await codeToHtml('const a = 1', {
      lang: 'js',
      theme,
    })

    expect(html)
      .toMatchInlineSnapshot(`"<pre class="shiki css-variables" style="background-color:var(--my-background, #000);color:var(--my-foreground)" tabindex="0"><code><span class="line"><span style="color:var(--my-token-keyword)">const</span><span style="color:var(--my-token-constant)"> a</span><span style="color:var(--my-token-keyword)"> =</span><span style="color:var(--my-token-constant)"> 1</span></span></code></pre>"`)
  })

  it('css-variable-factory 2', async () => {
    const theme = createCssVariablesTheme({
      name: 'foo',
      variableDefaults: {
        background: '#000',
      },
      fontStyle: false,
    })

    const html = await codeToHtml('const a = 1', {
      lang: 'js',
      theme,
    })

    expect(html)
      .toMatchInlineSnapshot(`"<pre class="shiki foo" style="background-color:var(--shiki-background, #000);color:var(--shiki-foreground)" tabindex="0"><code><span class="line"><span style="color:var(--shiki-token-keyword)">const</span><span style="color:var(--shiki-token-constant)"> a</span><span style="color:var(--shiki-token-keyword)"> =</span><span style="color:var(--shiki-token-constant)"> 1</span></span></code></pre>"`)
  })
})
