import { oc } from '@orpc/contract'
import { z } from 'zod'
import { listEnvelope, pagination } from './params'

/** Price の公開 View。出力 allowlist の方針は project.md 参照。product は ID のみ。 */
const priceView = z.object({
  id: z.string(),
  // Price.product は Stripe 上で必ず存在する(削除済みでも id は残る)ため非 null。
  product: z.string(),
  active: z.boolean(),
  currency: z.string(),
  unit_amount: z.number().nullable(),
  type: z.string(),
  nickname: z.string().nullable(),
  created: z.number(),
})

export type PriceView = z.infer<typeof priceView>

export const pricesContract = {
  // 単一の Price を返す。
  retrieve: oc.input(z.object({ id: z.string().min(1) })).output(priceView),

  // 一覧。入力は選択的透過(params.ts 参照)。
  list: oc
    .input(
      z.object({
        product: z.string().min(1).optional(),
        active: z.boolean().optional(),
        type: z.enum(['one_time', 'recurring']).optional(),
        ...pagination,
      }),
    )
    .output(listEnvelope(priceView)),

  // 更新。更新可能なのは active のみ(必須)。
  update: oc
    .input(z.object({ id: z.string().min(1), active: z.boolean() }))
    .output(priceView),
}
