import { ORPCError } from '@orpc/server'
import type { PayoutView } from '@checkin/api-contract'
import { adminProc } from '../orpc'
import { getUserById, getUserByTraqId, setPayoutOnboardingStatus } from '../auth'
import { createAccountOnboardingLink, getOrCreateConnectedAccount } from '../stripe'
import { executePayout, markPayoutManuallyPaid, processApprovedPayouts, type PayoutExecuteConfig } from './execute'
import { nextOnboardingStatus } from './onboarding'
import { getPayoutByJomonRef, listPayouts, type PayoutRow } from './store'

/**
 * Payout procedures — Connect onboarding and the 払い戻し execution the
 * accountant triggers. Input and output schemas live in the contract
 * (`@checkin/api-contract`), so these handlers only carry behaviour.
 */
export const payoutsRouter = {
  /**
   * Issue a Stripe **hosted** onboarding link for a payee's Connect connected
   * account so refunds can later pay out to them. Admin (accountant) only:
   * the accountant gets the URL and forwards it to the payee (we don't hold
   * plaintext email). Get-or-create the connected account, create the Account
   * Link, then mark the payee `requested` (unless already `done`).
   * (connect-onboarding spec: §ホスト型 onboarding リンクの発行 / §発行は会計のみ)
   */
  createOnboardingLink: adminProc.payouts.createOnboardingLink.handler(async ({ input, context }) => {
    context.assertCsrf()

    const row = await getUserById(context.db, input.userId)
    if (!row) {
      throw new ORPCError('NOT_FOUND', { message: 'target user not found' })
    }

    const accountId = await getOrCreateConnectedAccount(context.stripe, context.db, {
      userId: row.id,
      stripeConnectedAccountId: row.stripeConnectedAccountId,
      mailHash: row.mailHash,
      traqId: row.traqId,
    })

    // refresh/return land on app-origin pages (the UI is a later change).
    const url = await createAccountOnboardingLink(context.stripe, {
      accountId,
      refreshUrl: `${context.config.appOrigin}/payouts/onboarding/refresh`,
      returnUrl: `${context.config.appOrigin}/payouts/onboarding/return`,
    })

    // Issuing a link advances toward `requested`; `done` is terminal (no
    // regress). `nextOnboardingStatus(_, false)` keeps `done`/`requested` and
    // only `none` would stay `none` — so promote a non-`done` payee to
    // `requested` (skips a redundant write when already `requested`).
    const stayed = nextOnboardingStatus(row.payoutOnboardingStatus, false)
    if (stayed !== 'done' && row.payoutOnboardingStatus !== 'requested') {
      await setPayoutOnboardingStatus(context.db, row.id, 'requested')
    }

    return { url }
  }),

  /**
   * Report a payee's onboarding status (and whether a connected account is
   * linked yet) for the accountant. Read-only: admin, no `assertCsrf`.
   * (connect-onboarding spec: §状態確認は会計のみ)
   */
  onboardingStatus: adminProc.payouts.onboardingStatus.handler(async ({ input, context }) => {
    const row = await getUserById(context.db, input.userId)
    if (!row) {
      throw new ORPCError('NOT_FOUND', { message: 'target user not found' })
    }
    return {
      status: row.payoutOnboardingStatus,
      hasConnectedAccount: row.stripeConnectedAccountId !== null,
    }
  }),

  /**
   * Ingest Jomon's approved transfer requests and advance each one step
   * (the accounting trigger). Admin (accountant) only + `assertCsrf` (it
   * mutates: upserts payouts, may issue links / run transfers / write back).
   * Returns a plain count summary — no Stripe/Jomon types leak out.
   * Idempotent: jomon_ref upsert + `paid` short-circuit + Stripe idempotency
   * key prevent double payouts. (payout-execution spec: §払い戻し操作は会計のみ)
   */
  processApproved: adminProc.payouts.processApproved.handler(async ({ context }) => {
    context.assertCsrf()
    return processApprovedPayouts(
      { db: context.db, stripe: context.stripe, jomon: context.jomon },
      payoutExecuteConfig(context),
    )
  }),

  /**
   * List payouts for the accountant, optionally filtered by status. Read-only:
   * admin, no `assertCsrf`. Rows are Stripe/Jomon-type-free DTOs.
   *
   * There is no pagination here yet, so `nextCursor` is always null. The
   * envelope still follows the contract's `listEnvelope`, so adding pagination
   * later only adds inputs and leaves the output contract unchanged.
   */
  list: adminProc.payouts.list.handler(async ({ input, context }) => {
    const rows = await listPayouts(context.db, { status: input.status })
    return { data: rows.map(toPayoutView), nextCursor: null }
  }),

  /**
   * Advance / retry a single payout by `jomon_ref` (manual resume of an
   * `onboarding_waiting` payout or a retry after `failed`). Admin only +
   * `assertCsrf`. Returns a plain step result (no Stripe/Jomon types).
   */
  execute: adminProc.payouts.execute.handler(async ({ input, context }) => {
    context.assertCsrf()
    return executePayout(
      { db: context.db, stripe: context.stripe, jomon: context.jomon },
      payoutExecuteConfig(context),
      input.jomonRef,
    )
  }),

  /**
   * Record a MANUAL bank transfer as a settled `paid` payout for a payee who
   * cannot complete Connect onboarding — WITHOUT issuing a Stripe transfer.
   * Admin only + `assertCsrf` (it settles the payout and writes back to Jomon).
   * Only `pending` / `onboarding_waiting` / `failed` rows are settled; `paid` /
   * `processing` short-circuit. The actor (`manual_paid_by`) is resolved from
   * the SERVER SESSION (never client input) to prevent spoofing: prefer the
   * session's `userId`, else resolve the session's `traqId` to a `users.id`
   * (traQ-only admin whose userId isn't exposed); null when unresolvable.
   * (add-manual-bank-payout D5; spec §手動振込での paid 確定)
   */
  markManuallyPaid: adminProc.payouts.markManuallyPaid.handler(async ({ input, context }) => {
    context.assertCsrf()

    // Translate a missing row to a precise NOT_FOUND at the route boundary
    // (mirrors `createOnboardingLink`'s getUserById → ORPCError pattern), so a
    // bad jomonRef is a 404, not a 500 from the domain's plain throw. The
    // orchestration still re-reads atomically and is the source of truth.
    const row = await getPayoutByJomonRef(context.db, input.jomonRef)
    if (!row) {
      throw new ORPCError('NOT_FOUND', { message: 'payout not found' })
    }

    const byUserId = context.session?.userId
      ?? (context.session?.traqId
        ? (await getUserByTraqId(context.db, context.session.traqId))?.id ?? null
        : null)
    return markPayoutManuallyPaid(
      { db: context.db, stripe: context.stripe, jomon: context.jomon },
      { jomonRef: input.jomonRef, note: input.note, byUserId },
    )
  }),
}

/**
 * Convert a domain payout row to the contract's public view. The only
 * difference is the two timestamps: the row carries `Date`, the contract
 * publishes ISO 8601 strings (`z.iso.datetime()`), so a `Date` written straight
 * through would fail output validation.
 */
function toPayoutView(row: PayoutRow): PayoutView {
  return {
    id: row.id,
    jomonRef: row.jomonRef,
    userId: row.userId,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    stripeTransferId: row.stripeTransferId,
    jomonWrittenBackAt: row.jomonWrittenBackAt?.toISOString() ?? null,
    payoutMethod: row.payoutMethod,
    manualPaidNote: row.manualPaidNote,
    manualPaidAt: row.manualPaidAt?.toISOString() ?? null,
    manualPaidBy: row.manualPaidBy,
  }
}

/** Build the payout orchestration config from the request Context. */
function payoutExecuteConfig(context: {
  config: { appOrigin: string }
  jomonConfig: { payoutCurrency: string }
}): PayoutExecuteConfig {
  return {
    appOrigin: context.config.appOrigin,
    defaultCurrency: context.jomonConfig.payoutCurrency,
  }
}
