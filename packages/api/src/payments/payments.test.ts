import { describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { buildDashboardUrl, modeFromSecretKey } from './dashboard'
import { clampLimit, nextCursor } from './pagination'
import { checkoutSessionToRow, invoiceToRow } from './normalize'

/**
 * Representative plain objects shaped like the Stripe responses. We cast through
 * `unknown` to the Stripe types so the normalizers stay type-checked without us
 * having to spell out every (unused) Stripe field — the normalizers only ever
 * read the handful of fields exercised here.
 */
function makeInvoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: 'in_123',
    amount_due: 4000,
    currency: 'jpy',
    created: 1_700_000_000, // 2023-11-14T22:13:20.000Z
    status: 'open',
    customer: { id: 'cus_1', name: 'Alice', object: 'customer' },
    customer_name: null,
    lines: {
      data: [
        {
          description: '新規入部費・前期',
          pricing: { price_details: { price: 'price_abc', product: 'prod_abc' } },
        },
      ],
    },
    payments: {
      data: [
        { payment: { payment_intent: 'pi_123' } },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Invoice
}

function makeSession(
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    id: 'cs_123',
    amount_total: 2000,
    currency: 'jpy',
    created: 1_700_000_000,
    payment_status: 'paid',
    payment_intent: 'pi_456',
    customer: 'cus_2',
    customer_details: { name: 'Bob' },
    ...overrides,
  } as unknown as Stripe.Checkout.Session
}

describe('invoiceToRow', () => {
  it('normalizes an invoice into a PaymentRow', () => {
    const row = invoiceToRow(makeInvoice(), 'test')
    expect(row).toEqual({
      id: 'in_123',
      amount: 4000,
      currency: 'jpy',
      createdAt: '2023-11-14T22:13:20.000Z',
      customer: { id: 'cus_1', name: 'Alice' },
      paymentStatus: 'open',
      paymentId: 'pi_123',
      product: { priceId: 'price_abc', description: '新規入部費・前期' },
      dashboardUrl: 'https://dashboard.stripe.com/test/invoices/in_123',
    })
  })

  it('falls back to customer_name and a string customer id', () => {
    const row = invoiceToRow(
      makeInvoice({ customer: 'cus_str', customer_name: 'Carol' }),
      'live',
    )
    expect(row.customer).toEqual({ id: 'cus_str', name: 'Carol' })
    expect(row.dashboardUrl).toBe('https://dashboard.stripe.com/invoices/in_123')
  })

  it('tolerates a missing line / payments / status', () => {
    const row = invoiceToRow(
      makeInvoice({ status: null, lines: { data: [] } as never, payments: undefined }),
      'test',
    )
    expect(row.product).toEqual({ priceId: null, description: null })
    expect(row.paymentId).toBeNull()
    expect(row.paymentStatus).toBe('unknown')
  })

  it('drops the name for a deleted (expanded) customer', () => {
    const row = invoiceToRow(
      makeInvoice({ customer: { id: 'cus_del', deleted: true, object: 'customer' } as never }),
      'test',
    )
    expect(row.customer).toEqual({ id: 'cus_del', name: null })
  })
})

describe('checkoutSessionToRow', () => {
  it('normalizes a session into a PaymentRow', () => {
    const row = checkoutSessionToRow(makeSession(), 'test')
    expect(row).toEqual({
      id: 'cs_123',
      amount: 2000,
      currency: 'jpy',
      createdAt: '2023-11-14T22:13:20.000Z',
      customer: { id: 'cus_2', name: 'Bob' },
      paymentStatus: 'paid',
      paymentId: 'pi_456',
      // No expanded line_items → explicit nulls (not {}), so the DTO is complete.
      product: { priceId: null, description: null },
      dashboardUrl: 'https://dashboard.stripe.com/test/checkout/sessions/cs_123',
    })
  })

  it('maps the first expanded line item to product (price id + description)', () => {
    const row = checkoutSessionToRow(
      makeSession({
        line_items: {
          data: [
            {
              description: '部費（決済ページ）',
              price: { id: 'price_cs', nickname: '部費' },
            },
          ],
        } as never,
      }),
      'test',
    )
    expect(row.product).toEqual({ priceId: 'price_cs', description: '部費（決済ページ）' })
  })

  it('falls back to the price nickname when the line item has no description', () => {
    const row = checkoutSessionToRow(
      makeSession({
        line_items: {
          data: [
            {
              description: null,
              price: { id: 'price_cs', nickname: '継続特別' },
            },
          ],
        } as never,
      }),
      'test',
    )
    expect(row.product).toEqual({ priceId: 'price_cs', description: '継続特別' })
  })

  it('returns explicit null product fields when line items are absent', () => {
    const row = checkoutSessionToRow(makeSession({ line_items: undefined }), 'test')
    expect(row.product).toEqual({ priceId: null, description: null })
  })

  it('handles a null amount / currency / customer and an expanded intent', () => {
    const row = checkoutSessionToRow(
      makeSession({
        amount_total: null,
        currency: null,
        customer: null,
        customer_details: null,
        payment_intent: { id: 'pi_exp' } as never,
      }),
      'live',
    )
    expect(row.amount).toBe(0)
    expect(row.currency).toBe('unknown')
    expect(row.customer).toEqual({ id: null, name: null })
    expect(row.paymentId).toBe('pi_exp')
    expect(row.dashboardUrl).toBe('https://dashboard.stripe.com/checkout/sessions/cs_123')
  })
})

describe('buildDashboardUrl', () => {
  it('includes /test/ for invoices in test mode', () => {
    expect(buildDashboardUrl('test', 'invoice', 'in_1'))
      .toBe('https://dashboard.stripe.com/test/invoices/in_1')
  })

  it('omits /test/ for invoices in live mode', () => {
    expect(buildDashboardUrl('live', 'invoice', 'in_1'))
      .toBe('https://dashboard.stripe.com/invoices/in_1')
  })

  it('includes /test/ for checkout sessions in test mode', () => {
    expect(buildDashboardUrl('test', 'checkout-session', 'cs_1'))
      .toBe('https://dashboard.stripe.com/test/checkout/sessions/cs_1')
  })

  it('omits /test/ for checkout sessions in live mode', () => {
    expect(buildDashboardUrl('live', 'checkout-session', 'cs_1'))
      .toBe('https://dashboard.stripe.com/checkout/sessions/cs_1')
  })
})

describe('modeFromSecretKey', () => {
  it('treats sk_test_ / rk_test_ keys as test', () => {
    expect(modeFromSecretKey('sk_test_abc')).toBe('test')
    expect(modeFromSecretKey('rk_test_abc')).toBe('test')
  })

  it('treats live keys (and anything else) as live', () => {
    expect(modeFromSecretKey('sk_live_abc')).toBe('live')
    expect(modeFromSecretKey('')).toBe('live')
  })
})

describe('clampLimit', () => {
  it('defaults to 20 when unset', () => {
    expect(clampLimit()).toBe(20)
  })

  it('clamps below 1 up to 1', () => {
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(-5)).toBe(1)
  })

  it('clamps above 100 down to 100', () => {
    expect(clampLimit(250)).toBe(100)
  })

  it('passes through and floors in-range values', () => {
    expect(clampLimit(50)).toBe(50)
    expect(clampLimit(20.9)).toBe(20)
  })
})

describe('nextCursor', () => {
  it('returns the last id when hasMore is true', () => {
    expect(nextCursor([{ id: 'a' }, { id: 'b' }], true)).toBe('b')
  })

  it('returns null when hasMore is false', () => {
    expect(nextCursor([{ id: 'a' }, { id: 'b' }], false)).toBeNull()
  })

  it('returns null when there are no items even if hasMore is true', () => {
    expect(nextCursor([], true)).toBeNull()
  })
})
