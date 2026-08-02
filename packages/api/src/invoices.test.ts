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
      { customer_id: 'cus_1', subscription_id: 'sub_1', status: 'open' },
      { context },
    )

    // customer_id / subscription_id は Stripe のキー名に写像する。
    expect(captured).toStrictEqual({ customer: 'cus_1', subscription: 'sub_1', status: 'open' })
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
      collection_method: 'send_invoice',
      days_until_due: 30,
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

  it('metadata 未指定なら create に metadata を含めない', async () => {
    let capturedCreate: unknown
    const context = testContext({
      invoices: {
        create: (params: unknown) => {
          capturedCreate = params
          return Promise.resolve({ id: 'in_1' })
        },
        finalizeInvoice: () =>
          Promise.resolve({ id: 'in_1', hosted_invoice_url: 'https://pay.example/in_1' }),
      },
      invoiceItems: { create: () => Promise.resolve({}) },
    })

    await call(
      appRouter.invoices.create,
      { customer_id: 'cus_1', price_id: 'price_1' },
      { context },
    )

    // metadata キーが付かないことを toStrictEqual で保証する。
    expect(capturedCreate).toStrictEqual({
      customer: 'cus_1',
      collection_method: 'send_invoice',
      days_until_due: 30,
      auto_advance: false,
    })
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
