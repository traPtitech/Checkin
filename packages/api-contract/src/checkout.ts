import { oc } from '@orpc/contract'
import { z } from 'zod'
import { listEnvelope, pagination } from './params'

/**
 * Checkout Session の公開 View。出力 allowlist の方針は project.md 参照。Session は
 * customer_details 等の PII を含む。customer / payment_intent は ID のみ。traq_id は
 * 出力に含めない(project.md / #18)。
 */
const checkoutSessionView = z.object({
  id: z.string(),
  status: z.string().nullable(),
  amount_total: z.number().nullable(),
  amount_subtotal: z.number().nullable(),
  created: z.number(),
  customer: z.string().nullable(),
  payment_intent: z.string().nullable(),
})

export type CheckoutSessionView = z.infer<typeof checkoutSessionView>

export const checkoutContract = {
  // Stripe SDK の `stripe.checkout.sessions.list` に構造を合わせている。
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
      .output(listEnvelope(checkoutSessionView)),
  },
}
