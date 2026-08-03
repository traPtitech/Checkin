import { oc } from '@orpc/contract'
import { z } from 'zod'
import { listEnvelope, pagination } from './params'

/**
 * Price の公開形。公開するフィールドだけを明示列挙する allowlist。目的は、PII や
 * 内部フィールド・将来 Stripe が増やすフィールドを出力に漏らさないこと(セキュリティ)と、
 * クライアント向けの安定した契約。フィールドの形状・語彙は意図的に Stripe に合わせており、
 * 決済プロバイダ移行の容易化を主目的とはしない(移行時は入力語彙・カーソル・ハンドラも
 * 書き換えが要る)。product は ID のみ。
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
