import { describe, expect, it } from 'vitest'
import { ORPCError, call } from '@orpc/server'
import { adminProc, userProc, type Context } from './orpc'

/**
 * 認可の検査が入力検証より前に走ることを固定するテスト。
 *
 * `orpc.ts` の `userProc` / `adminProc` のコメントと `openspec/project.md` の「規約」節が、
 * 「認可を通らない呼び出しに入力の形は漏れない」と一般則として書いている。その根拠は
 * ミドルウェアと入力検証の実行順で、これは同梱の `@orpc/server` の挙動である。順序が
 * 変わればこの一般則は成り立たなくなるので、版を上げた日に落ちるようここで測る。
 *
 * 対にして見る。認可が落ちる Context では入力が不正でも UNAUTHORIZED が返り、認可が通る
 * Context では同じ不正な入力が BAD_REQUEST になる。後者が無いと、UNAUTHORIZED が返るのが
 * 「この入力はそもそも検証を通る」という別の理由でないことを示せない。
 */

/** 認可だけを差し替えた最小の Context。ハンドラは呼ばれないので他の依存は供給しない。 */
function contextWith(auth: { pass: boolean }): Context {
  const deny = (): never => {
    throw new ORPCError('UNAUTHORIZED', { message: 'login required' })
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 認可の検査だけを見るので、ハンドラが動くための依存は供給しない
  return {
    requireUser: auth.pass ? () => ({ userId: 'u1', mailHash: 'h1' }) : deny,
    requireAdmin: auth.pass ? () => ({ traqId: 'alice' }) : deny,
    assertCsrf: () => {},
  } as unknown as Context
}

/** 不正な入力(必須のキーがすべて無い)。契約の入力検証は必ず落とす。 */
const INVALID_INPUT = {}

/** 呼び出しが投げた `ORPCError` のコードを返す。 */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  }
  catch (err) {
    // `ORPCError` の code はジェネリックなので、比較できる文字列に落とす。
    return err instanceof ORPCError ? String(err.code) : `not an ORPCError: ${String(err)}`
  }
  return 'resolved without throwing'
}

describe('認可の検査は入力検証より前に走る', () => {
  const userHandler = userProc.membership.issueInvoice.handler(() => {
    throw new Error('handler must not be reached')
  })
  const adminHandler = adminProc.payouts.execute.handler(() => {
    throw new Error('handler must not be reached')
  })

  it('userProc: 認可が落ちる呼び出しは、入力が不正でも UNAUTHORIZED になる', async () => {
    const code = await codeOf(() =>
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 契約の入力型で弾かれる入力を渡すため、呼び出し時だけ型を外す
      call(userHandler, INVALID_INPUT as never, { context: contextWith({ pass: false }) }),
    )
    expect(code).toBe('UNAUTHORIZED')
  })

  it('userProc: 認可が通る呼び出しでは、同じ入力が BAD_REQUEST になる', async () => {
    const code = await codeOf(() =>
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 同上
      call(userHandler, INVALID_INPUT as never, { context: contextWith({ pass: true }) }),
    )
    expect(code).toBe('BAD_REQUEST')
  })

  it('adminProc: 認可が落ちる呼び出しは、入力が不正でも UNAUTHORIZED になる', async () => {
    const code = await codeOf(() =>
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 同上
      call(adminHandler, INVALID_INPUT as never, { context: contextWith({ pass: false }) }),
    )
    expect(code).toBe('UNAUTHORIZED')
  })

  it('adminProc: 認可が通る呼び出しでは、同じ入力が BAD_REQUEST になる', async () => {
    const code = await codeOf(() =>
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 同上
      call(adminHandler, INVALID_INPUT as never, { context: contextWith({ pass: true }) }),
    )
    expect(code).toBe('BAD_REQUEST')
  })
})
