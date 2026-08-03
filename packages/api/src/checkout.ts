import type Stripe from 'stripe'
import type { CheckoutSessionView } from '@checkin/api-contract'
import { pub } from './orpc'
import { idOf, traqIdOf } from './views'

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
    metadata: traqIdOf(session.metadata),
  }
}

/** Checkout プロシージャ — Stripe の Checkout Session を Checkin API として公開する。 */
export const checkoutRouter = {
  listSessions: pub.checkout.listSessions.handler(async ({ input, context }) => {
    const params: Stripe.Checkout.SessionListParams = {}
    if (input.customer_id) params.customer = input.customer_id
    if (input.subscription_id) params.subscription = input.subscription_id
    if (input.payment_intent_id) params.payment_intent = input.payment_intent_id
    if (input.status !== undefined) params.status = input.status
    if (input.limit !== undefined) params.limit = input.limit
    if (input.starting_after !== undefined) params.starting_after = input.starting_after
    if (input.ending_before !== undefined) params.ending_before = input.ending_before

    const page = await context.stripe.checkout.sessions.list(params)
    return {
      has_more: page.has_more,
      data: page.data.map(toCheckoutSessionView),
    }
  }),
}
