import { call } from '@orpc/server'
import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'
import { stripeFixture, testContext } from './test-utils'

describe('invoices.list', () => {
  it('フィルタを Stripe のキー名に写像し、allowlist のフィールドだけを返す', async () => {
    let captured: unknown
    const context = testContext({
      invoices: {
        list: (params: unknown) => {
          captured = params
          return Promise.resolve({
            has_more: false,
            data: [
              stripeFixture<Stripe.Invoice>({
                id: 'in_1',
                status: 'open',
                amount_due: 1000,
                amount_paid: 0,
                amount_remaining: 1000,
                created: 1680000000,
                customer: 'cus_1',
                hosted_invoice_url: 'https://pay.example/in_1',
                metadata: { traq_id: 'inv', internal: 'secret' },
                // allowlist されない PII と内部キー。出力に出てはいけない。
                customer_email: 'secret@example.com',
                customer_name: 'Secret Name',
              }),
            ],
          })
        },
      },
    })

    const result = await call(
      appRouter.invoices.list,
      { customer: 'cus_1', subscription: 'sub_1', status: 'open' },
      { context },
    )

    // customer / subscription は Stripe のキー名に写像する。
    expect(captured).toStrictEqual({ customer: 'cus_1', subscription: 'sub_1', status: 'open' })
    // toStrictEqual で allowlist を厳密に検証: customer_email/customer_name/internal、
    // および bearer URL の hosted_invoice_url は一覧の出力に含まれない。
    expect(result.data[0]).toStrictEqual({
      id: 'in_1',
      status: 'open',
      amount_due: 1000,
      amount_paid: 0,
      amount_remaining: 1000,
      created: 1680000000,
      customer: 'cus_1',
    })
  })
})

describe('invoices.create', () => {
  it('Invoice を作成 → 価格を項目化 → 確定し、各呼び出しに派生冪等キーを付けて支払い URL を返す', async () => {
    const calls: {
      create?: unknown
      createOpts?: unknown
      item?: unknown
      itemOpts?: unknown
      finalize?: unknown
      finalizeOpts?: unknown
    } = {}
    const context = testContext({
      invoices: {
        create: (params: unknown, options: unknown) => {
          calls.create = params
          calls.createOpts = options
          return Promise.resolve({ id: 'in_1' })
        },
        finalizeInvoice: (id: unknown, _params: unknown, options: unknown) => {
          calls.finalize = id
          calls.finalizeOpts = options
          return Promise.resolve({ id: 'in_1', hosted_invoice_url: 'https://pay.example/in_1' })
        },
      },
      invoiceItems: {
        create: (params: unknown, options: unknown) => {
          calls.item = params
          calls.itemOpts = options
          return Promise.resolve({})
        },
      },
    })

    const result = await call(
      appRouter.invoices.create,
      { customer: 'cus_1', price: 'price_1', days_until_due: 14, idempotency_key: 'idem_1' },
      { context },
    )

    // send_invoice 固定、days_until_due は指定時のみ渡す。
    expect(calls.create).toStrictEqual({
      customer: 'cus_1',
      collection_method: 'send_invoice',
      auto_advance: false,
      days_until_due: 14,
    })
    // 価格は pricing.price に入れ、作成済み Invoice に項目を紐付ける。
    expect(calls.item).toStrictEqual({
      customer: 'cus_1',
      pricing: { price: 'price_1' },
      invoice: 'in_1',
    })
    expect(calls.finalize).toBe('in_1')
    // 冪等キーは3呼び出しすべてに派生キーで渡り、フロー全体をリトライ安全にする。
    expect(calls.createOpts).toStrictEqual({ idempotencyKey: 'idem_1:create' })
    expect(calls.itemOpts).toStrictEqual({ idempotencyKey: 'idem_1:item' })
    expect(calls.finalizeOpts).toStrictEqual({ idempotencyKey: 'idem_1:finalize' })
    expect(result).toStrictEqual({ invoice_id: 'in_1', payment_url: 'https://pay.example/in_1' })
  })

  it('days_until_due / idempotency_key 未指定なら create に含めず、冪等 option も渡さない', async () => {
    const calls: {
      create?: unknown
      createOpts?: unknown
      itemOpts?: unknown
      finalizeOpts?: unknown
    } = {}
    const context = testContext({
      invoices: {
        create: (params: unknown, options: unknown) => {
          calls.create = params
          calls.createOpts = options
          return Promise.resolve({ id: 'in_1' })
        },
        finalizeInvoice: (_id: unknown, _params: unknown, options: unknown) => {
          calls.finalizeOpts = options
          return Promise.resolve({ id: 'in_1', hosted_invoice_url: 'https://pay.example/in_1' })
        },
      },
      invoiceItems: {
        create: (_params: unknown, options: unknown) => {
          calls.itemOpts = options
          return Promise.resolve({})
        },
      },
    })

    await call(
      appRouter.invoices.create,
      { customer: 'cus_1', price: 'price_1' },
      { context },
    )

    expect(calls.create).toStrictEqual({
      customer: 'cus_1',
      collection_method: 'send_invoice',
      auto_advance: false,
    })
    expect(calls.createOpts).toBeUndefined()
    expect(calls.itemOpts).toBeUndefined()
    expect(calls.finalizeOpts).toBeUndefined()
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
        { customer: 'cus_1', price: 'price_1' },
        { context },
      ),
    ).rejects.toThrow()
  })
})
