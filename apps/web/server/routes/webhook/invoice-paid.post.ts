import { constructEvent, createNotifier, createStripeClient, hasProcessedStripeEvent, recordStripeEventOnce } from '@checkin/api'

/**
 * POST /webhook/invoice-paid — Stripe `invoice.paid` receiver.
 *
 * No CSRF/session here: Stripe authenticates via the request signature, not a
 * browser cookie (design.md D6). We verify the signature over the RAW body,
 * dedupe by event id, and on `invoice.paid` notify the accountant. Other event
 * types are acknowledged and ignored.
 *
 * Delivery semantics: at-least-once with happy-path dedup. We notify FIRST and
 * record the event only AFTER notify resolves, so a notify failure leaves the
 * event unrecorded and Stripe retries. A notify-success/record-fail or two
 * concurrent first deliveries may rarely double-notify, which is acceptable for
 * accountant notifications.
 */
export default defineEventHandler(async (event) => {
  const billing = resolveBillingConfig()
  const stripe = createStripeClient(billing.stripeSecretKey)

  // Raw, unparsed body is required for the signature HMAC to match.
  const rawBody = await readRawBody(event, false)
  const signature = getHeader(event, 'stripe-signature')

  let verified: { id: string, type: string }
  try {
    if (!rawBody) {
      throw new Error('missing request body')
    }
    verified = constructEvent(stripe, rawBody, signature, billing.stripeWebhookSecret)
  }
  catch {
    // Invalid or missing signature → reject without processing.
    throw createError({ statusCode: 400, statusMessage: 'invalid Stripe signature' })
  }

  // Ignore everything except invoice.paid (acknowledge so Stripe stops retrying).
  if (verified.type !== 'invoice.paid') {
    return { ok: true, ignored: verified.type }
  }

  // Idempotency (happy path): skip if this event was already processed before.
  const db = useDatabase()
  if (await hasProcessedStripeEvent(db, verified.id)) {
    return { ok: true, duplicate: true }
  }

  // Notify FIRST, then record. A notify failure throws before recordStripeEventOnce
  // runs, so the event stays unrecorded and Stripe will retry (at-least-once).
  const notifier = createNotifier()
  await notifier.notify(`入金を確認しました（Stripe event ${verified.id}）。`)
  await recordStripeEventOnce(db, verified)

  return { ok: true }
})
