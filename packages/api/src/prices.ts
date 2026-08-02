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
    // 先頭ページのみ(Stripe デフォルト件数)を返す。has_more で続きの有無は
    // フロントに伝わる。カーソル送りが要るようになったら入力に starting_after を
    // 足して { starting_after } を渡す。
    const page = await context.stripe.prices.list(
      input.product_id ? { product: input.product_id } : {},
    )
    return {
      has_more: page.has_more,
      data: page.data.map(toPriceView),
    }
  }),
}
