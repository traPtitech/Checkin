import { oc } from '@orpc/contract'
import { z } from 'zod'
import { listEnvelope, pagination } from './params'

/**
 * Price の公開形。公開するフィールドだけを明示列挙する allowlist。PII や内部フィールド・
 * 将来 Stripe が増やすフィールドを出力に漏らさず(セキュリティ)、クライアント向けに安定した
 * 契約を保つのが目的。フィールドの語彙は Stripe に合わせている。product は ID のみ。
 */
const priceView = z.object({
  id: z.string(),
  product: z.string().nullable(),
  active: z.boolean(),
  currency: z.string(),
  unit_amount: z.number().nullable(),
  // 将来プロバイダ側が値を増やしても落ちないよう enum で狭めない。
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
