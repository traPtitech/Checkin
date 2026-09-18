import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call } from '@orpc/server'
import type { Context } from '../orpc'
import { payoutsRouter } from './router'

/**
 * `payouts` の 4 つのプロシージャが、契約実装形への移設の後も移設前と同じ値を下位へ渡し、
 * 同じ値を返すことを固定するテスト。
 *
 * 見るのは 2 つである。1 つは `payoutExecuteConfig` が読む Context のキーで、
 * `execute` と `processApproved` がオーケストレーションへ渡す
 * `{ appOrigin, defaultCurrency }` の中身を見る。読むキーを取り違えると値が入れ替わるので、
 * 2 つの値は必ず違う文字列にしてある。もう 1 つは `list` の行の変換で、ドメイン層が Date で
 * 持つ 2 つの時刻が ISO 8601 の文字列になること(契約が `z.iso.datetime()` なので、Date を
 * そのまま流すと出力検証で落ちる)と、`nextCursor` が常に null であることを見る。
 */

const executeModule = vi.hoisted(() => ({
  executePayout: vi.fn(),
  processApprovedPayouts: vi.fn(),
  markPayoutManuallyPaid: vi.fn(),
}))
vi.mock('./execute', () => executeModule)

const storeModule = vi.hoisted(() => ({
  listPayouts: vi.fn(),
  getPayoutByJomonRef: vi.fn(),
}))
vi.mock('./store', () => storeModule)

/** Context の 2 つのキーは必ず違う値にする。取り違えを値の入れ替わりとして観測するため。 */
const APP_ORIGIN = 'https://checkin.example'
const PAYOUT_CURRENCY = 'jpy'

/** 会計担当者として通る最小の Context。handler が実際に読むものだけを供給する。 */
function adminContext(): Context {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- handler が読む依存だけを供給する意図的なテストスタブ
  return {
    // 3 つは互いに区別できる値にする。同じ空オブジェクトにすると、取り違えても
    // 深い等価比較が通ってしまい、入れ替えを観測できない。
    db: { kind: 'db' },
    stripe: { kind: 'stripe' },
    jomon: { kind: 'jomon' },
    config: { appOrigin: APP_ORIGIN },
    jomonConfig: { payoutCurrency: PAYOUT_CURRENCY },
    session: { userId: 'u-admin', traqId: 'admin', isAdmin: true },
    requireAdmin: () => ({ traqId: 'admin' }),
    assertCsrf: () => {},
  } as unknown as Context
}

/** 単件操作の結果。契約の payoutStepView を満たす最小の値。 */
const STEP = { jomonRef: 'jomon-1', outcome: 'paid', status: 'paid' } as const

/** `processApproved` の要約。契約の processApprovedView を満たす最小の値。 */
const SUMMARY = {
  ingested: 1,
  paid: 1,
  onboardingWaiting: 0,
  unresolved: 0,
  failed: 0,
  alreadyPaid: 0,
  needsReview: 0,
  skippedFailed: 0,
  errored: 0,
  errors: [],
  multiPayeeRefs: [],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('payoutExecuteConfig が読む Context の値', () => {
  it('execute は appOrigin を config から、defaultCurrency を jomonConfig から渡す', async () => {
    executeModule.executePayout.mockResolvedValue(STEP)

    await call(payoutsRouter.execute, { jomonRef: 'jomon-1' }, { context: adminContext() })

    expect(executeModule.executePayout).toHaveBeenCalledWith(
      expect.anything(),
      { appOrigin: APP_ORIGIN, defaultCurrency: PAYOUT_CURRENCY },
      'jomon-1',
    )
  })

  it('processApproved も同じ 2 つの値を渡す', async () => {
    executeModule.processApprovedPayouts.mockResolvedValue(SUMMARY)

    await call(payoutsRouter.processApproved, undefined, { context: adminContext() })

    expect(executeModule.processApprovedPayouts).toHaveBeenCalledWith(
      expect.anything(),
      { appOrigin: APP_ORIGIN, defaultCurrency: PAYOUT_CURRENCY },
    )
  })

  it('オーケストレーションへ渡す依存は Context の db・stripe・jomon である', async () => {
    const context = adminContext()
    executeModule.executePayout.mockResolvedValue(STEP)

    await call(payoutsRouter.execute, { jomonRef: 'jomon-1' }, { context })

    expect(executeModule.executePayout).toHaveBeenCalledWith(
      { db: context.db, stripe: context.stripe, jomon: context.jomon },
      expect.anything(),
      'jomon-1',
    )
  })
})

describe('payouts.list の行の変換', () => {
  /** ドメイン層が返す行。2 つの時刻は Date で持つ。 */
  const row = {
    id: 'po_1',
    jomonRef: 'jomon-1',
    userId: 'u1',
    amount: 1000,
    currency: 'jpy',
    status: 'paid',
    stripeTransferId: 'tr_1',
    jomonWrittenBackAt: new Date('2026-09-18T01:23:45.000Z'),
    payoutMethod: 'manual_bank',
    manualPaidNote: 'メモ',
    manualPaidAt: new Date('2026-09-17T09:00:00.000Z'),
    manualPaidBy: 'u2',
  }

  it('Date の 2 つの時刻が ISO 8601 の文字列になり、他のフィールドはそのまま写る', async () => {
    storeModule.listPayouts.mockResolvedValue([row])

    const result = await call(payoutsRouter.list, {}, { context: adminContext() })

    expect(result.data).toEqual([{
      id: 'po_1',
      jomonRef: 'jomon-1',
      userId: 'u1',
      amount: 1000,
      currency: 'jpy',
      status: 'paid',
      stripeTransferId: 'tr_1',
      jomonWrittenBackAt: '2026-09-18T01:23:45.000Z',
      payoutMethod: 'manual_bank',
      manualPaidNote: 'メモ',
      manualPaidAt: '2026-09-17T09:00:00.000Z',
      manualPaidBy: 'u2',
    }])
  })

  it('時刻が null の行は null のまま通る', async () => {
    storeModule.listPayouts.mockResolvedValue([
      { ...row, jomonWrittenBackAt: null, manualPaidAt: null },
    ])

    const result = await call(payoutsRouter.list, {}, { context: adminContext() })

    expect(result.data[0]?.jomonWrittenBackAt).toBeNull()
    expect(result.data[0]?.manualPaidAt).toBeNull()
  })

  it('nextCursor は常に null である', async () => {
    storeModule.listPayouts.mockResolvedValue([row])

    const result = await call(payoutsRouter.list, {}, { context: adminContext() })

    expect(result.nextCursor).toBeNull()
  })

  it('status の絞り込みはそのままドメイン層へ渡る', async () => {
    storeModule.listPayouts.mockResolvedValue([])

    await call(payoutsRouter.list, { status: 'onboarding_waiting' }, { context: adminContext() })

    expect(storeModule.listPayouts).toHaveBeenCalledWith(
      expect.anything(),
      { status: 'onboarding_waiting' },
    )
  })
})
