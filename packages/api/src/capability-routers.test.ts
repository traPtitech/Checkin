import { describe, expect, it } from 'vitest'
import { os } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import type { Context } from './orpc'
import { authRouter } from './auth/router'
import { membershipRouter } from './membership/router'
import { paymentsRouter } from './payments/router'
import { payoutsRouter } from './payouts/router'

/**
 * `health.check` を capability ごとのファイルへ移さなかった結果を、経路として固定するテスト。
 *
 * この単位は auth 側の 14 プロシージャのうち 13 を 4 つのファイルへ移し、`health.check` は
 * 移さない。移さないこと自体が削除なので、削除されたことは「`/health/check` への要求が
 * 経路として一致しない」ことでしか観測できない。
 *
 * 観点が移す前と後を区別していることも同じ手段で確かめる。同じ 4 つのルーターに
 * `health.check` を置いた版では `/health/check` が一致する。一致しないのが「RPCHandler が
 * どの経路も一致させていない」といった別の理由ではないことは、契約にある経路が一致することで
 * 分かる。
 */

/** この単位が作った 4 つの capability のルーター。 */
const capabilityRouters = {
  auth: authRouter,
  membership: membershipRouter,
  payments: paymentsRouter,
  payouts: payoutsRouter,
}

/**
 * 4 つのルーターが実際に持つ経路。ルーターのキーから作るので、どれかに 14 個目の
 * プロシージャが現れれば、この配列が増えて下の比較が落ちる。移した 13 と突き合わせる
 * 対象をリテラルの列挙ではなく実物にするのは、列挙どうしを比べても増えた側を検出
 * できないためである。
 */
const actualPaths = Object.entries(capabilityRouters).flatMap(
  ([capability, router]) => Object.keys(router).map(procedure => `/${capability}/${procedure}`),
)

/** 移す前の形。auth 側 `router.ts` が持っていた `health.check` を足したもの。 */
const withHealth = {
  ...capabilityRouters,
  health: {
    check: os.handler(() => ({ ok: true, timestamp: new Date().toISOString() })),
  },
}

/**
 * 経路が一致したかどうかだけを返す。ハンドラの実行結果は見ない。
 *
 * 引数の型を `capabilityRouters` そのものにしているのは、`health.check` を足した版も同じ
 * 4 つのキーを持つので同じ引数で渡せるためである(余分なキーは構造的部分型として通る)。
 * ライブラリのルーター型の名前をここに書かずに済む。
 */
async function matches(target: typeof capabilityRouters, path: string): Promise<boolean> {
  const handler = new RPCHandler(target)
  const { matched } = await handler.handle(
    new Request(`http://localhost/rpc${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: {} }),
    }),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 経路が一致するかだけを見るので、ハンドラが動くための依存は供給しない
    { prefix: '/rpc', context: {} as Context },
  )
  return matched
}

describe('health.check を移さなかったこと', () => {
  it('4 つの capability のルーターに /health/check の経路は無い', async () => {
    expect(await matches(capabilityRouters, '/health/check')).toBe(false)
  })

  it('移す前の形(health.check を置いた版)では /health/check が一致する', async () => {
    expect(await matches(withHealth, '/health/check')).toBe(true)
  })

  it('4 つのルーターが持つ経路は、移した 13 プロシージャと過不足なく一致する', async () => {
    const moved = [
      '/auth/requestEmailVerification',
      '/auth/me',
      '/membership/issueInvoice',
      '/membership/issueSpecialInvoice',
      '/membership/issueSpecialInvoiceByEmail',
      '/payments/listInvoices',
      '/payments/listCheckoutSessions',
      '/payouts/createOnboardingLink',
      '/payouts/onboardingStatus',
      '/payouts/processApproved',
      '/payouts/list',
      '/payouts/execute',
      '/payouts/markManuallyPaid',
    ]
    // 実物のキーと突き合わせる。これで「移していないものが増えていない」ことも見る。
    expect([...actualPaths].sort()).toEqual([...moved].sort())
    expect(actualPaths).toHaveLength(13)
    // 名前が一致するだけでなく、RPC の経路としても一致することを見る。
    for (const path of moved) {
      expect(await matches(capabilityRouters, path), path).toBe(true)
    }
  })

  it('定義していない経路は一致しない', async () => {
    expect(await matches(capabilityRouters, '/auth/neverDefined')).toBe(false)
  })
})
