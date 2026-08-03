import { oc } from '@orpc/contract'
import { z } from 'zod'
import { pagination, writableMetadata } from './params'

/**
 * Invoice の公開形。Invoice は customer_email 等の PII やネストした metadata
 * (lines[].metadata 等)を含むため、Stripe オブジェクトを透過せず、公開する
 * フィールドを allowlist で明示する。customer は ID のみ(PII オブジェクトは出さない)、
 * metadata は traq_id のみ。実装は @checkin/api で各フィールドを明示的に組み立てる。
 *
 * hosted_invoice_url は一覧には含めない。これは認証不要で請求内容の閲覧・支払いが
 * できる bearer URL であり、一覧で配る必要がない(send_invoice では Stripe が顧客へ
 * メールでリンクを送る。作成時は create の payment_url で返す)。
 */
const invoiceView = z.object({
  id: z.string(),
  // 出力は Stripe の値をそのまま公開する(将来 Stripe が追加する status で
  // 落ちないよう enum で狭めない)。入力フィルタ側は enum で狭める。
  status: z.string().nullable(),
  amount_due: z.number(),
  amount_paid: z.number(),
  amount_remaining: z.number(),
  created: z.number(),
  customer: z.string().nullable(),
  metadata: z.object({ traq_id: z.string().optional() }),
})

export type InvoiceView = z.infer<typeof invoiceView>

export const invoicesContract = {
  // 一覧。入力は選択的透過(params.ts 参照)。各要素は allowlist の InvoiceView。
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
        data: z.array(invoiceView),
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
