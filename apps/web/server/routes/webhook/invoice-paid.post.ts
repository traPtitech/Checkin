import { constructEvent, createNotifier, createStripeClient, hasProcessedStripeEvent, markPaidByInvoiceId, processInvoicePaid, recordStripeEventOnce } from '@checkin/api'

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

  let verified: { id: string, type: string, objectId: string | null }
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

  // Process the paid event: dedup, confirm the issuance ledger, notify, record.
  // The flow lives in @checkin/api as a pure, injectable function so its ordering
  // (notify→record for at-least-once retry) and dedup are unit-tested without a DB
  // or live Stripe; the wiring below binds it to the real DB and notifier.
  const db = useDatabase()
  const notifier = createNotifier()
  return await processInvoicePaid({
    hasProcessed: id => hasProcessedStripeEvent(db, id),
    markPaid: async (id) => { await markPaidByInvoiceId(db, id) },
    notify: m => notifier.notify(m),
    recordOnce: e => recordStripeEventOnce(db, e),
  }, verified)
})
