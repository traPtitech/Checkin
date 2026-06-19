import { describe, expect, it } from 'vitest'
import { isPayoutsReady, nextOnboardingStatus, type PayoutsReadyAccount } from './onboarding'

describe('isPayoutsReady', () => {
  it('is true when payouts are enabled and no requirements are due', () => {
    expect(isPayoutsReady({ payouts_enabled: true, requirements: { currently_due: [] } }))
      .toBe(true)
  })

  it('is false when payouts are disabled (even with no requirements due)', () => {
    expect(isPayoutsReady({ payouts_enabled: false, requirements: { currently_due: [] } }))
      .toBe(false)
  })

  it('is false when requirements are still due (even with payouts enabled)', () => {
    expect(isPayoutsReady({
      payouts_enabled: true,
      requirements: { currently_due: ['external_account'] },
    })).toBe(false)
  })

  it('treats missing requirements as no requirements due', () => {
    expect(isPayoutsReady({ payouts_enabled: true })).toBe(true)
    expect(isPayoutsReady({ payouts_enabled: true, requirements: null })).toBe(true)
    expect(isPayoutsReady({ payouts_enabled: true, requirements: { currently_due: null } }))
      .toBe(true)
  })

  it('is false when not enabled and requirements are due', () => {
    const account: PayoutsReadyAccount = {
      payouts_enabled: false,
      requirements: { currently_due: ['external_account'] },
    }
    expect(isPayoutsReady(account)).toBe(false)
  })
})

describe('nextOnboardingStatus', () => {
  it('keeps none as none when not ready', () => {
    expect(nextOnboardingStatus('none', false)).toBe('none')
  })

  it('keeps requested as requested when not ready', () => {
    expect(nextOnboardingStatus('requested', false)).toBe('requested')
  })

  it('advances requested to done when ready', () => {
    expect(nextOnboardingStatus('requested', true)).toBe('done')
  })

  it('advances none to done when ready', () => {
    expect(nextOnboardingStatus('none', true)).toBe('done')
  })

  it('keeps done as done regardless of readiness (terminal, no regress)', () => {
    expect(nextOnboardingStatus('done', false)).toBe('done')
    expect(nextOnboardingStatus('done', true)).toBe('done')
  })

  it('is idempotent — re-applying the same transition yields the same result', () => {
    const onceReady = nextOnboardingStatus('requested', true)
    expect(nextOnboardingStatus(onceReady, true)).toBe('done')
    expect(nextOnboardingStatus(onceReady, false)).toBe('done')

    const onceNone = nextOnboardingStatus('none', false)
    expect(nextOnboardingStatus(onceNone, false)).toBe('none')
  })
})
