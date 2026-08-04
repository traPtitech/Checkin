import { z } from 'zod'

// 入力の選択的透過方針は project.md 参照。対応するパラメータだけを受け、expand は受け付けない。

/**
 * カーソルページネーションの共通入力。limit は 1..100(Stripe デフォルト 10)。
 * 前方ページングのみを提供する。続きがあれば、レスポンスの nextCursor を
 * そのまま次回の startingAfter に渡す。
 *
 * Stripe の逆方向カーソル ending_before は公開しない。nextCursor 単体では
 * 逆方向の継続位置(先頭要素を ending_before に渡す)を表現できず、単純な前方
 * カーソル契約と矛盾するため。「前に戻る」はクライアントが渡した startingAfter
 * の履歴を保持して巻き戻すことで実現できる。
 */
export const pagination = {
  limit: z.number().int().min(1).max(100).optional(),
  startingAfter: z.string().min(1).optional(),
}

/**
 * カーソルページネーションの一覧レスポンス。カーソルの導出はサーバーが担い、
 * 続きがあれば nextCursor(次回の startingAfter に渡す値)、無ければ null を返す。
 * クライアントは nextCursor をそのまま渡すだけでよく、将来カーソル戦略を変えても
 * この契約は不変。
 */
export function listEnvelope<Item extends z.ZodType>(item: Item) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() })
}
