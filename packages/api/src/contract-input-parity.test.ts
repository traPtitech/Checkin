import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { call, implement } from '@orpc/server'
import { z } from 'zod'
import { contract } from '@checkin/api-contract'

/**
 * 入力検証の受理範囲が、契約への移設で変わっていないことを固定するテスト。
 *
 * 移設は zod 3(`packages/api` のローカルの依存)から zod 4(`@checkin/api-contract` の依存)
 * への移動を伴うので、移設後のスキーマだけを測っても「新しい zod での受理範囲」が分かるだけで、
 * 移設で受理範囲が変わったかどうかは分からない。ここでは移設前のスキーマをこのパッケージの
 * zod 3 で組み直し、契約側の zod 4 のスキーマと同じ入力の集合を通して、受理と拒否を比べる。
 * 1 つのファイルから 2 つの版の zod を import する経路は無いので、比較は「zod 3 の
 * safeParse」と「契約を実装した手続きを呼んでハンドラに到達したか」の 2 つの手段で行う。
 *
 * 契約側の受理・拒否は公開 API だけで測る。`call` が入力検証に失敗すれば例外になり、
 * ハンドラには到達しない。到達したかどうかを sentinel で記録するので、契約の内部表現
 * (`~orpc` 等)を一切参照せずに受理範囲が分かる。
 *
 * 意図して変えた差は {@link EXPECTED_DIFFERENCES} に列挙する。ここに無い差が出たら失敗する。
 */

// ---------------------------------------------------------------------------
// このテストが依拠している前提
// ---------------------------------------------------------------------------

/**
 * このパッケージが解決する zod のメジャーバージョン。
 *
 * この比較は、`packages/api` が zod 3 を、`@checkin/api-contract` が zod 4 を解決することに
 * 依拠している。`packages/api` を zod 4 へ上げると、上の `legacySchemas` も契約側と同じ版で
 * 組まれることになり、比較が zod 4 どうしの自己比較に静かに変わる。そのとき受理範囲が
 * 変わっていても差は出ないので、テストは緑のまま主張を測らなくなる。前提そのものを
 * 検査に載せて、上げた日に落ちるようにする。
 */
function zodMajor(): number {
  const pkg: unknown = createRequire(import.meta.url)('zod/package.json')
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') {
    return Number.NaN
  }
  return Number(pkg.version.split('.')[0])
}

describe('比較が依拠している前提', () => {
  it('packages/api が解決する zod は major 3 である', () => {
    expect(zodMajor()).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 移設前のスキーマ(auth ブランチの packages/api/src/router.ts の `.input(...)`)
// ---------------------------------------------------------------------------

const legacySchemas = {
  'auth.requestEmailVerification': z.object({
    email: z.string().email(),
    redirect: z.string().optional(),
  }),
  'membership.issueInvoice': z.object({
    email: z.string().email(),
    name: z.string().min(1),
    feeType: z.enum(['new', 'continuation']),
  }),
  'membership.issueSpecialInvoice': z.object({
    userId: z.string().min(1),
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    coverage: z.enum(['zenki', 'kouki']),
    activityYear: z.number().int().optional(),
  }),
  'membership.issueSpecialInvoiceByEmail': z.object({
    email: z.string().email(),
    name: z.string().min(1).optional(),
    coverage: z.enum(['zenki', 'kouki']),
    activityYear: z.number().int().optional(),
  }),
  'payments.listInvoices': z.object({
    status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']).optional(),
    limit: z.number().int().optional(),
    startingAfter: z.string().optional(),
  }),
  'payments.listCheckoutSessions': z.object({
    status: z.enum(['open', 'complete', 'expired']).optional(),
    limit: z.number().int().optional(),
    startingAfter: z.string().optional(),
  }),
  'payouts.createOnboardingLink': z.object({ userId: z.string().min(1) }),
  'payouts.onboardingStatus': z.object({ userId: z.string().min(1) }),
  'payouts.list': z.object({
    status: z.enum(['pending', 'onboarding_waiting', 'processing', 'paid', 'failed']).optional(),
  }),
  'payouts.execute': z.object({ jomonRef: z.string().min(1) }),
  'payouts.markManuallyPaid': z.object({
    jomonRef: z.string().min(1),
    note: z.string().max(255).optional(),
  }),
} as const

type ProcedureName = keyof typeof legacySchemas

// ---------------------------------------------------------------------------
// 契約側(zod 4)の受理範囲を公開 API だけで測る
// ---------------------------------------------------------------------------

/** ハンドラに到達したことを記録する sentinel。入力検証を通ったときだけ立つ。 */
const reached = { value: false }

/** 到達を記録して必ず投げるハンドラ。戻り値の型は never なのでどの出力契約にも当てはまる。 */
function probeHandler(): never {
  reached.value = true
  throw new Error('probe: handler reached')
}

const authImpl = implement(contract.auth)
const membershipImpl = implement(contract.membership)
const paymentsImpl = implement(contract.payments)
const payoutsImpl = implement(contract.payouts)

/* eslint-disable @typescript-eslint/consistent-type-assertions -- 契約の入力型で弾かれる不正な入力も通すため、呼び出し時だけ型を外す */
const contractProbes: Record<ProcedureName, (input: unknown) => Promise<unknown>> = {
  'auth.requestEmailVerification': input =>
    call(authImpl.requestEmailVerification.handler(probeHandler), input as never, { context: {} }),
  'membership.issueInvoice': input =>
    call(membershipImpl.issueInvoice.handler(probeHandler), input as never, { context: {} }),
  'membership.issueSpecialInvoice': input =>
    call(membershipImpl.issueSpecialInvoice.handler(probeHandler), input as never, { context: {} }),
  'membership.issueSpecialInvoiceByEmail': input =>
    call(membershipImpl.issueSpecialInvoiceByEmail.handler(probeHandler), input as never, { context: {} }),
  'payments.listInvoices': input =>
    call(paymentsImpl.listInvoices.handler(probeHandler), input as never, { context: {} }),
  'payments.listCheckoutSessions': input =>
    call(paymentsImpl.listCheckoutSessions.handler(probeHandler), input as never, { context: {} }),
  'payouts.createOnboardingLink': input =>
    call(payoutsImpl.createOnboardingLink.handler(probeHandler), input as never, { context: {} }),
  'payouts.onboardingStatus': input =>
    call(payoutsImpl.onboardingStatus.handler(probeHandler), input as never, { context: {} }),
  'payouts.list': input =>
    call(payoutsImpl.list.handler(probeHandler), input as never, { context: {} }),
  'payouts.execute': input =>
    call(payoutsImpl.execute.handler(probeHandler), input as never, { context: {} }),
  'payouts.markManuallyPaid': input =>
    call(payoutsImpl.markManuallyPaid.handler(probeHandler), input as never, { context: {} }),
}
/* eslint-enable @typescript-eslint/consistent-type-assertions */

/** 契約側がこの入力を受理するか。ハンドラに到達したかどうかで測る。 */
async function contractAccepts(name: ProcedureName, input: unknown): Promise<boolean> {
  reached.value = false
  try {
    await contractProbes[name](input)
  }
  catch {
    // 入力検証の失敗も、到達後の sentinel も、どちらもここに来る。判定は reached で行う。
  }
  return reached.value
}

/** 移設前のスキーマがこの入力を受理するか。 */
function legacyAccepts(name: ProcedureName, input: unknown): boolean {
  return legacySchemas[name].safeParse(input).success
}

// ---------------------------------------------------------------------------
// 通す入力の集合
// ---------------------------------------------------------------------------

/**
 * メールアドレスの境界。`z.string().email()`(zod 3)は 4 箇所移したので、受理範囲が
 * 変わるとすればここに出る。
 */
const EMAILS = [
  'a@b.co',
  'a@b',
  '"quoted"@b.co',
  'a@b.',
  'a@@b.co',
  'a b@c.co',
  '',
  'A@B.CO',
  'a+tag@b.co',
  'a@b.co ',
]

/** 手続きごとに通す入力。ラベルは失敗時に差を読めるようにするためのもの。 */
const CASES: { name: ProcedureName, inputs: { label: string, value: unknown }[] }[] = [
  {
    name: 'auth.requestEmailVerification',
    inputs: [
      ...EMAILS.map(email => ({ label: `email=${JSON.stringify(email)}`, value: { email } })),
      { label: 'redirect 付き', value: { email: 'a@b.co', redirect: '/home' } },
      { label: 'redirect が空文字', value: { email: 'a@b.co', redirect: '' } },
      { label: 'redirect が数値', value: { email: 'a@b.co', redirect: 1 } },
      { label: 'email が無い', value: {} },
      { label: 'email が数値', value: { email: 1 } },
      { label: '余分なキー', value: { email: 'a@b.co', extra: 'x' } },
      { label: 'undefined', value: undefined },
      { label: 'null', value: null },
      { label: '配列', value: [] },
    ],
  },
  {
    name: 'membership.issueInvoice',
    inputs: [
      ...EMAILS.map(email => ({
        label: `email=${JSON.stringify(email)}`,
        value: { email, name: 'n', feeType: 'new' },
      })),
      { label: '正常(continuation)', value: { email: 'a@b.co', name: 'n', feeType: 'continuation' } },
      { label: 'name が空文字', value: { email: 'a@b.co', name: '', feeType: 'new' } },
      { label: 'name が無い', value: { email: 'a@b.co', feeType: 'new' } },
      { label: 'feeType が範囲外', value: { email: 'a@b.co', name: 'n', feeType: 'other' } },
      { label: 'feeType が無い', value: { email: 'a@b.co', name: 'n' } },
    ],
  },
  {
    name: 'membership.issueSpecialInvoice',
    inputs: [
      { label: '正常(最小)', value: { userId: 'u1', coverage: 'zenki' } },
      { label: '正常(全部)', value: { userId: 'u1', name: 'n', email: 'a@b.co', coverage: 'kouki', activityYear: 2026 } },
      ...EMAILS.map(email => ({
        label: `email=${JSON.stringify(email)}`,
        value: { userId: 'u1', coverage: 'zenki', email },
      })),
      { label: 'userId が空文字', value: { userId: '', coverage: 'zenki' } },
      { label: 'userId が無い', value: { coverage: 'zenki' } },
      { label: 'name が空文字', value: { userId: 'u1', coverage: 'zenki', name: '' } },
      { label: 'coverage が範囲外', value: { userId: 'u1', coverage: 'full' } },
      { label: 'activityYear が小数', value: { userId: 'u1', coverage: 'zenki', activityYear: 2026.5 } },
      { label: 'activityYear が負の整数', value: { userId: 'u1', coverage: 'zenki', activityYear: -1 } },
      { label: 'activityYear が文字列', value: { userId: 'u1', coverage: 'zenki', activityYear: '2026' } },
      { label: 'activityYear が NaN', value: { userId: 'u1', coverage: 'zenki', activityYear: Number.NaN } },
    ],
  },
  {
    name: 'membership.issueSpecialInvoiceByEmail',
    inputs: [
      ...EMAILS.map(email => ({ label: `email=${JSON.stringify(email)}`, value: { email, coverage: 'zenki' } })),
      { label: '正常(全部)', value: { email: 'a@b.co', name: 'n', coverage: 'kouki', activityYear: 2026 } },
      { label: 'name が空文字', value: { email: 'a@b.co', coverage: 'zenki', name: '' } },
      { label: 'coverage が無い', value: { email: 'a@b.co' } },
      { label: 'activityYear が小数', value: { email: 'a@b.co', coverage: 'zenki', activityYear: 2026.5 } },
    ],
  },
  {
    name: 'payments.listInvoices',
    inputs: [
      { label: '空', value: {} },
      { label: 'status=draft', value: { status: 'draft' } },
      { label: 'status が範囲外', value: { status: 'open2' } },
      { label: 'limit=1', value: { limit: 1 } },
      { label: 'limit=100', value: { limit: 100 } },
      { label: 'limit=0', value: { limit: 0 } },
      { label: 'limit=101', value: { limit: 101 } },
      { label: 'limit=-5', value: { limit: -5 } },
      { label: 'limit が小数', value: { limit: 10.5 } },
      { label: 'limit が文字列', value: { limit: '10' } },
      { label: 'startingAfter が空文字', value: { startingAfter: '' } },
      { label: 'startingAfter=in_1', value: { startingAfter: 'in_1' } },
      { label: 'startingAfter が数値', value: { startingAfter: 1 } },
    ],
  },
  {
    name: 'payments.listCheckoutSessions',
    inputs: [
      { label: '空', value: {} },
      { label: 'status=complete', value: { status: 'complete' } },
      { label: 'status が範囲外(draft)', value: { status: 'draft' } },
      { label: 'limit=1', value: { limit: 1 } },
      { label: 'limit=100', value: { limit: 100 } },
      { label: 'limit=0', value: { limit: 0 } },
      { label: 'limit=101', value: { limit: 101 } },
      { label: 'limit が小数', value: { limit: 10.5 } },
      { label: 'startingAfter が空文字', value: { startingAfter: '' } },
      { label: 'startingAfter=cs_1', value: { startingAfter: 'cs_1' } },
    ],
  },
  {
    name: 'payouts.createOnboardingLink',
    inputs: [
      { label: '正常', value: { userId: 'u1' } },
      { label: 'userId が空文字', value: { userId: '' } },
      { label: 'userId が無い', value: {} },
      { label: 'userId が数値', value: { userId: 1 } },
      { label: '余分なキー', value: { userId: 'u1', extra: 'x' } },
    ],
  },
  {
    name: 'payouts.onboardingStatus',
    inputs: [
      { label: '正常', value: { userId: 'u1' } },
      { label: 'userId が空文字', value: { userId: '' } },
      { label: 'userId が無い', value: {} },
    ],
  },
  {
    name: 'payouts.list',
    inputs: [
      { label: '空', value: {} },
      { label: 'status=pending', value: { status: 'pending' } },
      { label: 'status=processing', value: { status: 'processing' } },
      { label: 'status が範囲外', value: { status: 'unknown' } },
      { label: 'status が null', value: { status: null } },
    ],
  },
  {
    name: 'payouts.execute',
    inputs: [
      { label: '正常', value: { jomonRef: 'j1' } },
      { label: 'jomonRef が空文字', value: { jomonRef: '' } },
      { label: 'jomonRef が無い', value: {} },
    ],
  },
  {
    name: 'payouts.markManuallyPaid',
    inputs: [
      { label: '正常(note 無し)', value: { jomonRef: 'j1' } },
      { label: '正常(note 有り)', value: { jomonRef: 'j1', note: 'メモ' } },
      { label: 'jomonRef が空文字', value: { jomonRef: '', note: 'メモ' } },
      { label: 'note が 255 文字', value: { jomonRef: 'j1', note: 'x'.repeat(255) } },
      { label: 'note が 256 文字', value: { jomonRef: 'j1', note: 'x'.repeat(256) } },
      { label: 'note が空文字', value: { jomonRef: 'j1', note: '' } },
    ],
  },
]

/**
 * 意図して変えた差。`payments` の 2 つの一覧の入力を main の `params.ts` の `pagination`
 * に合わせた結果である(limit を 1..100 に狭め、startingAfter に最小長 1 を課した)。
 * ここに無い差が出たら、移設で意図せず受理範囲が変わっている。
 */
const EXPECTED_DIFFERENCES: string[] = [
  'payments.listCheckoutSessions / limit=0: 移設前=受理 契約側=拒否',
  'payments.listCheckoutSessions / limit=101: 移設前=受理 契約側=拒否',
  'payments.listCheckoutSessions / startingAfter が空文字: 移設前=受理 契約側=拒否',
  'payments.listInvoices / limit=-5: 移設前=受理 契約側=拒否',
  'payments.listInvoices / limit=0: 移設前=受理 契約側=拒否',
  'payments.listInvoices / limit=101: 移設前=受理 契約側=拒否',
  'payments.listInvoices / startingAfter が空文字: 移設前=受理 契約側=拒否',
]

describe('契約への移設で入力検証の受理範囲が変わっていないこと', () => {
  it('移設前(zod 3)と契約側(zod 4)の受理・拒否が、意図した差を除いて一致する', async () => {
    const differences: string[] = []
    for (const { name, inputs } of CASES) {
      for (const { label, value } of inputs) {
        const before = legacyAccepts(name, value)
        const after = await contractAccepts(name, value)
        if (before !== after) {
          differences.push(`${name} / ${label}: 移設前=${before ? '受理' : '拒否'} 契約側=${after ? '受理' : '拒否'}`)
        }
      }
    }
    expect(differences.sort()).toEqual(EXPECTED_DIFFERENCES)
  })

  it('比較の手段そのものが差を検出できる(自己検査)', async () => {
    // 上の検査が「どの入力でも両側が同じ答えを返す」ことでなく、実際に受理と拒否を
    // 見分けていることを確かめる。見分けていなければ、受理範囲が変わっても気付けない。
    expect(legacyAccepts('payouts.execute', { jomonRef: 'j1' })).toBe(true)
    expect(legacyAccepts('payouts.execute', { jomonRef: '' })).toBe(false)
    expect(await contractAccepts('payouts.execute', { jomonRef: 'j1' })).toBe(true)
    expect(await contractAccepts('payouts.execute', { jomonRef: '' })).toBe(false)
  })
})
