import {
  constructAccountEvent,
  createStripeClient,
  getUserByConnectedAccountId,
  hasProcessedStripeEvent,
  isPayoutsReady,
  nextOnboardingStatus,
  recordStripeEventOnce,
  setPayoutOnboardingStatus,
} from '@checkin/api'

/**
 * POST /webhook/account-updated — Stripe Connect `account.updated` receiver.
 *
 * No CSRF/session here: Stripe authenticates via the request signature, not a
 * browser cookie (design.md D5). We verify the signature over the RAW body with
 * the **Connect** webhook secret, dedupe by event id, locate the payee by their
 * connected account id, and flip `requested → done` only when the account is
 * actually payouts-ready (`payouts_enabled` + no requirements due). Stripe sends
 * no single "completed" event, so we judge by flags, not by event arrival.
 *
 * Idempotency mirrors invoice-paid: check `hasProcessedStripeEvent` → process →
 * `recordStripeEventOnce`. A failure before recording leaves the event
 * unrecorded so Stripe retries (at-least-once). The state transition itself is
 * idempotent (`done` is terminal), so a rare re-run is harmless.
 */
export default defineEventHandler(async (event) => {
  const billing = resolveBillingConfig()
  const stripe = createStripeClient(billing.stripeSecretKey)

  // Raw, unparsed body is required for the signature HMAC to match.
  const rawBody = await readRawBody(event, false)
  const signature = getHeader(event, 'stripe-signature')

  let verified: ReturnType<typeof constructAccountEvent>
  try {
    if (!rawBody) {
      throw new Error('missing request body')
    }
    verified = constructAccountEvent(stripe, rawBody, signature, billing.connectWebhookSecret)
  }
  catch {
    // Invalid or missing signature → reject without processing.
    throw createError({ statusCode: 400, statusMessage: 'invalid Stripe signature' })
  }

  // Ignore everything except account.updated (acknowledge so Stripe stops retrying).
  if (verified.type !== 'account.updated') {
    return { ok: true, ignored: verified.type }
  }

  // Idempotency (happy path): skip if this event was already processed before.
  const db = useDatabase()
  if (await hasProcessedStripeEvent(db, verified.id)) {
    return { ok: true, duplicate: true }
  }

  // Locate the payee by their connected account id. Unknown account → ignore (200).
  if (!verified.accountId) {
    return { ok: true, ignored: 'missing account' }
  }
  const row = await getUserByConnectedAccountId(db, verified.accountId)
  if (!row) {
    return { ok: true, ignored: 'unknown account' }
  }

  // Flag-based readiness: only advance to `done` (terminal) when payouts-ready.
  const ready = isPayoutsReady(verified.account)
  const next = nextOnboardingStatus(row.payoutOnboardingStatus, ready)
  if (next !== row.payoutOnboardingStatus) {
    await setPayoutOnboardingStatus(db, row.id, next)
  }

  // Record only AFTER the side effect so a failure above leaves it for retry.
  await recordStripeEventOnce(db, verified)

  return { ok: true }
})
