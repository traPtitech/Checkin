import { oc } from '@orpc/contract'
import { z } from 'zod'
import type Stripe from 'stripe'
import { pagination, writableMetadata } from './params'
import type { WithTraqId } from './views'

/** Stripe の Invoice を Checkin の公開形にした型(metadata を traq_id に絞る)。 */
export type InvoiceView = WithTraqId<Stripe.Invoice>

export const invoicesContract = {
  // 一覧。入力は選択的透過(params.ts 参照)。各要素は InvoiceView。
  list: oc
    .input(
      z.object({
        customer_id: z.string().min(1).optional(),
        subscription_id: z.string().min(1).optional(),
        status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']).optional(),
        collection_method: z.enum(['charge_automatically', 'send_invoice']).optional(),
        ...pagination,
      }),
    )
    .output(
      z.object({
        has_more: z.boolean(),
        data: z.array(z.custom<InvoiceView>()),
      }),
    ),

  // 指定した顧客に価格を1項目として請求する Invoice を作成・確定し、支払い URL を返す。
  create: oc
    .input(
      z.object({
        customer_id: z.string().min(1),
        price_id: z.string().min(1),
        metadata: writableMetadata,
      }),
    )
    .output(
      z.object({
        invoice_id: z.string(),
        payment_url: z.string(),
      }),
    ),
}
