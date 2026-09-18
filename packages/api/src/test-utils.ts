import type { Context } from './orpc'

/**
 * テスト用の最小 Context。第1引数には、handler が実際に使う Stripe SDK のリソースだけを
 * スタブしたオブジェクト(例: { prices: { list } })を、sdk で包まずにそのまま渡す。
 * Context の stripe は sdk ゲッターで SDK を返す StripeClient なので、包むのはこの関数の側で行い、handler からは
 * Context の stripe.sdk 経由で見えるようにする。db は触らせない。mutationsEnabled は既定で
 * true(変更系ガードを通す)。ガード自体を検証するテストでは false を渡す。
 */
export function testContext(stripe: unknown, mutationsEnabled = true): Context {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 実際に使う依存だけを供給する意図的なテストスタブ
  return { db: {}, stripe: { sdk: stripe }, mutationsEnabled } as unknown as Context
}

/**
 * id と metadata を埋めた Stripe リソースのフィクスチャ。リソース全体は再現せず、
 * handler が参照するフィールドだけ供給する。overrides を Partial<T> にすることで、
 * トップレベルのフィールド名タイポを呼び出し側でコンパイル時に検出できる。
 */
export function stripeFixture<T>(overrides: Partial<T>): T {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- handler が読むフィールドだけ供給する意図的なキャスト
  return { id: 'obj_x', metadata: {}, ...overrides } as unknown as T
}
