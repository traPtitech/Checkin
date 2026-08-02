import type Stripe from 'stripe'
import type { WithTraqId } from '@checkin/api-contract'

/**
 * Stripe リソースの metadata を traq_id だけに絞る唯一の変換点。型では絞り込みを
 * 強制できない(Stripe.Metadata が { traq_id?: string } に構造的代入可能)ため、
 * 公開するリソースは必ずこの関数を通す。top-level の Stripe 標準フィールドは
 * そのまま透過する。
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
