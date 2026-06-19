import { describe, expect, it } from 'vitest'
import { nextPayoutStatus, type PayoutStatus } from './status'

describe('nextPayoutStatus', () => {
  it('parks at onboarding_waiting when onboarding is not done', () => {
    expect(nextPayoutStatus('pending', { onboardingDone: false }))
      .toBe('onboarding_waiting')
    expect(nextPayoutStatus('onboarding_waiting', { onboardingDone: false }))
      .toBe('onboarding_waiting')
    expect(nextPayoutStatus('failed', { onboardingDone: false }))
      .toBe('onboarding_waiting')
  })

  it('advances to paid when onboarding is done and the transfer succeeds', () => {
    expect(nextPayoutStatus('pending', { onboardingDone: true, transferOk: true }))
      .toBe('paid')
    expect(nextPayoutStatus('onboarding_waiting', { onboardingDone: true, transferOk: true }))
      .toBe('paid')
  })

  it('goes to failed when onboarding is done but the transfer fails', () => {
    expect(nextPayoutStatus('pending', { onboardingDone: true, transferOk: false }))
      .toBe('failed')
    expect(nextPayoutStatus('failed', { onboardingDone: true, transferOk: false }))
      .toBe('failed')
  })

  it('keeps the current status when done but no transfer was attempted', () => {
    expect(nextPayoutStatus('pending', { onboardingDone: true }))
      .toBe('pending')
    expect(nextPayoutStatus('onboarding_waiting', { onboardingDone: true }))
      .toBe('onboarding_waiting')
  })

  it('treats paid as terminal — never regresses or re-transfers', () => {
    expect(nextPayoutStatus('paid', { onboardingDone: false })).toBe('paid')
    expect(nextPayoutStatus('paid', { onboardingDone: true, transferOk: true })).toBe('paid')
    expect(nextPayoutStatus('paid', { onboardingDone: true, transferOk: false })).toBe('paid')
  })

  it('is idempotent — re-applying the settled state is a fixed point', () => {
    const paid: PayoutStatus = nextPayoutStatus('pending', { onboardingDone: true, transferOk: true })
    expect(nextPayoutStatus(paid, { onboardingDone: true, transferOk: true })).toBe('paid')
    // Even a later "not ready" re-eval cannot un-pay.
    expect(nextPayoutStatus(paid, { onboardingDone: false })).toBe('paid')
  })

  it('settles a claimed (processing) row by the transfer outcome', () => {
    // The execution claim flips a claimable row to `processing`; the same step
    // then settles it. The pure function treats `processing` like any non-paid
    // current state: it never regresses to/from paid incorrectly.
    expect(nextPayoutStatus('processing', { onboardingDone: true, transferOk: true })).toBe('paid')
    expect(nextPayoutStatus('processing', { onboardingDone: true, transferOk: false })).toBe('failed')
    expect(nextPayoutStatus('processing', { onboardingDone: false })).toBe('onboarding_waiting')
  })
})
