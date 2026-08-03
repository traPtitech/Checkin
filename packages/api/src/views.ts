/**
 * Stripe の展開可能な参照(customer, product, payment_intent 等)から ID だけを取り出す。
 * expand しない前提では文字列 ID だが、型は string | オブジェクト | null なので
 * PII を含むオブジェクトを出さないよう ID に正規化する。
 */
export function idOf(ref: string | { id: string } | null): string | null {
  if (ref === null) return null
  return typeof ref === 'string' ? ref : ref.id
}
