import { oc } from '@orpc/contract'
import { z } from 'zod'
import type Stripe from 'stripe'
import { pagination } from './params'
import type { WithTraqId } from './views'

/** Stripe の Checkout Session を Checkin の公開形にした型(metadata を traq_id に絞る)。 */
export type CheckoutSessionView = WithTraqId<Stripe.Checkout.Session>

export const checkoutContract = {
  // Checkout Session 一覧。入力は選択的透過(フィルタ + ページネーション)。
  listSessions: oc
    .input(
      z.object({
        customer_id: z.string().min(1).optional(),
        subscription_id: z.string().min(1).optional(),
        payment_intent_id: z.string().min(1).optional(),
        status: z.enum(['open', 'complete', 'expired']).optional(),
        ...pagination,
      }),
    )
    .output(
      z.object({
        has_more: z.boolean(),
        data: z.array(z.custom<CheckoutSessionView>()),
      }),
    ),
}
