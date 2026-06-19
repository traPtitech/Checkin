import type Stripe from 'stripe'
import type { StripeClient } from './client'

/** Shared cursor-pagination inputs for the list adapters. */
export interface ListInput<Status extends string> {
  /** Optional Stripe status filter, passed through verbatim. */
  status?: Status
  /** Page size (already clamped by the domain before reaching the adapter). */
  limit: number
  /** Stripe cursor (`starting_after`) — the previous page's last object id. */
  startingAfter?: string
}

/** Status values accepted by `invoices.list`. */
export type InvoiceStatus = Stripe.InvoiceListParams.Status
/** Status values accepted by `checkout.sessions.list`. */
export type CheckoutSessionStatus = Stripe.Checkout.SessionListParams.Status

/**
 * Thin list wrappers over the Stripe SDK. They return the **raw** Stripe pages
 * so all Stripe types stay inside the adapter boundary; the `payments` domain
 * normalizes them into Stripe-independent DTOs.
 *
 * Reads only — no DB writes. They go through the lazy {@link StripeClient}, so a
 * missing `STRIPE_SECRET_KEY` only fails here, on actual use (existing policy).
 */

/**
 * List Invoices (請求書由来). `expand: ['data.customer']` so the normalizer can
 * read the customer name without an extra round-trip per row.
 */
export function listInvoices(
  stripe: StripeClient,
  input: ListInput<InvoiceStatus>,
): Promise<Stripe.ApiList<Stripe.Invoice>> {
  return stripe.sdk.invoices.list({
    status: input.status,
    limit: input.limit,
    starting_after: input.startingAfter,
    expand: ['data.customer'],
  })
}

/**
 * List Checkout Sessions (決済ページ由来). `expand: ['data.customer']` mirrors
 * the invoice path so the normalizer can resolve a customer name when present;
 * `expand: ['data.line_items.data.price']` surfaces the first line item's Price
 * so the normalizer can populate the row's `product` reference.
 */
export function listCheckoutSessions(
  stripe: StripeClient,
  input: ListInput<CheckoutSessionStatus>,
): Promise<Stripe.ApiList<Stripe.Checkout.Session>> {
  return stripe.sdk.checkout.sessions.list({
    status: input.status,
    limit: input.limit,
    starting_after: input.startingAfter,
    expand: ['data.customer', 'data.line_items.data.price'],
  })
}
