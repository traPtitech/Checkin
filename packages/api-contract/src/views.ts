import type Stripe from 'stripe'

/**
 * Stripe リソースを透過公開する型。トップレベルの metadata だけを差し替え、Stripe 上の
 * 任意キーを晒さず Checkin が使う traq_id だけに限定する。それ以外の Stripe 標準フィールドは
 * そのまま公開する(項目が増えても契約は不変)。
 *
 * これは PII を持たないカタログ(Price / Product)向けの透過方式。PII やネストした metadata を
 * 含む機微リソース(Invoice / CheckoutSession)は透過せず、公開フィールドを allowlist で明示する
 * (それぞれの契約の z.object を参照)。
 *
 * 透過の絞り込みは型では強制できない(理由と実行時の唯一の変換点は @checkin/api の
 * narrowMetadata を参照)。契約の .output(z.custom<...>()) も実行時検証を行わないため、
 * この方式で公開するリソース(prices / products)は必ず narrowMetadata を通すこと。
 *
 * 絞り込むのはトップレベルの metadata のみ。ネストした metadata は expand しなくても
 * 既定レスポンスに含まれ透過するため、この方式は「PII を持たず expand しない」カタログに限る。
 */
export type WithTraqId<T extends { metadata: Stripe.Metadata | null }> = Omit<T, 'metadata'> & {
  metadata: { traq_id?: string }
}
