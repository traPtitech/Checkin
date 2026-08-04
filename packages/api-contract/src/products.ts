import { oc } from '@orpc/contract'
import { z } from 'zod'
import { listEnvelope, pagination } from './params'

/** Product の公開 View。出力 allowlist の方針は project.md 参照。default_price は ID のみ。 */
const productView = z.object({
  id: z.string(),
  active: z.boolean(),
  name: z.string(),
  description: z.string().nullable(),
  defaultPrice: z.string().nullable(),
  created: z.number(),
})

export type ProductView = z.infer<typeof productView>

export const productsContract = {
  // 単一の Product を返す。
  retrieve: oc.input(z.object({ id: z.string().min(1) })).output(productView),

  // 一覧。入力は選択的透過(params.ts 参照)。
  list: oc
    .input(z.object({ active: z.boolean().optional(), ...pagination }))
    .output(listEnvelope(productView)),

  // 更新。少なくとも1フィールドの指定を要求する。
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
    .output(productView),
}
