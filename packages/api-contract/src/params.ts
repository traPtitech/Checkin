import { z } from 'zod'

// 入力の選択的透過方針は project.md 参照。対応するパラメータだけを受け、expand は受け付けない。

/**
 * カーソルページネーションの共通入力。limit は 1..100(Stripe デフォルト 10)。
 * 前方ページングのみを提供する。続きがあれば、レスポンスの next_cursor を
 * そのまま次回の starting_after に渡す。
 *
 * Stripe の逆方向カーソル ending_before は公開しない。next_cursor 単体では
 * 逆方向の継続位置(先頭要素を ending_before に渡す)を表現できず、単純な前方
 * カーソル契約と矛盾するため。「前に戻る」はクライアントが渡した starting_after
 * の履歴を保持して巻き戻すことで実現できる。
 */
export const pagination = {
  limit: z.number().int().min(1).max(100).optional(),
  starting_after: z.string().min(1).optional(),
}

/**
 * カーソルページネーションの一覧レスポンス。カーソルの導出はサーバーが担い、
 * 続きがあれば next_cursor(次回の starting_after に渡す値)、無ければ null を返す。
 * クライアントは next_cursor をそのまま渡すだけでよく、将来カーソル戦略を変えても
 * この契約は不変。
 */
export function listEnvelope<Item extends z.ZodType>(item: Item) {
  return z.object({ data: z.array(item), next_cursor: z.string().nullable() })
}
