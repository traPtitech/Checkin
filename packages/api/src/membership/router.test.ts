import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call } from '@orpc/server'
import type { Context } from '../orpc'
import { deriveMailHash } from '../auth'
import { computeActivityYear, computeTerm } from '../billing'
import { halvesForCoverage, standardActivityYear, standardCoverage } from '../ledger'
import { membershipRouter } from './router'

/**
 * `membership` の 3 つのプロシージャが、契約実装形への移設の後も移設前と同じ値を
 * `issueSpecialForRow` と台帳へ渡すことを固定するテスト。
 *
 * `issueSpecialForRow` はこのモジュールの中に閉じているので、渡された値は下位への呼び出しに
 * 現れるものとして観測する。台帳の `issueWithLedger` が受け取る `{ userId, activityYear, halves }`
 * が `row.id`・`activityYear`・`coverage` を、`getOrCreateCustomer` が受け取る引数が
 * `row`・`email`・`name` を、`createDraftInvoice` の metadata が `coverage`・`activityYear` を
 * それぞれ表す。値はすべて互いに違うものにしてあるので、読むキーを取り違えると観測値が変わる。
 */

const ledgerMocks = vi.hoisted(() => ({ issueWithLedger: vi.fn() }))
vi.mock('../ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ledger')>()
  return { ...actual, issueWithLedger: ledgerMocks.issueWithLedger }
})

const authMocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getOrCreateUserByMailHash: vi.fn(),
  linkTraqId: vi.fn(),
}))
vi.mock('../auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth')>()
  return { ...actual, ...authMocks }
})

const stripeMocks = vi.hoisted(() => ({
  getOrCreateCustomer: vi.fn(),
  createDraftInvoice: vi.fn(),
  finalizeAndSendInvoice: vi.fn(),
  voidInvoiceSafe: vi.fn(),
}))
vi.mock('../stripe', () => stripeMocks)

const MAIL_HASH_SECRET = 'secret-for-test'
const TARGET_EMAIL = 'target@isct.example'
const TARGET_MAIL_HASH = deriveMailHash(TARGET_EMAIL, MAIL_HASH_SECRET)

/** 対象者の行。特別発行の 2 つの selector が共通で使う。 */
const TARGET_ROW = {
  id: 'user-target',
  mailHash: TARGET_MAIL_HASH,
  traqId: 'target_traq',
  stripeCustomerId: 'cus_target',
  stripeConnectedAccountId: null,
  payoutOnboardingStatus: 'none' as const,
}

/** handler が読むものだけを供給する Context。 */
function membershipContext(session: { userId?: string, mailHash?: string, traqId?: string | null }): Context {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- handler が読む依存だけを供給する意図的なテストスタブ
  return {
    db: {},
    stripe: {},
    config: {
      mailHashSecret: MAIL_HASH_SECRET,
      allowedEmailDomains: ['isct.example'],
    },
    billing: {
      prices: {
        shinkiZenki: 'price_shinki_zenki',
        shinkiKouki: 'price_shinki_kouki',
        keizokuStandard: 'price_keizoku_standard',
        keizokuSpecial: 'price_keizoku_special',
      },
      invoiceDaysUntilDue: 7,
    },
    session: { traqId: session.traqId ?? null, userId: session.userId ?? null, isAdmin: true },
    requireUser: () => ({ userId: session.userId ?? '', mailHash: session.mailHash ?? '' }),
    requireAdmin: () => ({ traqId: session.traqId ?? null }),
    assertCsrf: () => {},
  } as unknown as Context
}

/** `issueWithLedger` が受け取った target。テストごとに 1 件だけ入る。 */
let capturedTarget: { userId: string, activityYear: number, halves: string[] } | undefined

beforeEach(() => {
  vi.clearAllMocks()
  capturedTarget = undefined
  ledgerMocks.issueWithLedger.mockImplementation(async (
    _db: unknown,
    target: { userId: string, activityYear: number, halves: string[] },
    ops: { createDraft: () => Promise<string> },
  ) => {
    capturedTarget = target
    const invoiceId = await ops.createDraft()
    return { ok: true, invoiceId, hostedInvoiceUrl: 'https://invoice.example/1' }
  })
  stripeMocks.getOrCreateCustomer.mockResolvedValue('cus_resolved')
  stripeMocks.createDraftInvoice.mockResolvedValue({ invoiceId: 'in_draft' })
})

describe('issueSpecialInvoice(userId で対象を指定)', () => {
  it('行・メール・名前・coverage・activityYear がそのまま下位へ渡る', async () => {
    authMocks.getUserById.mockResolvedValue(TARGET_ROW)

    const result = await call(
      membershipRouter.issueSpecialInvoice,
      {
        userId: 'user-target',
        name: '対象 太郎',
        email: TARGET_EMAIL,
        coverage: 'kouki',
        activityYear: 2027,
      },
      { context: membershipContext({ traqId: 'admin' }) },
    )

    // row.id と activityYear と coverage は台帳の target に現れる。
    expect(capturedTarget).toEqual({
      userId: 'user-target',
      activityYear: 2027,
      halves: halvesForCoverage('kouki'),
    })
    // row・email・name は Customer の解決に現れる。
    expect(stripeMocks.getOrCreateCustomer).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        userId: 'user-target',
        stripeCustomerId: 'cus_target',
        email: TARGET_EMAIL,
        name: '対象 太郎',
        mailHash: TARGET_MAIL_HASH,
      },
    )
    // coverage と activityYear は Invoice の metadata にも現れる。
    expect(stripeMocks.createDraftInvoice).toHaveBeenCalledWith(expect.anything(), {
      customerId: 'cus_resolved',
      priceId: 'price_keizoku_special',
      daysUntilDue: 7,
      metadata: {
        fee_type: 'continuation',
        variant: 'special',
        coverage: 'kouki',
        activity_year: '2027',
      },
    })
    expect(result).toEqual({ invoiceId: 'in_draft', hostedInvoiceUrl: 'https://invoice.example/1' })
  })

  it('activityYear を省くと現在の年度になる', async () => {
    authMocks.getUserById.mockResolvedValue(TARGET_ROW)

    await call(
      membershipRouter.issueSpecialInvoice,
      { userId: 'user-target', coverage: 'zenki' },
      { context: membershipContext({ traqId: 'admin' }) },
    )

    expect(capturedTarget?.activityYear).toBe(computeActivityYear(new Date()))
    expect(capturedTarget?.halves).toEqual(halvesForCoverage('zenki'))
  })
})

describe('issueSpecialInvoiceByEmail(メールで対象を指定)', () => {
  it('mail_hash で解決した行と、入力のメール・名前・coverage・activityYear が下位へ渡る', async () => {
    authMocks.getOrCreateUserByMailHash.mockResolvedValue({ id: 'user-target' })
    authMocks.getUserById.mockResolvedValue(TARGET_ROW)

    await call(
      membershipRouter.issueSpecialInvoiceByEmail,
      { email: TARGET_EMAIL, name: '対象 太郎', coverage: 'zenki', activityYear: 2026 },
      { context: membershipContext({ traqId: 'admin' }) },
    )

    // 対象者は入力のメールの mail_hash から引く。
    expect(authMocks.getOrCreateUserByMailHash).toHaveBeenCalledWith(
      expect.anything(),
      TARGET_MAIL_HASH,
    )
    expect(capturedTarget).toEqual({
      userId: 'user-target',
      activityYear: 2026,
      halves: halvesForCoverage('zenki'),
    })
    expect(stripeMocks.getOrCreateCustomer).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        userId: 'user-target',
        stripeCustomerId: 'cus_target',
        email: TARGET_EMAIL,
        name: '対象 太郎',
        mailHash: TARGET_MAIL_HASH,
      },
    )
    expect(stripeMocks.createDraftInvoice).toHaveBeenCalledWith(expect.anything(), {
      customerId: 'cus_resolved',
      priceId: 'price_keizoku_special',
      daysUntilDue: 7,
      metadata: {
        fee_type: 'continuation',
        variant: 'special',
        coverage: 'zenki',
        activity_year: '2026',
      },
    })
  })

  it('許可されていないドメインのメールは対象者を解決する前に拒否される', async () => {
    await expect(call(
      membershipRouter.issueSpecialInvoiceByEmail,
      { email: 'someone@other.example', coverage: 'zenki' },
      { context: membershipContext({ traqId: 'admin' }) },
    )).rejects.toThrow()
    expect(authMocks.getOrCreateUserByMailHash).not.toHaveBeenCalled()
  })
})

describe('issueInvoice(本人の標準発行)', () => {
  it('本人の userId と、費目・期から決まる coverage・年度が台帳へ渡る', async () => {
    authMocks.getUserById.mockResolvedValue(TARGET_ROW)
    authMocks.linkTraqId.mockResolvedValue('linked')

    const now = new Date()
    await call(
      membershipRouter.issueInvoice,
      { email: TARGET_EMAIL, name: '対象 太郎', feeType: 'continuation' },
      { context: membershipContext({ userId: 'user-target', mailHash: TARGET_MAIL_HASH, traqId: 'target_traq' }) },
    )

    expect(capturedTarget).toEqual({
      userId: 'user-target',
      activityYear: standardActivityYear(now, 'continuation'),
      halves: halvesForCoverage(standardCoverage('continuation', computeTerm(now))),
    })
    expect(stripeMocks.createDraftInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ priceId: 'price_keizoku_standard' }),
    )
  })

  it('他人のメールでは発行できない', async () => {
    await expect(call(
      membershipRouter.issueInvoice,
      { email: 'other@isct.example', name: '別人', feeType: 'new' },
      { context: membershipContext({ userId: 'user-target', mailHash: TARGET_MAIL_HASH }) },
    )).rejects.toThrow()
    expect(ledgerMocks.issueWithLedger).not.toHaveBeenCalled()
  })
})
