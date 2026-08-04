import type Stripe from 'stripe'
import type { PriceView } from '@checkin/api-contract'
import { assertMutationsEnabled, pub } from './orpc'
import { requireIdOf, toListResponse } from './views'

/** Stripe の Price を公開形 PriceView に変換する(公開フィールドを明示選択)。 */
function toPriceView(price: Stripe.Price): PriceView {
  return {
    id: price.id,
    product: requireIdOf(price.product),
    active: price.active,
    currency: price.currency,
    unit_amount: price.unit_amount,
    type: price.type,
    nickname: price.nickname,
    created: price.created,
  }
}

/** 価格プロシージャ — Stripe の Price を Checkin API として公開する。 */
export const pricesRouter = {
  retrieve: pub.prices.retrieve.handler(async ({ input, context }) =>
    toPriceView(await context.stripe.prices.retrieve(input.id)),
  ),

  list: pub.prices.list.handler(async ({ input, context }) => {
    // 選択的透過: 対応するパラメータだけを Stripe に渡す。expand は通さない
    // (通すとネストした product.metadata 等の漏洩経路になる)。続きがあれば
    // フロントが data 末尾の Price ID を次回の starting_after に渡してページ送りする。
    const params: Stripe.PriceListParams = {}
    if (input.product) params.product = input.product
    if (input.active !== undefined) params.active = input.active
    if (input.type !== undefined) params.type = input.type
    if (input.limit !== undefined) params.limit = input.limit
    if (input.starting_after !== undefined) params.starting_after = input.starting_after

    const page = await context.stripe.prices.list(params)
    return toListResponse(page, toPriceView)
  }),

  update: pub.prices.update.handler(async ({ input, context }) => {
    assertMutationsEnabled(context)
    return toPriceView(await context.stripe.prices.update(input.id, { active: input.active }))
  }),
}
