import { oc } from '@orpc/contract'
import { z } from 'zod'
import { pagination } from './params'

/**
 * Checkout Session の公開形。Session は customer_details 等の PII を含むため、
 * Stripe オブジェクトを透過せず、公開するフィールドを allowlist で明示する。
 * customer / payment_intent は ID のみ。traq_id は自前 DB を単一ソースとするため
 * 出力に含めない(#18)。実装は @checkin/api で各フィールドを明示的に組み立てる。
 */
const checkoutSessionView = z.object({
  id: z.string(),
  // 出力は Stripe の値をそのまま公開する(将来の status で落ちないよう enum で狭めない)。
  status: z.string().nullable(),
  amount_total: z.number().nullable(),
  amount_subtotal: z.number().nullable(),
  created: z.number(),
  customer: z.string().nullable(),
  payment_intent: z.string().nullable(),
})

export type CheckoutSessionView = z.infer<typeof checkoutSessionView>

export const checkoutContract = {
  // Stripe SDK の stripe.checkout.sessions.list に合わせた構造(checkout.sessions.list)。
  sessions: {
    // 一覧。入力は選択的透過(params.ts 参照)。各要素は allowlist の View。
    list: oc
      .input(
        z.object({
          customer: z.string().min(1).optional(),
          subscription: z.string().min(1).optional(),
          payment_intent: z.string().min(1).optional(),
          status: z.enum(['open', 'complete', 'expired']).optional(),
          ...pagination,
        }),
      )
      .output(
        z.object({
          has_more: z.boolean(),
          data: z.array(checkoutSessionView),
        }),
      ),
  },
}
