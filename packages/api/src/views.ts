import type Stripe from 'stripe'
import type { WithTraqId } from '@checkin/api-contract'

/**
 * Stripe リソースのトップレベル metadata を traq_id だけに絞る唯一の変換点。型では
 * 絞り込みを強制できない(Stripe.Metadata が { traq_id?: string } に構造的代入可能で、
 * 戻り値型注釈でも生の metadata を素通ししてしまう)ため、公開するリソースは必ずこの
 * 関数を通す。それ以外の Stripe 標準フィールドはそのまま透過する。
 *
 * 絞るのはトップレベル metadata のみ。ネストした metadata(Invoice.lines[].metadata 等)は
 * 既定レスポンスに含まれ透過する — 詳細と対処は WithTraqId(@checkin/api-contract)の doc 参照。
 *
 * Stripe SDK の Response は Price 等に加えて非列挙の lastResponse(requestId 等の
 * HTTP メタ情報)を持つが、非列挙なのでスプレッドにもシリアライズにも乗らず、
 * 戻り値にもフロントにも渡らない。
 */
export function narrowMetadata<T extends { metadata: Stripe.Metadata | null }>(
  obj: T,
): WithTraqId<T> {
  const traqId = obj.metadata?.['traq_id']
  return { ...obj, metadata: traqId ? { traq_id: traqId } : {} }
}

/**
 * Stripe の展開可能な参照(customer, payment_intent 等)から ID だけを取り出す。
 * expand しない前提では文字列 ID だが、型は string | オブジェクト | null なので
 * PII を含むオブジェクトを出さないよう ID に正規化する。
 */
export function idOf(ref: string | { id: string } | null): string | null {
  if (ref === null) return null
  return typeof ref === 'string' ? ref : ref.id
}

/** metadata から traq_id だけを取り出す(allowlist な View 用)。 */
export function traqIdOf(metadata: Stripe.Metadata | null): { traq_id?: string } {
  const traqId = metadata?.['traq_id']
  return traqId ? { traq_id: traqId } : {}
}
