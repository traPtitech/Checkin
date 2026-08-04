import type { Context } from './orpc'

/**
 * テスト用の最小 Context。handler が実際に使う stripe リソースだけをスタブして渡す。
 * db は触らせない。mutationsEnabled は既定で true(変更系ガードを通す)。ガード自体を
 * 検証するテストでは false を渡す。
 */
export function testContext(stripe: unknown, mutationsEnabled = true): Context {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 実際に使う依存だけを供給する意図的なテストスタブ
  return { db: {}, stripe, mutationsEnabled } as unknown as Context
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
