import type Stripe from 'stripe'

/**
 * Stripe リソースを Checkin の公開形にした型。トップレベルの metadata だけを差し替え、
 * Stripe 上の任意キーを晒さず Checkin が使う traq_id だけに限定する。それ以外の Stripe
 * 標準フィールドはそのまま公開する(項目が増えても契約は不変)。
 *
 * この絞り込みは型では強制できない(理由と実行時の唯一の変換点は @checkin/api の
 * narrowMetadata を参照)。契約の .output(z.custom<...>()) も実行時検証を行わないため、
 * 公開するリソースは必ず narrowMetadata を通すこと。
 *
 * 絞り込むのはトップレベルの metadata のみ。Invoice の lines[].metadata・
 * subscription_details.metadata、Checkout.Session の invoice_creation 配下の metadata
 * などネストした metadata は、expand しなくても既定レスポンスに含まれ、そのまま透過する。
 * これらの絞り込みや、metadata 以外の PII(customer_email 等)の公開範囲は #15 で扱う。
 */
export type WithTraqId<T extends { metadata: Stripe.Metadata | null }> = Omit<T, 'metadata'> & {
  metadata: { traq_id?: string }
}
