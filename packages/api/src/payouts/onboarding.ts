/**
 * Payout onboarding state — pure, Stripe-independent logic.
 *
 * This module must NOT call the Stripe SDK (a type-only import is fine). It
 * receives a narrow structural view of a connected account and decides payout
 * readiness / the next onboarding status, so the rules are trivially testable
 * and the Stripe boundary stays in `stripe/connect.ts`. (design D3)
 */

/** The three states of the onboarding state machine. */
export type PayoutOnboardingStatus = 'none' | 'requested' | 'done'

/**
 * The narrow shape `isPayoutsReady` reads from a connected account. The adapter
 * (or a webhook event) maps the Stripe `Account` down to this so the domain
 * never sees a Stripe type.
 */
export interface PayoutsReadyAccount {
  payouts_enabled: boolean
  requirements?: { currently_due?: string[] | null } | null
}

/**
 * Whether the connected account can receive payouts: payouts are enabled AND
 * there are no outstanding (currently due) requirements. Stripe sends no single
 * "completed" event, so readiness is decided by these flags, not by event arrival.
 * (connect-onboarding spec: §account.updated による払い出し可否のフラグ判定)
 */
export function isPayoutsReady(account: PayoutsReadyAccount): boolean {
  return account.payouts_enabled === true
    && (account.requirements?.currently_due ?? []).length === 0
}

/**
 * Next onboarding status given the current status and computed readiness.
 *
 * Rules (connect-onboarding spec: §onboarding の状態機械):
 *   - `done` is terminal — never regress.
 *   - `ready` ⇒ `done`.
 *   - otherwise keep `none` as `none`, and `requested` (or any started state)
 *     as `requested`.
 *
 * Idempotent: re-evaluating with the same inputs yields the same result.
 */
export function nextOnboardingStatus(
  current: PayoutOnboardingStatus,
  ready: boolean,
): PayoutOnboardingStatus {
  // `done` is terminal and must not regress.
  if (current === 'done') {
    return 'done'
  }
  if (ready) {
    return 'done'
  }
  // Not ready: preserve the (non-terminal) current state. `none` stays `none`
  // until a link is issued; anything already started stays `requested`.
  return current === 'none' ? 'none' : 'requested'
}
