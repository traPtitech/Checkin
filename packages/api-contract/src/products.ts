import { oc } from '@orpc/contract'
import { z } from 'zod'
import type Stripe from 'stripe'
import { pagination } from './params'

/** Product の公開形。Stripe の Product を透過するが metadata は公開しない(理由は PriceView 参照)。 */
export type ProductView = Omit<Stripe.Product, 'metadata'>

export const productsContract = {
  // 一覧。入力は選択的透過(params.ts 参照)。各要素は ProductView。
  list: oc
    .input(z.object({ active: z.boolean().optional(), ...pagination }))
    .output(
      z.object({
        has_more: z.boolean(),
        data: z.array(z.custom<ProductView>()),
      }),
    ),

  // 更新。traq_id はレスポンス専用(サーバ由来)のため入力では受けない。
  update: oc
    .input(
      z
        .object({
          id: z.string().min(1),
          active: z.boolean().optional(),
          name: z.string().min(1).max(100).optional(),
          description: z.string().max(500).nullable().optional(),
        })
        .refine(
          v => v.active !== undefined || v.name !== undefined || v.description !== undefined,
          { message: '更新するフィールドを少なくとも1つ指定してください' },
        ),
    )
    .output(z.custom<ProductView>()),
}
