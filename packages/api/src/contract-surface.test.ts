import { describe, expect, it } from 'vitest'
import { call, implement, os } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { contract } from '@checkin/api-contract'

/**
 * 契約が公開面を決めていることを固定するテスト。2 つのことを見る。
 *
 * 1. 契約が RPC の経路表を閉じること(下の「契約が RPC の公開面を塞ぐ」)。
 * 2. 契約の出力 allowlist が、実装が返した余分なフィールドを剥がし、載せると決めた
 *    フィールドだけを通すこと(下の 3 つの describe)。
 *
 * どちらも `@orpc/server` の内部のファイル名・行番号・識別子を一つも参照せず、公開された
 * `implement` / `RPCHandler` / `call` の挙動だけを見る。版を上げて挙動が変わった日に落ちる。
 *
 * 2 を実装側ではなく契約側の性質として見るのは、剥がされることが UI の型チェックにも
 * 実行時のエラーにも現れないためである。契約からフィールドを落とすと、実装が返していても
 * 応答から静かに消える。会計担当者の画面は processApproved の要約を
 * `v-for="(value, key) in processSummary"` で総称的に表示しているので、消えても画面が
 * 壊れず、誰も気付かない。
 */

// ---------------------------------------------------------------------------
// 1. 契約が RPC の経路表を閉じること
// ---------------------------------------------------------------------------

/**
 * この検査だけのための最小の契約。アプリケーションの契約から 2 つのプロシージャを借りて作る。
 *
 * 借りるのは、`oc` を提供する `@orpc/contract` が `packages/api` の依存に無いためである。
 * 依存に足すと、サーバー実装のパッケージが契約定義の道具にも依存することになる。借りた
 * 2 つがどのプロシージャであるかは、ここで見る性質(経路が一致するかどうか)に関係しない。
 */
const probeContract = {
  inContract: contract.auth.me,
  alsoInContract: contract.payouts.onboardingStatus,
}

const probeImplementer = implement(probeContract)

/**
 * 契約の 2 キーをすべて実装し、それに加えて契約に無いキーを 1 つ置いたルーター。
 *
 * 契約のキーを 1 つでも落とすと `implementer.router` が型エラーになるので、契約に載って
 * いるものはすべて実装する。逆に契約に無い `notInContract` を足しても型エラーにならない。
 * この非対称が、ここで実行時に確かめる対象そのものである。
 */
const probeRouter = probeImplementer.router({
  inContract: probeImplementer.inContract.handler(() => ({
    authenticated: false,
    member: false,
    admin: false,
    hasUser: false,
    traqId: null,
  })),
  alsoInContract: probeImplementer.alsoInContract.handler(() => ({
    status: 'none',
    hasConnectedAccount: false,
  })),
  notInContract: os.handler(() => ({ ok: true })),
})

/**
 * ルーターの 1 経路を RPC で叩き、経路が一致したかどうかを返す。
 *
 * 引数の型を `probeRouter` そのものにしているのは、展開して作り直したルーターも同じ形を
 * 持つので同じ引数で渡せるためである。ライブラリのルーター型の名前をここに書かずに済む。
 */
async function probe(target: typeof probeRouter, path: string): Promise<boolean> {
  const handler = new RPCHandler(target)
  const { matched } = await handler.handle(
    new Request(`http://localhost/rpc${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { userId: 'u1' } }),
    }),
    { prefix: '/rpc', context: {} },
  )
  return matched
}

describe('契約が RPC の公開面を塞ぐ', () => {
  it('契約に載っているキーの経路は一致する', async () => {
    expect(await probe(probeRouter, '/inContract')).toBe(true)
    expect(await probe(probeRouter, '/alsoInContract')).toBe(true)
  })

  it('契約に無いキーを実装に置いても、その経路は一致しない', async () => {
    expect(await probe(probeRouter, '/notInContract')).toBe(false)
  })

  it('定義していないキーの経路は一致しない', async () => {
    expect(await probe(probeRouter, '/neverDefined')).toBe(false)
  })

  it('展開して作り直したルーターでは、契約に無いキーの経路が一致する', async () => {
    // ルーターの組み立て方を変えた後も「契約に無いから外へ出ていない」と判断すると誤る。
    const rebuilt = { ...probeRouter }
    expect(await probe(rebuilt, '/notInContract')).toBe(true)
    // 作り直しても契約のキーは一致し続け、定義していないキーは一致しない。上の一致が
    // 「作り直すと何でも通る」という別の理由で起きたのではないことを確かめる。
    expect(await probe(rebuilt, '/inContract')).toBe(true)
    expect(await probe(rebuilt, '/neverDefined')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. 契約の出力 allowlist
// ---------------------------------------------------------------------------

/** 有効な ISO 8601 の時刻。`new Date(...).toISOString()` が返すのと同じ形。 */
const ISO = '2026-09-18T01:23:45.000Z'

/**
 * `processApproved` の要約のスタブ。契約に載せると決めた 11 フィールドに加えて、
 * ドメイン層の要約型が持つ `listError` を返す。
 */
const summaryWithListError = {
  ingested: 3,
  paid: 1,
  onboardingWaiting: 1,
  unresolved: 0,
  failed: 0,
  alreadyPaid: 1,
  needsReview: 0,
  skippedFailed: 0,
  errored: 0,
  errors: [],
  multiPayeeRefs: [],
  listError: 'jomon list failed: 503',
}

/** `payouts.list` の 1 行のスタブ。時刻は引数で差し替えられる。 */
function payoutRow(times: { jomonWrittenBackAt: string | null, manualPaidAt: string | null }) {
  return {
    id: 'po_1',
    jomonRef: 'jomon-1',
    userId: 'u1',
    amount: 1000,
    currency: 'jpy',
    status: 'paid',
    stripeTransferId: 'tr_1',
    jomonWrittenBackAt: times.jomonWrittenBackAt,
    payoutMethod: 'manual_bank',
    manualPaidNote: 'メモ',
    manualPaidAt: times.manualPaidAt,
    manualPaidBy: 'u2',
  } as const
}

/** `payments` の 1 行のスタブ。`createdAt` は引数で差し替えられる。 */
function paymentRow(createdAt: string) {
  return {
    id: 'in_1',
    amount: 4000,
    currency: 'jpy',
    createdAt,
    customer: { id: 'cus_1', name: 'テスト太郎' },
    paymentStatus: 'paid',
    paymentId: 'pi_1',
    product: { priceId: 'price_1', description: '新規入部費' },
    dashboardUrl: 'https://dashboard.stripe.com/test/invoices/in_1',
  }
}

/** `payouts` の契約を、一覧と要約だけスタブで差し替えて実装したルーター。 */
function payoutsRouter(stubs: {
  summary: typeof summaryWithListError
  page: { data: ReturnType<typeof payoutRow>[], nextCursor: string | null }
}) {
  const impl = implement(contract.payouts)
  const step = { jomonRef: 'jomon-1', outcome: 'paid', status: 'paid' } as const
  return impl.router({
    createOnboardingLink: impl.createOnboardingLink.handler(() => ({
      url: 'https://connect.stripe.com/setup/e/test',
    })),
    onboardingStatus: impl.onboardingStatus.handler(() => ({
      status: 'none',
      hasConnectedAccount: false,
    })),
    processApproved: impl.processApproved.handler(() => stubs.summary),
    list: impl.list.handler(() => stubs.page),
    execute: impl.execute.handler(() => step),
    markManuallyPaid: impl.markManuallyPaid.handler(() => step),
  })
}

/** `payments` の契約を、一覧の行だけスタブで差し替えて実装したルーター。 */
function paymentsRouter(row: ReturnType<typeof paymentRow>) {
  const impl = implement(contract.payments)
  const page = { data: [row], nextCursor: null }
  return impl.router({
    listInvoices: impl.listInvoices.handler(() => page),
    listCheckoutSessions: impl.listCheckoutSessions.handler(() => page),
  })
}

/** 契約に載せると決めた `processApproved` の応答のフィールド。 */
const PROCESS_APPROVED_FIELDS = [
  'alreadyPaid',
  'errored',
  'errors',
  'failed',
  'ingested',
  'multiPayeeRefs',
  'needsReview',
  'onboardingWaiting',
  'paid',
  'skippedFailed',
  'unresolved',
]

describe('payouts.processApproved の応答のフィールド', () => {
  it('ドメイン層の listError は応答に現れない', async () => {
    const router = payoutsRouter({
      summary: summaryWithListError,
      page: { data: [], nextCursor: null },
    })
    const result = await call(router.processApproved, undefined, { context: {} })
    expect(Object.keys(result)).not.toContain('listError')
  })

  it('契約に無いフィールドは弾かれずに剥がされる', async () => {
    // 契約を厳格にして弾く形は採らない。Stripe 由来の値が増えたときに出力検証が弾いて
    // 500 になるのを避ける方針を、この契約全体で採っているためである。したがって
    // 「弾かれる」ことは観点にできず、実装が余分なフィールドを返しても応答は成功する。
    const router = payoutsRouter({
      summary: summaryWithListError,
      page: { data: [], nextCursor: null },
    })
    const result = await call(router.processApproved, undefined, { context: {} })
    expect(result.ingested).toBe(3)
  })

  it('応答のフィールドの集合が、契約で載せると決めた集合と一致する', async () => {
    // 過不足の両方を見る。不足を見るのは、契約からフィールドを落としても、実装が返す限り
    // 型でも実行時でも落ちず、応答から静かに消えるだけだからである。
    const router = payoutsRouter({
      summary: summaryWithListError,
      page: { data: [], nextCursor: null },
    })
    const result = await call(router.processApproved, undefined, { context: {} })
    expect(Object.keys(result).sort()).toEqual(PROCESS_APPROVED_FIELDS)
  })
})

describe('payouts.list の応答の形', () => {
  it('data と nextCursor だけを持ち、実装が足した items と hasMore は現れない', async () => {
    const page = {
      data: [payoutRow({ jomonWrittenBackAt: ISO, manualPaidAt: ISO })],
      nextCursor: null,
      // 統合前の一覧の形。契約に無いので剥がされる。
      items: [],
      hasMore: true,
    }
    const router = payoutsRouter({ summary: summaryWithListError, page })
    const result = await call(router.list, {}, { context: {} })
    expect(Object.keys(result).sort()).toEqual(['data', 'nextCursor'])
  })

  it('nextCursor が null の応答を受理する', async () => {
    // ページネーションを持たない現在の実装は nextCursor を常に null で返す。常に null で
    // あることは実装が決めることで、契約は null と文字列のどちらも受理する(main の 4 機能と
    // 同じ listEnvelope を使うため)。ここで見るのは、その null が契約を通ることである。
    const page = {
      data: [payoutRow({ jomonWrittenBackAt: null, manualPaidAt: null })],
      nextCursor: null,
    }
    const router = payoutsRouter({ summary: summaryWithListError, page })
    const result = await call(router.list, {}, { context: {} })
    expect(result.nextCursor).toBeNull()
    expect(result.data).toHaveLength(1)
  })
})

describe('時刻のフィールドは ISO 8601 の文字列として検証される', () => {
  it('payouts.list の jomonWrittenBackAt が ISO 8601 でなければ応答が失敗する', async () => {
    const page = {
      data: [payoutRow({ jomonWrittenBackAt: '2026-09-18 01:23:45', manualPaidAt: ISO })],
      nextCursor: null,
    }
    const router = payoutsRouter({ summary: summaryWithListError, page })
    await expect(call(router.list, {}, { context: {} })).rejects.toThrow()
  })

  it('payouts.list の manualPaidAt が ISO 8601 でなければ応答が失敗する', async () => {
    const page = {
      data: [payoutRow({ jomonWrittenBackAt: ISO, manualPaidAt: '1758158625' })],
      nextCursor: null,
    }
    const router = payoutsRouter({ summary: summaryWithListError, page })
    await expect(call(router.list, {}, { context: {} })).rejects.toThrow()
  })

  it('payouts.list の時刻が ISO 8601 か null なら応答が成功する', async () => {
    const page = {
      data: [payoutRow({ jomonWrittenBackAt: ISO, manualPaidAt: null })],
      nextCursor: null,
    }
    const router = payoutsRouter({ summary: summaryWithListError, page })
    const result = await call(router.list, {}, { context: {} })
    expect(result.data[0]?.jomonWrittenBackAt).toBe(ISO)
    expect(result.data[0]?.manualPaidAt).toBeNull()
  })

  it('payments の createdAt が ISO 8601 でなければ応答が失敗する', async () => {
    const router = paymentsRouter(paymentRow('2026/09/18'))
    await expect(call(router.listInvoices, {}, { context: {} })).rejects.toThrow()
  })

  it('payments の createdAt が ISO 8601 なら応答が成功する', async () => {
    const router = paymentsRouter(paymentRow(ISO))
    const result = await call(router.listInvoices, {}, { context: {} })
    expect(result.data[0]?.createdAt).toBe(ISO)
  })
})

describe('payments の行が公開するフィールド', () => {
  it('会計担当者向けの一覧は顧客名を含む', async () => {
    // 同じ Stripe Invoice に対して invoices.list は customer を ID のみで返す。2 つの
    // 公開範囲が並ぶのは消費者が違うためで、会計担当者の画面には顧客名が要る。
    const router = paymentsRouter(paymentRow(ISO))
    const result = await call(router.listInvoices, {}, { context: {} })
    expect(result.data[0]?.customer.name).toBe('テスト太郎')
  })
})
