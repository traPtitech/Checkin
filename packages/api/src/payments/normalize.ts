import type Stripe from 'stripe'
import { buildDashboardUrl, type StripeMode } from './dashboard'
import type { PaymentRow } from './types'

/**
 * Normalizers: Stripe object → {@link PaymentRow}. They accept the Stripe object
 * **types** (so callers stay type-checked) but only read plain fields and OUTPUT
 * plain DTOs — they never call the Stripe SDK. That keeps `payments/` importable
 * without pulling in any Stripe runtime, while the adapter (`stripe/listing.ts`)
 * remains the only place that talks to Stripe.
 */

/** Read the customer id + name from an expandable customer field. */
function readCustomer(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
  fallbackName?: string | null,
): { id: string | null, name?: string | null } {
  if (customer === null) {
    return { id: null, name: fallbackName ?? null }
  }
  if (typeof customer === 'string') {
    return { id: customer, name: fallbackName ?? null }
  }
  // Expanded object: deleted customers carry no name.
  const name = 'deleted' in customer && customer.deleted ? null : (customer.name ?? null)
  return { id: customer.id, name: name ?? fallbackName ?? null }
}

/**
 * Map a Stripe Invoice to a {@link PaymentRow} (tasks 2.2). Amount uses
 * `amount_due` (the invoiced total); the Price comes from the (single) line
 * item's `pricing.price_details`. `paymentId` is the latest payment's intent id
 * when present (Stripe v18 moved it under `payments`).
 */
export function invoiceToRow(invoice: Stripe.Invoice, mode: StripeMode): PaymentRow {
  const line = invoice.lines?.data?.[0]
  const priceId = line?.pricing?.price_details?.price ?? null

  // Latest InvoicePayment's payment_intent (when expanded to an object), else null.
  const latestPayment = invoice.payments?.data?.[0]?.payment?.payment_intent ?? null
  const paymentId = typeof latestPayment === 'string' ? latestPayment : (latestPayment?.id ?? null)

  return {
    id: invoice.id ?? '',
    amount: invoice.amount_due,
    currency: invoice.currency,
    createdAt: new Date(invoice.created * 1000).toISOString(),
    customer: readCustomer(invoice.customer, invoice.customer_name),
    paymentStatus: invoice.status ?? 'unknown',
    paymentId,
    product: { priceId, description: line?.description ?? null },
    dashboardUrl: buildDashboardUrl(mode, 'invoice', invoice.id ?? ''),
  }
}

/**
 * Map a Stripe Checkout Session to a {@link PaymentRow} (tasks 2.3). Amount uses
 * `amount_total`, status uses `payment_status`, and the payment id is the
 * `payment_intent` (string or expanded id).
 */
export function checkoutSessionToRow(
  session: Stripe.Checkout.Session,
  mode: StripeMode,
): PaymentRow {
  const intent = session.payment_intent
  const paymentId = typeof intent === 'string' ? intent : (intent?.id ?? null)

  // Price comes from the first expanded line item (adapter requests
  // `expand: ['data.line_items.data.price']`). When line items are absent /
  // unexpanded we return explicit nulls so the DTO shape stays complete.
  const lineItem = session.line_items?.data?.[0]
  const product = lineItem
    ? {
        priceId: lineItem.price?.id ?? null,
        description: lineItem.description ?? lineItem.price?.nickname ?? null,
      }
    : { priceId: null, description: null }

  return {
    id: session.id,
    amount: session.amount_total ?? 0,
    currency: session.currency ?? 'unknown',
    createdAt: new Date(session.created * 1000).toISOString(),
    customer: readCustomer(session.customer, session.customer_details?.name),
    paymentStatus: session.payment_status,
    paymentId,
    product,
    dashboardUrl: buildDashboardUrl(mode, 'checkout-session', session.id),
  }
}
