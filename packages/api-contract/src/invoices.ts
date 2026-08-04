import { oc } from '@orpc/contract'
import { z } from 'zod'
import { listEnvelope, pagination } from './params'

/**
 * Invoice の公開 View。出力 allowlist の方針は project.md 参照。Invoice は customer_email 等の
 * PII やネストした metadata(lines[].metadata 等)を含むため、透過には特に注意する。customer は
 * ID のみ。traq_id は出力に含めない(project.md / #18)。
 *
 * hosted_invoice_url は一覧には含めない。認証不要で請求内容の閲覧・支払いができる bearer URL の
 * ため。発行時は issue の paymentUrl として返す。
 */
const invoiceView = z.object({
  id: z.string(),
  status: z.string().nullable(),
  amountDue: z.number(),
  amountPaid: z.number(),
  amountRemaining: z.number(),
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
        collectionMethod: z.enum(['charge_automatically', 'send_invoice']).optional(),
        ...pagination,
      }),
    )
    .output(listEnvelope(invoiceView)),

  // 指定した顧客に価格を1項目として請求する Invoice を作成・確定(発行)し、支払い URL を返す。
  // create ではなく issue: このプロシージャは下書き作成でなく、支払い可能な請求の発行という
  // 金銭的な確定操作であることを名前で表す。
  issue: oc
    .input(
      z.object({
        customer: z.string().min(1),
        price: z.string().min(1),
        // 支払い期限(日数)。collection_method を send_invoice に固定しており、Stripe は
        // send_invoice の Invoice 確定時に支払い期限を要求するため必須。
        daysUntilDue: z.number().int().min(0).max(365),
        // リトライ安全のための冪等キー(クライアント生成)。多段フロー全体を安全に再試行できるよう
        // 必須にする。派生キーの suffix 予約分(最大9文字)を Stripe の 255 文字上限内に収めるため、
        // 246 文字までに制限する。
        idempotencyKey: z.string().min(1).max(246),
      }),
    )
    .output(
      z.object({
        invoiceId: z.string(),
        paymentUrl: z.string(),
      }),
    ),
}
