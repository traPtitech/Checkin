import type Stripe from 'stripe'
import { pub } from './orpc'
import { omitMetadata } from './views'

/** 商品プロシージャ — Stripe の Product を Checkin API として公開する。 */
export const productsRouter = {
  list: pub.products.list.handler(async ({ input, context }) => {
    const params: Stripe.ProductListParams = {}
    if (input.active !== undefined) params.active = input.active
    if (input.limit !== undefined) params.limit = input.limit
    if (input.starting_after !== undefined) params.starting_after = input.starting_after
    if (input.ending_before !== undefined) params.ending_before = input.ending_before

    const page = await context.stripe.products.list(params)
    return {
      has_more: page.has_more,
      data: page.data.map(product => omitMetadata(product)),
    }
  }),

  update: pub.products.update.handler(async ({ input, context }) => {
    const params: Stripe.ProductUpdateParams = {}
    if (input.active !== undefined) params.active = input.active
    if (input.name !== undefined) params.name = input.name
    if (input.description !== undefined) params.description = input.description

    return omitMetadata(await context.stripe.products.update(input.id, params))
  }),
}
