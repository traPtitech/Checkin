/**
 * Stripe の展開可能な参照(customer, payment_intent, default_price 等)から ID だけを取り出す。
 * expand しない前提では文字列 ID だが、型は string | オブジェクト | null | undefined なので
 * PII を含むオブジェクトを出さないよう ID に正規化する。参照が無い場合は null。
 */
export function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (ref === null || ref === undefined) return null
  return typeof ref === 'string' ? ref : ref.id
}

/**
 * null にならない展開参照(例: Price.product は string | Product | DeletedProduct で必ず存在する)
 * を ID に正規化する。戻り値を string に保ち、View 側の不要な nullable を防ぐ。
 */
export function requireIdOf(ref: string | { id: string }): string {
  return typeof ref === 'string' ? ref : ref.id
}

/**
 * Stripe の list ページ({ has_more, data })を、契約の一覧レスポンス
 * ({ data, next_cursor }) に変換する。next_cursor は続きがあれば最後の要素の id
 * (次回の starting_after に渡す値)、無ければ null。
 *
 * カーソルは Stripe ソース(page.data)の id から導出する — starting_after は
 * Stripe オブジェクトの id を取るため、View の形状には依存させない。
 */
export function toListResponse<S extends { id: string }, V>(
  page: { has_more: boolean, data: S[] },
  toView: (item: S) => V,
): { data: V[], next_cursor: string | null } {
  return {
    data: page.data.map(toView),
    next_cursor: page.has_more ? (page.data.at(-1)?.id ?? null) : null,
  }
}
