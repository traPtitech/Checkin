import { call } from '@orpc/server'
import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'
import { stripeFixture, testContext } from './test-utils'

describe('invoices.list', () => {
  it('フィルタを Stripe のキー名に写像し、metadata を traq_id だけに絞る', async () => {
    let captured: unknown
    const context = testContext({
      invoices: {
        list: (params: unknown) => {
          captured = params
          return Promise.resolve({
            has_more: false,
            data: [stripeFixture<Stripe.Invoice>({ metadata: { traq_id: 'inv', internal: 'secret' } })],
          })
        },
      },
    })

    const result = await call(
      appRouter.invoices.list,
      { customer_id: 'cus_1', status: 'open' },
      { context },
    )

    expect(captured).toStrictEqual({ customer: 'cus_1', status: 'open' })
    expect(result.data[0]?.metadata).toStrictEqual({ traq_id: 'inv' })
  })
})

describe('invoices.create', () => {
  it('Invoice を作成 → 価格を項目化 → 確定して支払い URL を返す', async () => {
    const calls: { create?: unknown, finalize?: unknown, item?: unknown } = {}
    const context = testContext({
      invoices: {
        create: (params: unknown) => {
          calls.create = params
          return Promise.resolve({ id: 'in_1' })
        },
        finalizeInvoice: (id: unknown) => {
          calls.finalize = id
          return Promise.resolve({ id: 'in_1', hosted_invoice_url: 'https://pay.example/in_1' })
        },
      },
      invoiceItems: {
        create: (params: unknown) => {
          calls.item = params
          return Promise.resolve({})
        },
      },
    })

    const result = await call(
      appRouter.invoices.create,
      { customer_id: 'cus_1', price_id: 'price_1', metadata: { traq_id: 'z' } },
      { context },
    )

    expect(calls.create).toStrictEqual({
      customer: 'cus_1',
      auto_advance: false,
      metadata: { traq_id: 'z' },
    })
    // 価格は pricing.price に入れ、作成済み Invoice に項目を紐付ける。
    expect(calls.item).toStrictEqual({
      customer: 'cus_1',
      pricing: { price: 'price_1' },
      invoice: 'in_1',
    })
    expect(calls.finalize).toBe('in_1')
    expect(result).toStrictEqual({ invoice_id: 'in_1', payment_url: 'https://pay.example/in_1' })
  })

  it('確定した Invoice に支払い URL が無ければエラーにする', async () => {
    const context = testContext({
      invoices: {
        create: () => Promise.resolve({ id: 'in_1' }),
        finalizeInvoice: () => Promise.resolve({ id: 'in_1', hosted_invoice_url: null }),
      },
      invoiceItems: { create: () => Promise.resolve({}) },
    })

    await expect(
      call(
        appRouter.invoices.create,
        { customer_id: 'cus_1', price_id: 'price_1' },
        { context },
      ),
    ).rejects.toThrow()
  })
})
