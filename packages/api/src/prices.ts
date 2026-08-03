import type Stripe from 'stripe'
import { pub } from './orpc'
import { omitMetadata } from './views'

/** 価格プロシージャ — Stripe の Price を Checkin API として公開する。 */
export const pricesRouter = {
  retrieve: pub.prices.retrieve.handler(async ({ input, context }) =>
    omitMetadata(await context.stripe.prices.retrieve(input.id)),
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
    if (input.ending_before !== undefined) params.ending_before = input.ending_before

    const page = await context.stripe.prices.list(params)
    return {
      has_more: page.has_more,
      data: page.data.map(price => omitMetadata(price)),
    }
  }),

  update: pub.prices.update.handler(async ({ input, context }) => {
    const params: Stripe.PriceUpdateParams = {}
    if (input.active !== undefined) params.active = input.active
    return omitMetadata(await context.stripe.prices.update(input.id, params))
  }),
}
