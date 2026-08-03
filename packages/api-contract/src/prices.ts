import { oc } from '@orpc/contract'
import { z } from 'zod'
import type Stripe from 'stripe'
import { pagination } from './params'
import type { WithTraqId } from './views'

/** Stripe の Price を Checkin の公開形にした型(metadata を traq_id に絞る)。 */
export type PriceView = WithTraqId<Stripe.Price>

export const pricesContract = {
  // 単一の Price を PriceView として返す。
  retrieve: oc
    .input(z.object({ id: z.string().min(1) }))
    .output(z.custom<PriceView>()),

  // 一覧。エンベロープ(has_more/data)は自前 zod で構造検証し、各要素は PriceView。
  // 入力は選択的透過(params.ts 参照)。
  list: oc
    .input(
      z.object({
        product_id: z.string().min(1).optional(),
        active: z.boolean().optional(),
        type: z.enum(['one_time', 'recurring']).optional(),
        ...pagination,
      }),
    )
    .output(
      z.object({
        has_more: z.boolean(),
        data: z.array(z.custom<PriceView>()),
      }),
    ),

  // 更新。traq_id はレスポンス専用(サーバ由来)のため入力では受けない。
  update: oc
    .input(
      z
        .object({
          id: z.string().min(1),
          active: z.boolean().optional(),
        })
        .refine(v => v.active !== undefined, { message: 'active を指定してください' }),
    )
    .output(z.custom<PriceView>()),
}
