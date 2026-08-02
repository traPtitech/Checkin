import type { Context } from './orpc'

/**
 * テスト用の最小 Context。handler が実際に使う stripe リソースだけをスタブして渡す。
 * db は触らせない。
 */
export function testContext(stripe: unknown): Context {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 実際に使う依存だけを供給する意図的なテストスタブ
  return { db: {}, stripe } as unknown as Context
}

/**
 * id と metadata を埋めた Stripe リソースのフィクスチャ。リソース全体は再現せず、
 * handler が参照するフィールドだけ供給する。
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- 呼び出し側が返り値型を指定する意図的なファクトリ。テスト全体に as を散らさず1箇所に集約する
export function stripeFixture<T>(overrides: object): T {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- handler が読むフィールドだけ供給する意図的なキャスト
  return { id: 'obj_x', metadata: {}, ...overrides } as unknown as T
}
