import { z } from 'zod'

// 「選択的透過」= Stripe のパラメータのうち、このAPIが対応するものだけを明示的に
// 受け付ける方針。未知キー(expand 等)は zod が既定で除去する。特に expand は
// ネストしたリソースの metadata 漏洩経路になるため、どの入力にも含めない。

/**
 * カーソルページネーションの共通入力。limit は 1..100(Stripe デフォルト 10)。
 * 続きがあればフロントが data 末尾のリソース ID を次回の starting_after に渡す。
 * (starting_after と ending_before は Stripe 上相互排他だが、両指定は Stripe が弾く。)
 */
export const pagination = {
  limit: z.number().int().min(1).max(100).optional(),
  starting_after: z.string().min(1).optional(),
  ending_before: z.string().min(1).optional(),
}

/**
 * Checkin が書き込みを許す metadata。Stripe 上の任意キーは受けず、Checkin が使う
 * traq_id だけに限定する(出力側の絞り込みと対称)。
 */
export const writableMetadata = z.object({ traq_id: z.string().min(1) }).partial().optional()
