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
 * The payee is identified by `payeeTraqId` (traQ ID), which the domain resolves
 * to a `users` row via `getUserByTraqId` (the `users.traq_id` linked at traQ
 * login). Jomon carries the payee as a traQ ID: v1 exposes it directly
 * (`repaid_to_user.trap_id`); v2 carries a User UUID (`ApplicationTarget.target`)
 * which the v2 driver resolves to a traQ username via `GET /api/users`. Currency
 * is always `'jpy'` (Jomon has no currency concept). (design D1)
 */
export interface JomonTransferRequest {
  /** Opaque Jomon request id — the unique source/idempotency key. */
  jomonRef: string
  /** Payee's traQ ID; resolved to a `users` row for person identification. */
  payeeTraqId: string
  /** Amount in the currency's smallest unit (jpy = whole yen). */
  amount: number
  /** ISO currency code; always `'jpy'` for Jomon. */
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
