import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { describe, expect, it } from 'vitest'
import { createShikiPrimitiveAsync } from '../src'

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
      .toThrowError(/Missing languages `missing-lang`, required by `test-lang`/)
  })
})
