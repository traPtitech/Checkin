import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call } from '@orpc/server'
import type { Context } from '../orpc'
import { paymentsRouter } from './router'

/**
 * `payments` の 2 つの一覧が、契約実装形への移設の後も移設前と同じ値を Stripe アダプタへ渡し、
 * 契約の封筒で返すことを固定するテスト。
 *
 * 封筒は移設で `{ items, hasMore, nextCursor }` から `{ data, nextCursor }` に変わった。
 * `hasMore` は `nextCursor !== null` から導くので契約に載せない。カーソルの導出そのものは
 * 移設前と同じ `nextCursor(items, hasMore)` なので、`has_more` が真のときだけ最後の行の id に
 * なることを見る。`limit` の既定値 20 は契約ではなく実装側の `clampLimit` に残っている。
 */

const stripeMocks = vi.hoisted(() => ({
  listInvoices: vi.fn(),
  listCheckoutSessions: vi.fn(),
}))
vi.mock('../stripe', () => stripeMocks)

/** handler が読むものだけを供給する Context。`sk_test_` なので dashboard は test 面になる。 */
function adminContext(): Context {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- handler が読む依存だけを供給する意図的なテストスタブ
  return {
    db: {},
    stripe: {},
    billing: { stripeSecretKey: 'sk_test_x' },
    session: { isAdmin: true },
    requireAdmin: () => ({ traqId: 'admin' }),
    assertCsrf: () => {},
  } as unknown as Context
}

/** Stripe の Invoice のうち、正規化が読むフィールドだけを持つ最小のフィクスチャ。 */
function invoice(id: string) {
  return {
    id,
    amount_due: 4000,
    currency: 'jpy',
    created: 1758000000,
    customer: 'cus_1',
    customer_name: 'テスト太郎',
    status: 'paid',
    lines: { data: [] },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('payments.listInvoices の封筒', () => {
  it('has_more が真なら nextCursor は最後の行の id になり、行は data に入る', async () => {
    stripeMocks.listInvoices.mockResolvedValue({
      data: [invoice('in_1'), invoice('in_2')],
      has_more: true,
    })

    const result = await call(paymentsRouter.listInvoices, {}, { context: adminContext() })

    expect(Object.keys(result).sort()).toEqual(['data', 'nextCursor'])
    expect(result.data.map(row => row.id)).toEqual(['in_1', 'in_2'])
    expect(result.nextCursor).toBe('in_2')
  })

  it('has_more が偽なら nextCursor は null になる', async () => {
    stripeMocks.listInvoices.mockResolvedValue({ data: [invoice('in_1')], has_more: false })

    const result = await call(paymentsRouter.listInvoices, {}, { context: adminContext() })

    expect(result.nextCursor).toBeNull()
  })

  it('limit を省くと clampLimit の既定値 20 がアダプタへ渡る', async () => {
    stripeMocks.listInvoices.mockResolvedValue({ data: [], has_more: false })

    await call(paymentsRouter.listInvoices, {}, { context: adminContext() })

    expect(stripeMocks.listInvoices).toHaveBeenCalledWith(expect.anything(), {
      status: undefined,
      limit: 20,
      startingAfter: undefined,
    })
  })

  it('status と startingAfter と limit はそのままアダプタへ渡る', async () => {
    stripeMocks.listInvoices.mockResolvedValue({ data: [], has_more: false })

    await call(
      paymentsRouter.listInvoices,
      { status: 'open', limit: 5, startingAfter: 'in_0' },
      { context: adminContext() },
    )

    expect(stripeMocks.listInvoices).toHaveBeenCalledWith(expect.anything(), {
      status: 'open',
      limit: 5,
      startingAfter: 'in_0',
    })
  })
})

describe('payments.listCheckoutSessions の封筒', () => {
  /** Checkout Session のうち、正規化が読むフィールドだけを持つ最小のフィクスチャ。 */
  function session(id: string) {
    return {
      id,
      amount_total: 4000,
      currency: 'jpy',
      created: 1758000000,
      customer: 'cus_1',
      customer_details: { name: 'テスト太郎' },
      payment_status: 'paid',
      payment_intent: 'pi_1',
    }
  }

  it('同じ封筒とカーソルの導出を使う', async () => {
    stripeMocks.listCheckoutSessions.mockResolvedValue({
      data: [session('cs_1'), session('cs_2')],
      has_more: true,
    })

    const result = await call(paymentsRouter.listCheckoutSessions, {}, { context: adminContext() })

    expect(Object.keys(result).sort()).toEqual(['data', 'nextCursor'])
    expect(result.nextCursor).toBe('cs_2')
  })

  it('status はこの capability の enum のままアダプタへ渡る', async () => {
    stripeMocks.listCheckoutSessions.mockResolvedValue({ data: [], has_more: false })

    await call(
      paymentsRouter.listCheckoutSessions,
      { status: 'complete' },
      { context: adminContext() },
    )

    expect(stripeMocks.listCheckoutSessions).toHaveBeenCalledWith(expect.anything(), {
      status: 'complete',
      limit: 20,
      startingAfter: undefined,
    })
  })
})
