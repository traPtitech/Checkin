import type Stripe from 'stripe'
import type { CheckoutSessionView } from '@checkin/api-contract'
import { pub } from './orpc'
import { idOf, toListResponse } from './views'

/** Stripe の Checkout Session を allowlist の View に変換する(公開フィールドを明示選択)。 */
function toCheckoutSessionView(session: Stripe.Checkout.Session): CheckoutSessionView {
  return {
    id: session.id,
    status: session.status,
    amount_total: session.amount_total,
    amount_subtotal: session.amount_subtotal,
    created: session.created,
    customer: idOf(session.customer),
    payment_intent: idOf(session.payment_intent),
  }
}

/** Checkout プロシージャ — Stripe の Checkout Session を Checkin API として公開する。 */
export const checkoutRouter = {
  sessions: {
    list: pub.checkout.sessions.list.handler(async ({ input, context }) => {
      const params: Stripe.Checkout.SessionListParams = {}
      if (input.customer) params.customer = input.customer
      if (input.subscription) params.subscription = input.subscription
      if (input.payment_intent) params.payment_intent = input.payment_intent
      if (input.status !== undefined) params.status = input.status
      if (input.limit !== undefined) params.limit = input.limit
      if (input.starting_after !== undefined) params.starting_after = input.starting_after

      const page = await context.stripe.checkout.sessions.list(params)
      return toListResponse(page, toCheckoutSessionView)
    }),
  },
}
