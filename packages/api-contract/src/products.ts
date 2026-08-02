import { oc } from '@orpc/contract'
import { z } from 'zod'
import type Stripe from 'stripe'
import { pagination, writableMetadata } from './params'
import type { WithTraqId } from './views'

/** Stripe の Product を Checkin の公開形にした型(metadata を traq_id に絞る)。 */
export type ProductView = WithTraqId<Stripe.Product>

export const productsContract = {
  // 一覧。入力は選択的透過(フィルタ + ページネーション)。各要素は ProductView。
  list: oc
    .input(
      z.object({
        active: z.boolean().optional(),
        ...pagination,
      }),
    )
    .output(
      z.object({
        has_more: z.boolean(),
        data: z.array(z.custom<ProductView>()),
      }),
    ),

  // 更新。metadata は traq_id のみ書き込み可。少なくとも1フィールドの指定を要求する。
  update: oc
    .input(
      z
        .object({
          id: z.string().min(1),
          active: z.boolean().optional(),
          name: z.string().min(1).max(100).optional(),
          description: z.string().max(500).nullable().optional(),
          metadata: writableMetadata,
        })
        .refine(
          v =>
            v.active !== undefined
            || v.name !== undefined
            || v.description !== undefined
            || v.metadata !== undefined,
          { message: '更新するフィールドを少なくとも1つ指定してください' },
        ),
    )
    .output(z.custom<ProductView>()),
}
