import { z } from 'zod'

// 「選択的透過」= Stripe のパラメータのうち、このAPIが対応するものだけを明示的に
// 受け付ける方針。未知キー(expand 等)は zod が既定で除去する。特に expand は
// ネストしたリソースの metadata 漏洩経路になるため、どの入力にも含めない。

/**
 * カーソルページネーションの共通入力。limit は 1..100(Stripe デフォルト 10)。
 * 続きがあればフロントが data 末尾のリソース ID を次回の starting_after に渡す。
 * (starting_after と ending_before は相互排他で、両方指定すると Stripe がエラーにする。)
 */
export const pagination = {
  limit: z.number().int().min(1).max(100).optional(),
  starting_after: z.string().min(1).optional(),
  ending_before: z.string().min(1).optional(),
}

/** カーソルページネーションの一覧レスポンス(has_more と data 配列のエンベロープ)。 */
export function listEnvelope<Item extends z.ZodType>(item: Item) {
  return z.object({ has_more: z.boolean(), data: z.array(item) })
}
