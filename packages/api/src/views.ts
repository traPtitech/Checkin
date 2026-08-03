/**
 * Stripe の展開可能な参照(customer, payment_intent 等)から ID だけを取り出す。
 * expand しない前提では文字列 ID だが、型は string | オブジェクト | null なので
 * PII を含むオブジェクトを出さないよう ID に正規化する。
 */
export function idOf(ref: string | { id: string } | null): string | null {
  if (ref === null) return null
  return typeof ref === 'string' ? ref : ref.id
}

/**
 * 透過公開するリソース(カタログの Price / Product)から metadata を落とす。metadata は
 * Checkin 独自の traq_id 用途しかなく、その traq_id は自前 DB を単一ソースとするため
 * 公開しない(必要になれば customer→DB 逆引きで足す、#18)。契約は透過(z.custom)で
 * 実行時に何も削らないため、ここで明示的に metadata を除く。
 *
 * スプレッドは列挙可能な own プロパティのみコピーするため、Stripe SDK の非列挙
 * lastResponse(requestId 等)は元から乗らない。
 */
export function omitMetadata<T extends { metadata: unknown }>(obj: T): Omit<T, 'metadata'> {
  const rest = { ...obj }
  Reflect.deleteProperty(rest, 'metadata')
  return rest
}
