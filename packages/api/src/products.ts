import type Stripe from 'stripe'
import type { ProductView } from '@checkin/api-contract'
import { assertMutationsEnabled, pub } from './orpc'
import { idOf, toListResponse } from './views'

/** Stripe の Product を公開形 ProductView に変換する(公開フィールドを明示選択)。 */
function toProductView(product: Stripe.Product): ProductView {
  return {
    id: product.id,
    active: product.active,
    name: product.name,
    description: product.description,
    default_price: idOf(product.default_price),
    created: product.created,
  }
}

/** 商品プロシージャ — Stripe の Product を Checkin API として公開する。 */
export const productsRouter = {
  list: pub.products.list.handler(async ({ input, context }) => {
    const params: Stripe.ProductListParams = {}
    if (input.active !== undefined) params.active = input.active
    if (input.limit !== undefined) params.limit = input.limit
    if (input.starting_after !== undefined) params.starting_after = input.starting_after

    const page = await context.stripe.products.list(params)
    return toListResponse(page, toProductView)
  }),

  update: pub.products.update.handler(async ({ input, context }) => {
    assertMutationsEnabled(context)

    const params: Stripe.ProductUpdateParams = {}
    if (input.active !== undefined) params.active = input.active
    if (input.name !== undefined) params.name = input.name
    if (input.description !== undefined) params.description = input.description

    return toProductView(await context.stripe.products.update(input.id, params))
  }),
}
