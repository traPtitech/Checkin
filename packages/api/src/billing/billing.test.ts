import { describe, expect, it } from 'vitest'
import type { BillingConfig } from './config'
import { computeTerm } from './term'
import { selectPriceId } from './pricing'
import { authorizeIssuance } from './authorize'

const config: BillingConfig = {
  prices: {
    shinkiZenki: 'price_shinki_zenki',
    shinkiKouki: 'price_shinki_kouki',
    keizokuStandard: 'price_keizoku_standard',
    keizokuSpecial: 'price_keizoku_special',
  },
  stripeSecretKey: 'sk_test_x',
  stripeWebhookSecret: 'whsec_x',
  invoiceDaysUntilDue: 7,
}

/** Build a date at the 1st of `month` (1-based) in a fixed year. */
function dateInMonth(month: number): Date {
  return new Date(2026, month - 1, 1)
}

describe('computeTerm', () => {
  it('treats March (3) as kouki (後期)', () => {
    expect(computeTerm(dateInMonth(3))).toBe('kouki')
  })

  it('treats April (4) — the activity-year boundary — as zenki (前期)', () => {
    expect(computeTerm(dateInMonth(4))).toBe('zenki')
  })

  it('treats September (9) as zenki (前期)', () => {
    expect(computeTerm(dateInMonth(9))).toBe('zenki')
  })

  it('treats October (10) as kouki (後期)', () => {
    expect(computeTerm(dateInMonth(10))).toBe('kouki')
  })
})

describe('selectPriceId', () => {
  it('new + zenki → 新規前期 price', () => {
    expect(selectPriceId(config, { feeType: 'new', term: 'zenki' })).toBe('price_shinki_zenki')
  })

  it('new + kouki → 新規後期 price', () => {
    expect(selectPriceId(config, { feeType: 'new', term: 'kouki' })).toBe('price_shinki_kouki')
  })

  it('continuation + standard → 継続標準 price', () => {
    expect(selectPriceId(config, { feeType: 'continuation', variant: 'standard' })).toBe('price_keizoku_standard')
  })

  it('continuation + special → 継続特別 price', () => {
    expect(selectPriceId(config, { feeType: 'continuation', variant: 'special' })).toBe('price_keizoku_special')
  })

  it('throws when the resolved price id is empty (unconfigured PRICE_* env)', () => {
    const empty: BillingConfig = { ...config, prices: { ...config.prices, keizokuStandard: '' } }
    expect(() => selectPriceId(empty, { feeType: 'continuation', variant: 'standard' }))
      .toThrow(/missing price id/)
  })
})

describe('authorizeIssuance', () => {
  it('allows standard when the submitted mail_hash matches the session', () => {
    expect(authorizeIssuance({
      variant: 'standard',
      isAdmin: false,
      sessionMailHash: 'hash_self',
      submittedMailHash: 'hash_self',
    })).toBe(true)
  })

  it('denies standard when the mail_hash does not match (issuing for another)', () => {
    expect(authorizeIssuance({
      variant: 'standard',
      isAdmin: false,
      sessionMailHash: 'hash_self',
      submittedMailHash: 'hash_other',
    })).toBe(false)
  })

  it('denies special for a non-admin user', () => {
    expect(authorizeIssuance({ variant: 'special', isAdmin: false })).toBe(false)
  })

  it('allows special for an admin (accountant)', () => {
    expect(authorizeIssuance({ variant: 'special', isAdmin: true })).toBe(true)
  })
})
