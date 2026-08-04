import { oc } from '@orpc/contract'
import { z } from 'zod'
import { listEnvelope, pagination } from './params'

/**
 * Invoice の公開形。Invoice は customer_email 等の PII やネストした metadata
 * (lines[].metadata 等)を含むため、Stripe オブジェクトを透過せず、公開する
 * フィールドを allowlist で明示する。customer は ID のみ(PII オブジェクトは出さない)。
 * traq_id は出力に含めない(同定データは DB を単一ソースとする方針。project.md / #18)。
 *
 * hosted_invoice_url は一覧には含めない。これは認証不要で請求内容の閲覧・支払いが
 * できる bearer URL のため。作成時は create の payment_url として返す。
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
})

export type InvoiceView = z.infer<typeof invoiceView>

export const invoicesContract = {
  // 一覧。入力は選択的透過(params.ts 参照)。各要素は allowlist の InvoiceView。
  list: oc
    .input(
      z.object({
        customer: z.string().min(1).optional(),
        subscription: z.string().min(1).optional(),
        status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']).optional(),
        collection_method: z.enum(['charge_automatically', 'send_invoice']).optional(),
        ...pagination,
      }),
    )
    .output(listEnvelope(invoiceView)),

  // 指定した顧客に価格を1項目として請求する Invoice を作成・確定し、支払い URL を返す。
  create: oc
    .input(
      z.object({
        customer: z.string().min(1),
        price: z.string().min(1),
        // 支払い期限(日数)。collection_method を send_invoice に固定しており、Stripe は
        // send_invoice の Invoice 確定時に支払い期限を要求するため必須。
        days_until_due: z.number().int().min(0).max(365),
        // リトライ安全のための冪等キー(クライアント生成)。多段フロー全体を安全に
        // 再試行できるよう必須にする。認可導入後はサーバ側で名前空間化する(#15)。
        // 実装は末尾に ":finalize"(9文字)等の suffix を連結して Stripe に渡すため、
        // Stripe の上限 255 文字を超えないよう 246 文字までに制限する。
        idempotency_key: z.string().min(1).max(246),
      }),
    )
    .output(
      z.object({
        invoice_id: z.string(),
        payment_url: z.string(),
      }),
    ),
}
