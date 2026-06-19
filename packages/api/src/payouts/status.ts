/**
 * Payout state machine — pure, Stripe/Jomon-independent logic.
 *
 * This module must NOT call any SDK. It decides the next payout status from
 * structural inputs, so the rules are trivially testable and the adapter
 * boundaries stay in `stripe/*.ts` / `jomon/*.ts`. (design D4)
 */

/**
 * The states of the payout state machine.
 *
 * `processing` is an application-level execution claim: a single ATOMIC
 * conditional UPDATE flips a claimable row (`pending` / `onboarding_waiting` /
 * `failed`) to it immediately before the Stripe transfer, so concurrent runs
 * cannot both pass the pre-transfer check and double-pay. It is transient — the
 * same step settles it to `paid` or `failed`. (§状態機械 / §二重送金しない)
 */
export type PayoutStatus
  = 'pending' | 'onboarding_waiting' | 'processing' | 'paid' | 'failed'

/** Inputs that decide a payout's next status. */
export interface NextPayoutStatusInput {
  /** Whether the payee's connected-account onboarding is `done`. */
  onboardingDone: boolean
  /**
   * Whether the Stripe transfer succeeded. Only meaningful when a transfer was
   * actually attempted (i.e. `onboardingDone` is true). Omit/undefined when no
   * transfer was attempted yet.
   */
  transferOk?: boolean
}

/**
 * Next payout status given the current status and computed inputs.
 *
 * Rules (payout-execution spec: §状態機械 / §再実行は二重送金しない):
 *   - `paid` is terminal — never regress or re-transfer.
 *   - onboarding not `done` ⇒ `onboarding_waiting` (do not pay out).
 *   - onboarding `done` + transfer succeeded ⇒ `paid`.
 *   - onboarding `done` + transfer failed ⇒ `failed`.
 *   - onboarding `done` but no transfer attempted yet ⇒ keep current.
 *
 * Idempotent: re-evaluating a `paid` payout stays `paid`, so re-runs never
 * trigger a second transfer.
 */
export function nextPayoutStatus(
  current: PayoutStatus,
  input: NextPayoutStatusInput,
): PayoutStatus {
  // `paid` is terminal and must not regress (no re-transfer on re-run).
  if (current === 'paid') {
    return 'paid'
  }
  if (!input.onboardingDone) {
    return 'onboarding_waiting'
  }
  // Onboarding is done; decide by the transfer outcome (if one was attempted).
  if (input.transferOk === undefined) {
    return current
  }
  return input.transferOk ? 'paid' : 'failed'
}
