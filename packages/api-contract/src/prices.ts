import { oc } from '@orpc/contract'
import { z } from 'zod'
import type Stripe from 'stripe'

/**
 * 価格ビュー。Stripe の Price をベースに、metadata だけを Checkin 用に絞った公開型。
 * metadata は Stripe 上の任意キーを晒さず、Checkin が使う traq_id だけに限定する。
 * top-level の Stripe 標準フィールド(unit_amount, currency, ...)はそのまま公開する。
 *
 * z.custom は実行時検証を行わず型注釈だけを与える。metadata の絞り込み(内部キーを
 * 出さない不変条件)は型では強制できない — Stripe.Metadata のインデックスシグネチャは
 * { traq_id?: string } に構造的代入可能で、戻り値型注釈でも `metadata: price.metadata`
 * のような全漏洩を素通ししてしまう。実装側は必ず toPriceView() を通し、絞り込みを
 * 1箇所に閉じ込めること(@checkin/api の prices.ts)。
 */
export type PriceView = Omit<Stripe.Price, 'metadata'> & {
  metadata: { traq_id?: string }
}

export const pricesContract = {
  // 単一の Price を PriceView として返す。metadata は traq_id に絞り、それ以外の
  // Stripe 標準フィールドはそのまま公開する(項目が増えても契約は不変)。
  retrieve: oc
    .input(z.object({ id: z.string().min(1) }))
    .output(z.custom<PriceView>()),

  // 一覧。エンベロープ(has_more/data)は自前 zod で構造検証し、各要素は PriceView。
  list: oc
    .input(z.object({ product_id: z.string().min(1).optional() }))
    .output(
      z.object({
        has_more: z.boolean(),
        data: z.array(z.custom<PriceView>()),
      }),
    ),
}
