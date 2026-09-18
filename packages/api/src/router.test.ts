import { describe, expect, it } from 'vitest'
import { contract } from '@checkin/api-contract'
import { appRouter } from './router'

/**
 * `appRouter` の公開面が契約と過不足なく一致することを固定するテスト。
 *
 * 型チェックでは足りない。`implement(contract).router({...})` は契約のキーが不足していれば
 * 型エラーにするが、契約に無いキーが足されていても型エラーにしない
 * (`contract-surface.test.ts` の「契約が RPC の公開面を塞ぐ」で実行時に測っている)。
 * 契約に無いキーは `/rpc` でも `matched: false` になるので、型エラーにも実行時のエラーにも
 * ならないまま応答しない死んだコードになる。キーの数だけを数える観点はこれを検出しない。
 *
 * 期待値に 8 という数を書かず契約のキーそのものと突き合わせるのは、数を書くと契約に
 * capability を足した日にこのテストだけが古くなり、しかも数が合っている限り名前の食い違いを
 * 見逃すためである。
 */
describe('appRouter の公開面', () => {
  it('トップレベルキーの集合が契約のトップレベルキーの集合と一致する', () => {
    expect(Object.keys(appRouter).sort()).toEqual(Object.keys(contract).sort())
  })
})
