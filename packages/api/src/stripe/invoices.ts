import type { StripeClient } from './client'

/** Inputs for creating a single-line draft invoice for one Price to a Customer. */
export interface CreateDraftInput {
  /** Target Stripe Customer id (resolved via get-or-create). */
  customerId: string
  /** The Price id chosen by the domain (費目・期・区分 → price). */
  priceId: string
  /** Days until the invoice is due (`send_invoice` collection). */
  daysUntilDue: number
  /** Optional metadata (e.g. activity-year label) attached to the Invoice. */
  metadata?: Record<string, string>
}

/** What the caller needs to direct the user to the hosted payment page. */
export interface IssuedInvoice {
  invoiceId: string
  hostedInvoiceUrl: string | null
}

/**
 * Create a one-line **draft** Invoice for the given Price — NOT finalized, so it
 * is not yet payable. The issuance ledger reserves a slot carrying this id before
 * the invoice is finalized, so a payable invoice never exists without a guard.
 * (issuance-ledger: money-safety — draft before reserve before finalize)
 *
 * Deliberately NOT idempotent: each call mints a fresh invoice so two concurrent
 * issuers get DIFFERENT ids — the reservation race then has one winner and the
 * loser voids its own (distinct) draft. A shared idempotency key would make the
 * loser void the winner's invoice. The ledger is the duplicate-payment guard.
 * If the item step fails the orphaned draft is deleted before rethrowing.
 */
export async function createDraftInvoice(stripe: StripeClient, input: CreateDraftInput): Promise<{ invoiceId: string }> {
  const draft = await stripe.sdk.invoices.create({
    customer: input.customerId,
    collection_method: 'send_invoice',
    days_until_due: input.daysUntilDue,
    metadata: input.metadata,
  })
  if (!draft.id) {
    throw new Error('Stripe did not return an invoice id')
  }
  const invoiceId = draft.id

  try {
    await stripe.sdk.invoiceItems.create({
      customer: input.customerId,
      invoice: invoiceId,
      pricing: { price: input.priceId },
    })
    return { invoiceId }
  }
  catch (err) {
    // Delete the still-draft invoice so a failed item doesn't orphan it.
    await stripe.sdk.invoices.del(invoiceId).catch(() => {})
    throw err
  }
}

/**
 * Make an invoice payable and return its hosted payment page. Idempotent: a draft
 * is finalized and sent (once); an already-finalized invoice's URL is returned
 * WITHOUT re-sending the email (so reusing an open invoice doesn't spam). Also
 * recovers a crash-stuck draft when an open ledger slot is reused.
 *
 * MONEY-SAFETY INVARIANT: this throws ONLY when the invoice is still a draft
 * (NOT payable). Once `finalizeInvoice` makes it payable, a failing `sendInvoice`
 * (email) is swallowed — the hosted URL works regardless — so the caller never
 * voids/releases a payable invoice. A concurrent finalize that already made it
 * payable is detected by re-retrieving and returning its URL rather than erroring.
 * (issuance-ledger: §再利用 / draft-only-throw invariant)
 */
export async function finalizeAndSendInvoice(stripe: StripeClient, invoiceId: string): Promise<IssuedInvoice> {
  const invoice = await stripe.sdk.invoices.retrieve(invoiceId)
  if (invoice.status !== 'draft') {
    return { invoiceId: invoice.id ?? invoiceId, hostedInvoiceUrl: invoice.hosted_invoice_url ?? null }
  }
  try {
    const finalized = await stripe.sdk.invoices.finalizeInvoice(invoiceId)
    // Email is best-effort: a send failure must NOT fail issuance now that the
    // invoice is payable (else the caller would void a valid payable invoice).
    await stripe.sdk.invoices.sendInvoice(invoiceId).catch(() => {})
    return { invoiceId: finalized.id ?? invoiceId, hostedInvoiceUrl: finalized.hosted_invoice_url ?? null }
  }
  catch (err) {
    // A concurrent issuer may have finalized it already (→ now payable): return
    // its URL instead of erroring. Still draft ⇒ a genuine finalize failure (the
    // invoice is NOT payable), so rethrow and let the caller void + release.
    const after = await stripe.sdk.invoices.retrieve(invoiceId)
    if (after.status !== 'draft') {
      return { invoiceId: after.id ?? invoiceId, hostedInvoiceUrl: after.hosted_invoice_url ?? null }
    }
    throw err
  }
}

/**
 * Best-effort discard of a NON-paid invoice: delete a draft, void a finalized
 * (unpaid) one, no-op on paid/void. Used when a reservation race or a finalize
 * failure means a created invoice must not survive. Never throws.
 */
export async function voidInvoiceSafe(stripe: StripeClient, invoiceId: string): Promise<void> {
  try {
    const invoice = await stripe.sdk.invoices.retrieve(invoiceId)
    if (invoice.status === 'draft') {
      await stripe.sdk.invoices.del(invoiceId)
    }
    else if (invoice.status !== 'paid' && invoice.status !== 'void') {
      await stripe.sdk.invoices.voidInvoice(invoiceId)
    }
  }
  catch {
    // best-effort; swallow
  }
}
