import { describe, it, expect } from 'vitest'
import { normalizeEmail, deriveMailHash, safeEqual } from './crypto'
import { sanitizeRedirect } from './redirect'
import { isAllowedEmailDomain, isAccountant } from './config'
import { createAuthHelpers } from './context'
import { applyForwardedIdentity, type SessionIdentity } from './session'

const SECRET = 'test-secret'

describe('crypto: mail_hash', () => {
  it('normalizes whitespace and case', () => {
    expect(normalizeEmail('  Foo.Bar@m.isct.ac.jp ')).toBe('foo.bar@m.isct.ac.jp')
  })

  it('is deterministic and case/whitespace insensitive', () => {
    const a = deriveMailHash('  Foo.Bar@m.isct.ac.jp ', SECRET)
    const b = deriveMailHash('foo.bar@m.isct.ac.jp', SECRET)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces different hashes for different emails', () => {
    expect(deriveMailHash('a@m.isct.ac.jp', SECRET)).not.toBe(deriveMailHash('b@m.isct.ac.jp', SECRET))
  })

  it('depends on the secret', () => {
    expect(deriveMailHash('a@m.isct.ac.jp', 'k1')).not.toBe(deriveMailHash('a@m.isct.ac.jp', 'k2'))
  })

  it('refuses to derive without a secret', () => {
    expect(() => deriveMailHash('a@m.isct.ac.jp', '')).toThrow()
  })
})

describe('crypto: safeEqual', () => {
  it('matches equal strings and rejects others (incl. length diffs)', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('redirect: sanitizeRedirect', () => {
  it('allows same-site absolute paths', () => {
    expect(sanitizeRedirect('/payments')).toBe('/payments')
    expect(sanitizeRedirect('/membership?x=1#y')).toBe('/membership?x=1#y')
  })

  it('falls back for external / protocol-relative / empty', () => {
    expect(sanitizeRedirect('https://evil.com')).toBe('/')
    expect(sanitizeRedirect('//evil.com')).toBe('/')
    expect(sanitizeRedirect('/\\evil.com')).toBe('/')
    expect(sanitizeRedirect('relative/path')).toBe('/')
    expect(sanitizeRedirect(undefined)).toBe('/')
    expect(sanitizeRedirect('', '/home')).toBe('/home')
  })
})

describe('config: allow-lists', () => {
  it('checks email domain case-insensitively', () => {
    const domains = ['m.isct.ac.jp']
    expect(isAllowedEmailDomain('a@m.isct.ac.jp', domains)).toBe(true)
    expect(isAllowedEmailDomain('a@M.ISCT.AC.JP', domains)).toBe(true)
    expect(isAllowedEmailDomain('a@gmail.com', domains)).toBe(false)
    expect(isAllowedEmailDomain('not-an-email', domains)).toBe(false)
  })

  it('checks accountant allow-list', () => {
    expect(isAccountant('alice', ['alice', 'bob'])).toBe(true)
    expect(isAccountant('mallory', ['alice', 'bob'])).toBe(false)
  })
})

describe('context: auth helpers (dual identity)', () => {
  // A plain isct user: userId/mailHash, no traQ, not admin.
  const user: SessionIdentity = { traqId: null, isAdmin: false, userId: 'u1', mailHash: 'h1' }
  // A traQ member without a linked user.
  const member: SessionIdentity = { traqId: 'alice', isAdmin: false, userId: null, mailHash: null }
  // An accountant (allow-listed traQ ID).
  const admin: SessionIdentity = { traqId: 'alice', isAdmin: true, userId: null, mailHash: null }
  // A fully-linked member: both identities present.
  const linked: SessionIdentity = { traqId: 'bob', isAdmin: false, userId: 'u2', mailHash: 'h2' }

  it('requireMember: rejects anonymous and isct-only user, accepts traQ member', () => {
    expect(() => createAuthHelpers(null, true).requireMember()).toThrow()
    expect(() => createAuthHelpers(user, true).requireMember()).toThrow()
    expect(createAuthHelpers(member, true).requireMember()).toEqual({ traqId: 'alice' })
    expect(createAuthHelpers(linked, true).requireMember()).toEqual({ traqId: 'bob' })
  })

  it('requireUser: rejects anonymous and user-less member, accepts a billable user', () => {
    expect(() => createAuthHelpers(null, true).requireUser()).toThrow()
    // A traQ member with no linked user cannot issue invoices.
    expect(() => createAuthHelpers(member, true).requireUser()).toThrow()
    expect(createAuthHelpers(user, true).requireUser()).toEqual({ userId: 'u1', mailHash: 'h1' })
    expect(createAuthHelpers(linked, true).requireUser()).toEqual({ userId: 'u2', mailHash: 'h2' })
  })

  it('requireAdmin: anonymous, plain user and non-admin member are rejected, admin accepted', () => {
    expect(() => createAuthHelpers(null, true).requireAdmin()).toThrow()
    expect(() => createAuthHelpers(user, true).requireAdmin()).toThrow()
    expect(() => createAuthHelpers(member, true).requireAdmin()).toThrow()
    expect(createAuthHelpers(admin, true).requireAdmin()).toEqual({ traqId: 'alice' })
  })

  it('assertCsrf: throws when invalid, passes when valid', () => {
    expect(() => createAuthHelpers(user, false).assertCsrf()).toThrow()
    expect(() => createAuthHelpers(user, true).assertCsrf()).not.toThrow()
  })
})

describe('session: applyForwardedIdentity (NeoShowcase Soft auth)', () => {
  const cookieUser: SessionIdentity = { traqId: null, isAdmin: false, userId: 'u1', mailHash: 'h1' }

  it('no forwarded user → returns the cookie session unchanged', () => {
    expect(applyForwardedIdentity(cookieUser, null, ['alice'])).toBe(cookieUser)
    expect(applyForwardedIdentity(null, null, ['alice'])).toBeNull()
  })

  it('forwarded user becomes the traQ identity, keeping the cookie isct user', () => {
    const s = applyForwardedIdentity(cookieUser, 'bob', ['alice'])
    expect(s).toEqual({ traqId: 'bob', isAdmin: false, userId: 'u1', mailHash: 'h1' })
  })

  it('forwarded user in the allow-list is an accountant', () => {
    const s = applyForwardedIdentity(cookieUser, 'alice', ['alice'])
    expect(s).toEqual({ traqId: 'alice', isAdmin: true, userId: 'u1', mailHash: 'h1' })
  })

  it('forwarded user with no cookie session → traQ-only identity', () => {
    expect(applyForwardedIdentity(null, 'alice', ['alice'])).toEqual({
      traqId: 'alice', isAdmin: true, userId: null, mailHash: null,
    })
  })
})
