import type Stripe from 'stripe'
import type { InvoiceView } from '@checkin/api-contract'
import { pub } from './orpc'
import { idOf, traqIdOf } from './views'

/** Stripe の Invoice を allowlist の InvoiceView に変換する(公開フィールドを明示選択)。 */
function toInvoiceView(invoice: Stripe.Invoice): InvoiceView {
  return {
    id: invoice.id,
    status: invoice.status,
    amount_due: invoice.amount_due,
    amount_paid: invoice.amount_paid,
    amount_remaining: invoice.amount_remaining,
    created: invoice.created,
    customer: idOf(invoice.customer),
    metadata: traqIdOf(invoice.metadata),
  }
}

/** 請求プロシージャ — Stripe の Invoice を Checkin API として公開する。 */
export const invoicesRouter = {
  list: pub.invoices.list.handler(async ({ input, context }) => {
    const params: Stripe.InvoiceListParams = {}
    if (input.customer_id) params.customer = input.customer_id
    if (input.subscription_id) params.subscription = input.subscription_id
    if (input.status !== undefined) params.status = input.status
    if (input.collection_method !== undefined) params.collection_method = input.collection_method
    if (input.limit !== undefined) params.limit = input.limit
    if (input.starting_after !== undefined) params.starting_after = input.starting_after
    if (input.ending_before !== undefined) params.ending_before = input.ending_before

    const page = await context.stripe.invoices.list(params)
    return {
      has_more: page.has_more,
      data: page.data.map(toInvoiceView),
    }
  }),

  create: pub.invoices.create.handler(async ({ input, context }) => {
    // Invoice を作成 → 価格を項目として追加 → 確定して Stripe がホストする支払い URL を得る。
    // collection_method は明示的に send_invoice(リンク払い)に固定する。既定の
    // charge_automatically だと finalize 時点で顧客の既定支払い方法へ自動課金され得るが、
    // このエンドポイントは支払い URL を返すリンク払いを意図しているため。
    const invoice = await context.stripe.invoices.create({
      customer: input.customer_id,
      collection_method: 'send_invoice',
      // send_invoice には支払い期限が必須。会費請求の既定として30日を置く。
      days_until_due: 30,
      auto_advance: false,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })

    await context.stripe.invoiceItems.create({
      customer: input.customer_id,
      pricing: { price: input.price_id },
      invoice: invoice.id,
    })

    const finalized = await context.stripe.invoices.finalizeInvoice(invoice.id)
    if (finalized.hosted_invoice_url === null || finalized.hosted_invoice_url === undefined) {
      throw new Error('確定した Invoice に支払い URL がありません')
    }

    return { invoice_id: invoice.id, payment_url: finalized.hosted_invoice_url }
  }),
}
