import type Stripe from 'stripe'

/**
 * Stripe リソースを Checkin の公開形にした型。metadata だけを差し替え、Stripe 上の
 * 任意キーを晒さず Checkin が使う traq_id だけに限定する。top-level の Stripe 標準
 * フィールドはそのまま公開する(項目が増えても契約は不変)。
 *
 * z.custom は実行時検証を行わず型注釈だけを与える。metadata の絞り込み(内部キーを
 * 出さない不変条件)は型では強制できない — Stripe.Metadata のインデックスシグネチャは
 * { traq_id?: string } に構造的代入可能で、戻り値型注釈でも `metadata: obj.metadata`
 * のような全漏洩を素通ししてしまう。実装側は必ず narrowMetadata() を通し、絞り込みを
 * 1箇所に閉じ込めること(@checkin/api の views.ts)。
 *
 * 絞り込むのはトップレベルの metadata のみ。将来 expand でネストしたリソース
 * (例: invoice.customer)を展開する場合、そのネスト metadata は透過されるため別途対処すること。
 */
export type WithTraqId<T extends { metadata: Stripe.Metadata | null }> = Omit<T, 'metadata'> & {
  metadata: { traq_id?: string }
}
