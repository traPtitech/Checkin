import type { PriceView } from '@checkin/api-contract'
import type Stripe from 'stripe'
import { pub } from './orpc'

/**
 * Stripe の Price を Checkin の公開形 PriceView に変換する唯一の場所。
 * metadata を traq_id だけに絞る不変条件をここに閉じ込める(下記の戻り値型注釈
 * では絞り込みを強制できないため、絞り込みは必ずこの関数を通す)。top-level の
 * Stripe 標準フィールドはそのまま透過する。
 *
 * 絞り込むのはトップレベルの Price.metadata のみ。将来 expand で product 等を
 * 展開する場合、そのネストした metadata は透過されるため、別途対処すること。
 *
 * なお Stripe SDK の Response は Price に加えて非列挙の lastResponse(requestId 等の
 * HTTP メタ情報)を持つが、非列挙なのでスプレッドにもシリアライズにも乗らず、
 * 戻り値にもフロントにも渡らない。
 */
function toPriceView(price: Stripe.Price): PriceView {
  const traqId = price.metadata['traq_id']
  return {
    ...price,
    metadata: traqId ? { traq_id: traqId } : {},
  }
}

/** 価格プロシージャ — Stripe の Price を Checkin API として公開する。 */
export const pricesRouter = {
  retrieve: pub.prices.retrieve.handler(async ({ input, context }) =>
    toPriceView(await context.stripe.prices.retrieve(input.id)),
  ),

  list: pub.prices.list.handler(async ({ input, context }) => {
    // 選択的透過: 支援するパラメータだけを Stripe に渡す。expand は通さない
    // (通すとネストした product.metadata 等の漏洩経路になる)。has_more と
    // starting_after でフロントがカーソルページングできる。
    const params: Stripe.PriceListParams = {}
    if (input.product_id) params.product = input.product_id
    if (input.limit !== undefined) params.limit = input.limit
    if (input.starting_after !== undefined) params.starting_after = input.starting_after

    const page = await context.stripe.prices.list(params)
    return {
      has_more: page.has_more,
      data: page.data.map(toPriceView),
    }
  }),
}
