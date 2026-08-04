import { z } from 'zod'

// 入力の選択的透過方針は project.md 参照。対応するパラメータだけを受け、expand は受け付けない。

/**
 * カーソルページネーションの共通入力。limit は 1..100(Stripe デフォルト 10)。
 * 前方ページングのみを提供する。続きがあれば、レスポンスの nextCursor を
 * そのまま次回の startingAfter に渡す。
 *
 * 逆方向カーソル ending_before は公開しない。露出するカーソルを単一の nextCursor に絞ると、
 * クライアントはトークンを1つ持ち回すだけで済み、サーバーはカーソルの導出方法(現在は Stripe
 * オブジェクトの id、将来は keyset やオフセット等)を契約を変えずに差し替えられる。ending_before も
 * 公開すると契約が Stripe の双方向カーソル語彙に固定され、クライアントのカーソル管理も前後2系統に
 * 増えて、この自由度を失う。
 *
 * 制約: 前方カーソルのみのため、「前に戻る」はクライアントが順方向にたどって保持した startingAfter の
 * 履歴を巻き戻す場合しか使えない。履歴を持たないクライアント(ページ中間のカーソルだけで開始する
 * deep link、履歴を失うリロード等)は前に戻れない。この用途が要るなら、戻る用カーソル(先頭要素を
 * ending_before に渡す)をレスポンスに足す双方向カーソルへ拡張する。
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
