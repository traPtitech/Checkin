/**
 * A verified Stripe event, reduced to what the `invoice.paid` flow needs: the
 * event id (idempotency key), its type, and the related object id (the Stripe
 * Invoice id, or null when absent). Mirrors the shape the Nitro route produces
 * from {@link constructEvent} after signature verification.
 */
export interface VerifiedInvoiceEvent {
  id: string
  type: string
  objectId: string | null
}

/**
 * The side effects the `invoice.paid` flow drives, injected so the orchestration
 * is unit-testable without a DB or live Stripe (mirrors {@link IssuanceOps}):
 *   - `hasProcessed` — has this event id already been recorded? (happy-path dedup)
 *   - `markPaid`     — flip the paid invoice's ledger slots to `paid` (idempotent)
 *   - `notify`       — notify the accountant
 *   - `recordOnce`   — record the event id once (returns false on duplicate insert)
 */
export interface InvoicePaidOps {
  hasProcessed: (eventId: string) => Promise<boolean>
  markPaid: (invoiceId: string) => Promise<void>
  notify: (message: string) => Promise<void>
  recordOnce: (event: { id: string, type: string }) => Promise<boolean>
}

/**
 * Process a verified `invoice.paid` event with at-least-once delivery semantics.
 *
 * Ordering is load-bearing:
 *   1. Dedup (happy path): if the event id was already recorded, skip everything.
 *   2. If there is an Invoice id, confirm the issuance ledger (flip slots to
 *      `paid`). A 台帳外 invoice (no slots) is a no-op, and this runs BEFORE
 *      notify/record so a failure here leaves the event unrecorded and Stripe
 *      retries. (issuance-ledger spec: §入金時の paid 確定)
 *   3. Notify the accountant FIRST, then record the event. A notify failure
 *      throws before {@link InvoicePaidOps.recordOnce} runs, so the event stays
 *      unrecorded and Stripe retries (at-least-once). A notify-success/record-fail
 *      or two concurrent first deliveries may rarely double-notify, which is
 *      acceptable for accountant notifications. The `recordOnce` return value is
 *      intentionally ignored — a duplicate insert does not change the outcome.
 *      (payment-webhook spec: §event id による冪等処理 / §入金時に会計へ通知)
 *
 * The notify message text is part of the contract — keep it byte-for-byte stable.
 */
export async function processInvoicePaid(
  ops: InvoicePaidOps,
  verified: VerifiedInvoiceEvent,
): Promise<{ ok: true, duplicate?: boolean }> {
  // Idempotency (happy path): skip if this event was already processed before.
  if (await ops.hasProcessed(verified.id)) {
    return { ok: true, duplicate: true }
  }

  // Confirm the issuance ledger before notify/record so a failure leaves the
  // event unrecorded and Stripe retries.
  if (verified.objectId) {
    await ops.markPaid(verified.objectId)
  }

  // Notify FIRST, then record — a notify failure throws before recordOnce runs,
  // so the event stays unrecorded and Stripe will retry (at-least-once).
  await ops.notify(`入金を確認しました（Stripe event ${verified.id}）。`)
  await ops.recordOnce({ id: verified.id, type: verified.type })

  return { ok: true }
}
