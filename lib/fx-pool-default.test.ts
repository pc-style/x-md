import { expect, test } from 'vitest'

// The pool is read from the environment at import time, so set it before importing.
process.env.FXTWITTER_BASE_URL = ' , ,'
const { FX_BASES, pickFxBase } = await import('./fxtwitter.js')

test('an empty FXTWITTER_BASE_URL still leaves the public upstream in the pool', () => {
  expect(FX_BASES).toEqual(['https://api.fxtwitter.com'])
  expect(pickFxBase()).toBe('https://api.fxtwitter.com')
})
