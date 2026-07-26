import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { describe, expect, it } from 'vitest'
import { createShikiPrimitiveAsync } from '../src'

const RE_MISSING_LANG_ERROR = /Missing languages `missing-lang`, required by `test-lang`/

describe('repro issue', () => {
  it('should throw error when missing embeddedLanguages', async () => {
    const shiki = await createShikiPrimitiveAsync({
      engine: createJavaScriptRegexEngine(),
      themes: [],
      langs: [],
    })

    await expect(shiki.loadLanguage({
      name: 'test-lang',
      scopeName: 'source.test',
      embeddedLanguages: ['missing-lang'],
      patterns: [],
      repository: {},
    }))
      .rejects
      .toThrowError(RE_MISSING_LANG_ERROR)
  })
})
