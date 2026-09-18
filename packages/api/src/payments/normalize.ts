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

/**
 * Widen a value the Stripe types declare as always present to "may be absent at
 * runtime". Passing it through a call keeps TypeScript from narrowing the union
 * straight back away at the assignment, which is what makes the guards on the
 * result real rather than dead code.
 */
function maybeAbsent<T>(value: T): T | undefined {
  return value
}

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
  // Stripe's types declare `id`, `lines` and `payments` as always present. This
  // normalizer still reads them as possibly-absent: it renders one row of an
  // accountant listing, where a malformed object must degrade to a partial row
  // rather than throw for the whole page. `payments.test.ts` ("tolerates a
  // missing line / payments / status") exercises the absent-`payments` case
  // directly; `lines` and `id` are read under the same policy. `maybeAbsent` is
  // what makes the guards below type-necessary rather than dead code.
  const id = maybeAbsent(invoice.id)
  const lines = maybeAbsent(invoice.lines)
  const payments = maybeAbsent(invoice.payments)

  const line = lines?.data[0]
  // Stripe SDK 20.1.0 widened `pricing.price_details.price` from `string` to an
  // expandable `string | Price`. The adapter (`stripe/listing.ts`) never expands
  // it, so it is a string at runtime; read the id from whichever shape arrives.
  const price = line?.pricing?.price_details?.price ?? null
  const priceId = typeof price === 'string' ? price : (price?.id ?? null)

  // Latest InvoicePayment's payment_intent (when expanded to an object), else null.
  const latestPayment = payments?.data[0]?.payment.payment_intent ?? null
  const paymentId = typeof latestPayment === 'string' ? latestPayment : (latestPayment?.id ?? null)

  return {
    id: id ?? '',
    amount: invoice.amount_due,
    currency: invoice.currency,
    createdAt: new Date(invoice.created * 1000).toISOString(),
    customer: readCustomer(invoice.customer, invoice.customer_name),
    paymentStatus: invoice.status ?? 'unknown',
    paymentId,
    product: { priceId, description: line?.description ?? null },
    dashboardUrl: buildDashboardUrl(mode, 'invoice', id ?? ''),
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
  const lineItem = session.line_items?.data[0]
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
