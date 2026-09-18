import type { StripeClient } from './client'

/** Inputs for a Stripe Connect transfer from the platform to a connected account. */
export interface CreateTransferInput {
  /** Destination connected account id (the payee's, resolved via onboarding). */
  destinationAccountId: string
  /** Amount in the currency's smallest unit (jpy = whole yen). */
  amount: number
  /** ISO currency code, e.g. 'jpy'. */
  currency: string
  /**
   * Idempotency key — `payout:${jomonRef}`. A retry with the same key returns
   * the original Transfer instead of creating a second one, so re-runs never
   * double-pay. (payout-execution spec: §再実行は二重送金しない)
   */
  idempotencyKey: string
  /** Optional non-PII metadata for the Stripe dashboard (e.g. jomon_ref). */
  metadata?: Record<string, string>
}

/**
 * Create a Stripe Connect transfer (platform → connected account) and return
 * its id. Stripe types stay inside this adapter; the domain sees only the plain
 * `{ transferId }`. (design D3)
 */
export async function createTransfer(
  stripe: StripeClient,
  input: CreateTransferInput,
): Promise<{ transferId: string }> {
  const transfer = await stripe.sdk.transfers.create(
    {
      amount: input.amount,
      currency: input.currency,
      destination: input.destinationAccountId,
      metadata: input.metadata,
    },
    { idempotencyKey: input.idempotencyKey },
  )
  return { transferId: transfer.id }
}
