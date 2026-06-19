/**
 * Jomon integration contract (OpenSpec change: add-payout-execution, design D1).
 *
 * Jomon owns approval/application of transfer requests; Checkin pulls the
 * **approved** ones, pays them out via Stripe Connect, and writes the result
 * back. Immediacy is not required, so the integration is pull-based.
 *
 * The domain depends only on these Jomon-type-free shapes; concrete drivers
 * (`stub` / `v1` / `v2`) live behind {@link JomonClient} and are selected by
 * configuration. (payout-execution spec: §Jomon アダプタ)
 */

/**
 * A single approved transfer request, normalized to a Jomon-type-free DTO.
 *
 * The payee is identified by `payeeEmail` (isct email), which the domain
 * resolves to a `users` row via `deriveMailHash`. The real recipient field is
 * unconfirmed against live Jomon and is mapped per driver (design §9, requires
 * Jomon coordination).
 */
export interface JomonTransferRequest {
  /** Opaque Jomon request id — the unique source/idempotency key. */
  jomonRef: string
  /** Payee's isct email; resolved to `mail_hash` for person identification. */
  payeeEmail: string
  /** Amount in the currency's smallest unit (jpy = whole yen). */
  amount: number
  /** ISO currency code, e.g. 'jpy'. */
  currency: string
}

/** Result written back to Jomon after a payout settles. */
export interface JomonWriteBackResult {
  /** Settled outcome of the payout. */
  status: 'paid' | 'failed'
  /** Stripe Transfer id, present on success. */
  stripeTransferId?: string
  /** Optional human-readable note (e.g. the failure reason). */
  message?: string
}

/**
 * Jomon client abstraction. The domain calls only these two operations:
 *   - fetch approved transfer requests,
 *   - write a settled payout result back.
 * Checkin→Jomon auth is a one-way Bearer service token (env). (design D1)
 */
export interface JomonClient {
  /** Fetch the currently approved transfer requests awaiting payout. */
  listApprovedTransferRequests(): Promise<JomonTransferRequest[]>
  /** Write a settled payout result back to Jomon for `jomonRef`. */
  writeBackResult(jomonRef: string, result: JomonWriteBackResult): Promise<void>
}
