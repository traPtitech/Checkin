import { describe, expect, it, vi } from 'vitest'
import type { StripeClient } from './client'
import { createDraftInvoice } from './invoices'

/**
 * Adapter-level test for `createDraftInvoice`: it must offer BOTH card and bank
 * transfer (口座振込) on the issued invoice. We assert the exact `invoices.create`
 * payload (the bank-transfer `payment_settings`) rather than calling Stripe.
 * The domain/ledger order is covered elsewhere; here we pin the payment methods.
 */

/** The subset of the `invoices.create` payload this test inspects. */
interface InvoiceCreateParams {
  customer: string
  collection_method: string
  payment_settings: {
    payment_method_types: string[]
    payment_method_options: {
      customer_balance: { bank_transfer: { type: string }, funding_type: string }
    }
  }
}

/** The subset of the `invoiceItems.create` payload this test inspects. */
interface InvoiceItemParams {
  customer: string
  invoice: string
  pricing: { price: string }
}

/** Minimal Stripe fake exposing only what `createDraftInvoice` touches. */
function fakeStripe() {
  const create = vi.fn(async (_params: InvoiceCreateParams) => ({ id: 'in_test_123' }))
  const itemCreate = vi.fn(async (_params: InvoiceItemParams) => ({ id: 'ii_test_123' }))
  const del = vi.fn(async (_id: string) => ({}))
  const sdk = {
    invoices: { create, del },
    invoiceItems: { create: itemCreate },
  }
  return { stripe: { sdk } as unknown as StripeClient, create, itemCreate, del }
}

describe('createDraftInvoice', () => {
  it('offers card and bank transfer (jp_bank_transfer via customer_balance)', async () => {
    const { stripe, create } = fakeStripe()

    await createDraftInvoice(stripe, {
      customerId: 'cus_abc',
      priceId: 'price_xyz',
      daysUntilDue: 30,
      metadata: { activityYear: '2026' },
    })

    expect(create).toHaveBeenCalledTimes(1)
    const arg = create.mock.calls[0]![0]
    expect(arg.payment_settings.payment_method_types).toEqual(['card', 'customer_balance'])
    expect(arg.payment_settings.payment_method_options.customer_balance).toEqual({
      bank_transfer: { type: 'jp_bank_transfer' },
      funding_type: 'bank_transfer',
    })
    // The base invoice shape (send_invoice collection) is preserved.
    expect(arg.collection_method).toBe('send_invoice')
    expect(arg.customer).toBe('cus_abc')
  })

  it('attaches the chosen price as the single line item', async () => {
    const { stripe, itemCreate } = fakeStripe()

    await createDraftInvoice(stripe, {
      customerId: 'cus_abc',
      priceId: 'price_xyz',
      daysUntilDue: 30,
    })

    expect(itemCreate).toHaveBeenCalledTimes(1)
    const arg = itemCreate.mock.calls[0]![0]
    expect(arg.customer).toBe('cus_abc')
    expect(arg.invoice).toBe('in_test_123')
    expect(arg.pricing).toEqual({ price: 'price_xyz' })
  })

  it('deletes the orphaned draft if creating the line item fails', async () => {
    const { stripe, itemCreate, del } = fakeStripe()
    itemCreate.mockRejectedValueOnce(new Error('item boom'))

    await expect(
      createDraftInvoice(stripe, { customerId: 'cus_abc', priceId: 'price_xyz', daysUntilDue: 30 }),
    ).rejects.toThrow('item boom')

    expect(del).toHaveBeenCalledWith('in_test_123')
  })
})
