import type { StripeClient } from './client'

/** Inputs for issuing a single-line invoice for one Price to a Customer. */
export interface IssueInvoiceInput {
  /** Target Stripe Customer id (resolved via get-or-create). */
  customerId: string
  /** The Price id chosen by the domain (費目・期・区分 → price). */
  priceId: string
  /** Days until the invoice is due (`send_invoice` collection). */
  daysUntilDue: number
  /** Optional metadata (e.g. activity-year label) attached to the Invoice. */
  metadata?: Record<string, string>
  /**
   * Optional deterministic Stripe idempotency key. Dedupes a rapid double-submit
   * within Stripe's window; it is not a cross-time issuance ledger (design Risks).
   */
  idempotencyKey?: string
}

/** What the caller needs to direct the user to the hosted payment page. */
export interface IssuedInvoice {
  invoiceId: string
  hostedInvoiceUrl: string | null
}

/**
 * Create a one-line Invoice for the given Price, finalize it, and send it.
 *
 * Steps (membership-billing spec: §請求書の作成・確定・送付):
 *   1. Create a draft Invoice for the Customer (`send_invoice` collection).
 *   2. Attach an InvoiceItem for the Price to that draft.
 *   3. Finalize → send. The returned `hosted_invoice_url` is the payment page.
 */
export async function issueInvoice(
  stripe: StripeClient,
  input: IssueInvoiceInput,
): Promise<IssuedInvoice> {
  // The idempotency key (when supplied) is passed as Stripe request options so a
  // rapid double-submit collapses to a single invoice within Stripe's window.
  const requestOptions = input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined

  // 1. Draft invoice. `send_invoice` + days_until_due gives the user a payable
  // hosted invoice (vs charge_automatically which needs a saved payment method).
  const draft = await stripe.sdk.invoices.create({
    customer: input.customerId,
    collection_method: 'send_invoice',
    days_until_due: input.daysUntilDue,
    metadata: input.metadata,
  }, requestOptions)
  if (!draft.id) {
    throw new Error('Stripe did not return an invoice id')
  }
  const invoiceId = draft.id

  // Once the draft exists, clean it up if any later step fails so we don't leave
  // an orphaned draft/finalized invoice behind, then rethrow the original error.
  try {
    // 2. Add the single priced line to the draft.
    await stripe.sdk.invoiceItems.create({
      customer: input.customerId,
      invoice: invoiceId,
      pricing: { price: input.priceId },
    }, requestOptions)

    // 3. Finalize then send so the customer receives the hosted invoice / email.
    await stripe.sdk.invoices.finalizeInvoice(invoiceId)
    const sent = await stripe.sdk.invoices.sendInvoice(invoiceId)

    return { invoiceId: sent.id ?? invoiceId, hostedInvoiceUrl: sent.hosted_invoice_url ?? null }
  }
  catch (err) {
    // Best-effort cleanup: delete a still-draft invoice, or void it if finalized.
    // Swallow cleanup failures so the original error is what surfaces.
    try {
      const current = await stripe.sdk.invoices.retrieve(invoiceId)
      if (current.status === 'draft') {
        await stripe.sdk.invoices.del(invoiceId)
      }
      else {
        await stripe.sdk.invoices.voidInvoice(invoiceId)
      }
    }
    catch {
      // ignore cleanup errors; surface the original failure below
    }
    throw err
  }
}
