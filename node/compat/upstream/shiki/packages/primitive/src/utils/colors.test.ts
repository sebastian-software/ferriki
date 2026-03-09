import { expect, it } from 'vitest'
import { resolveColorReplacements } from './colors'

it('resolveColorReplacements', async () => {
  expect(resolveColorReplacements('nord', {
    colorReplacements: {
      '#000000': '#ffffff',
      'nord': {
        '#000000': '#222222',
        '#abcabc': '#defdef',
        '#ffffff': '#111111',
      },
      'other': {
        '#000000': '#444444',
        '#ffffff': '#333333',
      },
      '#ffffff': '#000000',
    },
  })).toEqual(
    {
      '#abcabc': '#defdef',
      '#000000': '#222222',
      '#ffffff': '#000000',
    },
  )
})
