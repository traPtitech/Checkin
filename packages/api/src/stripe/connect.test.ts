import { describe, expect, it } from 'vitest'
import { isDuplicateKeyError } from './connect'

describe('isDuplicateKeyError', () => {
  it('matches mysql2 duplicate-entry by code', () => {
    expect(isDuplicateKeyError({ code: 'ER_DUP_ENTRY' })).toBe(true)
  })

  it('matches mysql2 duplicate-entry by errno (1062)', () => {
    expect(isDuplicateKeyError({ errno: 1062 })).toBe(true)
  })

  it('is false for unrelated errors and non-error values', () => {
    expect(isDuplicateKeyError(new Error('boom'))).toBe(false)
    expect(isDuplicateKeyError({ code: 'ER_NO_SUCH_TABLE', errno: 1146 })).toBe(false)
    expect(isDuplicateKeyError(null)).toBe(false)
    expect(isDuplicateKeyError(undefined)).toBe(false)
  })
})
