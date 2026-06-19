/**
 * Stripe-independent row DTO for the accountant payments listing
 * (payment-listing spec: §行項目の正規化 / design D2). Every field here is a
 * plain JSON value so the Stripe SDK never leaks past the adapter boundary.
 */
export interface PaymentRow {
  /** The Stripe object id (invoice id or checkout session id). */
  id: string
  /** Amount in the currency's smallest unit (e.g. JPY: yen). */
  amount: number
  /** ISO 4217 currency code (lowercase, as Stripe returns it). */
  currency: string
  /** Creation time as an ISO 8601 string. */
  createdAt: string
  /** Customer reference: id, and name when it could be resolved. */
  customer: { id: string | null, name?: string | null }
  /** Payment state — `invoice.status` or session `payment_status`. */
  paymentStatus: string
  /** The payment object id (e.g. payment_intent), or null when none. */
  paymentId: string | null
  /** Product (Price) reference, when present on the object. */
  product: { priceId?: string | null, description?: string | null }
  /** Absolute Stripe Dashboard URL for the object (test/live aware). */
  dashboardUrl: string
}

/** One cursor page of {@link PaymentRow}s (design D2). */
export interface PaymentPage {
  items: PaymentRow[]
  /** Whether Stripe reports more rows beyond this page (`has_more`). */
  hasMore: boolean
  /** Cursor for the next page (`starting_after`), or null when none. */
  nextCursor: string | null
}
