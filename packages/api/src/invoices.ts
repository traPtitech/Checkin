import type Stripe from 'stripe'
import { pub } from './orpc'
import { narrowMetadata } from './views'

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
      data: page.data.map(invoice => narrowMetadata(invoice)),
    }
  }),

  create: pub.invoices.create.handler(async ({ input, context }) => {
    // Invoice を作成 → 価格を項目として追加 → 確定してホスト支払い URL を得る。
    const invoice = await context.stripe.invoices.create({
      customer: input.customer_id,
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
