import { oc } from '@orpc/contract'
import { z } from 'zod'
import { listEnvelope, pagination } from './params'

/**
 * 会計担当者向けの入出金一覧の 1 行の公開 View。出力 allowlist の方針は project.md 参照。
 *
 * customer に name を載せている。invoices.list の InvoiceView は customer を ID のみに
 * しているので、同じ Stripe Invoice に対して 2 つの公開範囲が並ぶ。並ぶ理由は消費者が
 * 違うことで、invoices.list は Stripe の Invoice を薄く包む管理・配管層、この capability は
 * 会計担当者向けの画面である。会計担当者の画面には顧客名が要るという判断による。
 * どちらか一方に揃えると、揃えた側の消費者が必要とする情報を失うか、必要としていない
 * 側の公開範囲を広げることになる。
 *
 * paymentStatus は Stripe 由来の値(invoice.status または session の payment_status)を
 * そのまま透過するので enum で狭めない。Stripe が値を足したときに出力検証で弾かないため。
 */
const paymentView = z.object({
  id: z.string(),
  // 通貨の最小単位での金額(日本円なら円)。
  amount: z.number(),
  // ISO 4217 の通貨コード。Stripe が返す小文字のまま。
  currency: z.string(),
  createdAt: z.iso.datetime(),
  // 顧客の参照。name は解決できたときだけ付く。
  customer: z.object({
    id: z.string().nullable(),
    name: z.string().nullable().optional(),
  }),
  paymentStatus: z.string(),
  // 決済オブジェクトの id(payment_intent 等)。無ければ null。
  paymentId: z.string().nullable(),
  // 商品(Price)の参照。オブジェクトに載っているときだけ付く。
  product: z.object({
    priceId: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  }),
  // Stripe ダッシュボードの絶対 URL(test/live を見分けて組み立てる)。
  dashboardUrl: z.string(),
})

export type PaymentView = z.infer<typeof paymentView>

export const paymentsContract = {
  // 請求書由来(Stripe Invoices)の一覧。status は入力フィルタなので enum で狭める。
  listInvoices: oc
    .input(
      z.object({
        status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']).optional(),
        ...pagination,
      }),
    )
    .output(listEnvelope(paymentView)),

  // 決済ページ由来(Stripe Checkout Sessions)の一覧。
  listCheckoutSessions: oc
    .input(
      z.object({
        status: z.enum(['open', 'complete', 'expired']).optional(),
        ...pagination,
      }),
    )
    .output(listEnvelope(paymentView)),
}
