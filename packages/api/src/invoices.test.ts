import { call } from '@orpc/server'
import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'
import { stripeFixture, testContext } from './test-utils'

describe('invoices.list', () => {
  it('フィルタを Stripe のキー名に対応づけ、allowlist のフィールドだけを返す', async () => {
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
      { customer: 'cus_1', subscription: 'sub_1', status: 'open', collectionMethod: 'send_invoice' },
      { context },
    )

    // 入力の collectionMethod は Stripe のキー名 collection_method へ写像して透過する。
    expect(captured).toStrictEqual({
      customer: 'cus_1',
      subscription: 'sub_1',
      status: 'open',
      collection_method: 'send_invoice',
    })
    // toStrictEqual で allowlist を厳密に検証: customer_email/customer_name/internal、
    // および bearer URL の hosted_invoice_url は一覧の出力に含まれない。
    expect(result.data[0]).toStrictEqual({
      id: 'in_1',
      status: 'open',
      amountDue: 1000,
      amountPaid: 0,
      amountRemaining: 1000,
      created: 1680000000,
      customer: 'cus_1',
    })
    // toListResponse 経由の一覧レスポンス(has_more:false なら nextCursor:null)に配線されていることを確認。
    expect(result.nextCursor).toBeNull()
  })

  it('customer が展開オブジェクトや null でも ID(または null)に正規化する', async () => {
    const context = testContext({
      invoices: {
        list: () =>
          Promise.resolve({
            has_more: false,
            data: [
              // 展開された Customer オブジェクト(PII 入り)が来ても ID だけを返す。
              stripeFixture<Stripe.Invoice>({
                id: 'in_1',
                status: 'paid',
                amount_due: 0,
                amount_paid: 1000,
                amount_remaining: 0,
                created: 1,
                customer: stripeFixture<Stripe.Customer>({
                  id: 'cus_9',
                  email: 'leak@example.com',
                  name: 'Leak',
                }),
              }),
              // customer 無し(null)。
              stripeFixture<Stripe.Invoice>({
                id: 'in_2',
                status: 'draft',
                amount_due: 0,
                amount_paid: 0,
                amount_remaining: 0,
                created: 2,
                customer: null,
              }),
            ],
          }),
      },
    })

    const result = await call(appRouter.invoices.list, {}, { context })

    expect(result.data[0]?.customer).toBe('cus_9')
    // email/name が出力に一切現れない。
    expect(result.data[0]).toStrictEqual({
      id: 'in_1',
      status: 'paid',
      amountDue: 0,
      amountPaid: 1000,
      amountRemaining: 0,
      created: 1,
      customer: 'cus_9',
    })
    expect(result.data[1]?.customer).toBeNull()
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
      { customer: 'cus_1', price: 'price_1', daysUntilDue: 14, idempotencyKey: 'idem_1' },
      { context },
    )

    // send_invoice 固定、days_until_due は必須で常に渡す。
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
    expect(result).toStrictEqual({ invoiceId: 'in_1', paymentUrl: 'https://pay.example/in_1' })
  })

  it('daysUntilDue:0(即時期限)も 0 のまま create に渡す', async () => {
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
      { customer: 'cus_1', price: 'price_1', daysUntilDue: 0, idempotencyKey: 'idem_1' },
      { context },
    )

    // 0 は falsy だが正当な入力。truthy 判定への退行で黙って落ちないことを固定する。
    expect(capturedCreate).toStrictEqual({
      customer: 'cus_1',
      collection_method: 'send_invoice',
      auto_advance: false,
      days_until_due: 0,
    })
  })

  it('daysUntilDue 未指定は reject する(send_invoice 固定のため必須)', async () => {
    const context = testContext({
      invoices: { create: () => Promise.resolve({ id: 'in_1' }) },
      invoiceItems: { create: () => Promise.resolve({}) },
    })

    await expect(
      call(
        appRouter.invoices.create,
        // @ts-expect-error daysUntilDue は必須のため意図的に省略している
        { customer: 'cus_1', price: 'price_1', idempotencyKey: 'idem_1' },
        { context },
      ),
    ).rejects.toThrow()
  })

  it('mutationsEnabled が false なら作成を拒否する(認可導入までの暫定ガード)', async () => {
    const context = testContext({ invoices: { create: () => Promise.resolve({ id: 'in_1' }) } }, false)

    await expect(
      call(
        appRouter.invoices.create,
        { customer: 'cus_1', price: 'price_1', daysUntilDue: 14, idempotencyKey: 'idem_1' },
        { context },
      ),
    ).rejects.toThrow()
  })

  // 実装は hosted_invoice_url の null と undefined の両方をエラーにする。両ケースを個別に検証する。
  it.each([
    ['null', null],
    ['undefined(プロパティ不在)', undefined],
  ])('確定した Invoice の支払い URL が %s ならエラーにする', async (_label, url) => {
    const context = testContext({
      invoices: {
        create: () => Promise.resolve({ id: 'in_1' }),
        // url が undefined のケースは hosted_invoice_url キー自体を含めないオブジェクトを返す。
        finalizeInvoice: () =>
          Promise.resolve(url === undefined ? { id: 'in_1' } : { id: 'in_1', hosted_invoice_url: url }),
      },
      invoiceItems: { create: () => Promise.resolve({}) },
    })

    await expect(
      call(
        appRouter.invoices.create,
        { customer: 'cus_1', price: 'price_1', daysUntilDue: 14, idempotencyKey: 'idem_1' },
        { context },
      ),
    ).rejects.toThrow()
  })
})
