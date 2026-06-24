import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJomonClient } from './factory'
import { JomonV1Client, JomonV2Client, JomonWriteBackUnsupportedError } from './http'
import { StubJomonClient } from './stub'
import type { JomonTransferRequest } from './types'

const seed: JomonTransferRequest[] = [
  { jomonRef: 'jmn_1', payeeTraqId: 'alice', amount: 4000, currency: 'jpy' },
  { jomonRef: 'jmn_2', payeeTraqId: 'bob', amount: 2000, currency: 'jpy' },
]

describe('createJomonClient', () => {
  it('defaults to the in-memory stub driver', () => {
    const client = createJomonClient({ version: 'stub', baseUrl: '', token: '', payoutCurrency: 'jpy' })
    expect(client).toBeInstanceOf(StubJomonClient)
  })

  it('seeds the stub from config', async () => {
    const client = createJomonClient({
      version: 'stub',
      baseUrl: '',
      token: '',
      payoutCurrency: 'jpy',
      stubApproved: seed,
    })
    const approved = await client.listApprovedTransferRequests()
    expect(approved.map(r => r.jomonRef)).toEqual(['jmn_1', 'jmn_2'])
  })
})

describe('StubJomonClient', () => {
  it('returns a copy so callers cannot mutate the internal list', async () => {
    const client = new StubJomonClient(seed)
    const first = await client.listApprovedTransferRequests()
    first.pop()
    const second = await client.listApprovedTransferRequests()
    expect(second).toHaveLength(2)
  })

  it('records write-backs and removes the settled request from approved', async () => {
    const client = new StubJomonClient(seed)
    await client.writeBackResult('jmn_1', { status: 'paid', stripeTransferId: 'tr_123' })

    expect(client.writeBacks).toEqual([
      { jomonRef: 'jmn_1', result: { status: 'paid', stripeTransferId: 'tr_123' } },
    ])
    const remaining = await client.listApprovedTransferRequests()
    expect(remaining.map(r => r.jomonRef)).toEqual(['jmn_2'])
  })

  it('records a failure write-back', async () => {
    const client = new StubJomonClient(seed)
    await client.writeBackResult('jmn_2', { status: 'failed', message: 'boom' })
    expect(client.writeBacks).toEqual([
      { jomonRef: 'jmn_2', result: { status: 'failed', message: 'boom' } },
    ])
  })
})

/**
 * Queue several JSON `ok` responses for sequential `fetch` calls (v1 lists then
 * fetches each application detail; v2 fetches users then applications).
 */
function mockFetchSequence(bodies: unknown[]): void {
  const spy = vi.spyOn(globalThis, 'fetch')
  for (const body of bodies) {
    spy.mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  }
}

describe('JomonV1Client (/api/applications, strict, fail-safe)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const client = new JomonV1Client('https://jomon.test', 'token')

  it('normalizes a single-payee application by trap_id (amount = current_detail.amount)', async () => {
    mockFetchSequence([
      // 1. list ?current_state=accepted (compact, no per-payee data)
      [{ application_id: 'app_1' }],
      // 2. GET /api/applications/app_1 (detailed) — exactly one payee, unpaid.
      {
        application_id: 'app_1',
        // v1: amount lives at the application level (no per-payee amount).
        current_detail: { amount: 4000 },
        repayment_logs: [
          { repaid_to_user: { trap_id: 'alice' }, repaid_at: null },
        ],
      },
    ])
    const out = await client.listApprovedTransferRequests()
    // Single payee ⇒ amount = current_detail.amount.
    expect(out).toEqual([
      { jomonRef: 'app_1:alice', payeeTraqId: 'alice', amount: 4000, currency: 'jpy' },
    ])
  })

  it('flags a MULTI-payee application as multiPayee even when only one remains unpaid (no overpay)', async () => {
    // Money-safety: current_detail.amount is the application TOTAL. A 2-payee app
    // with one already repaid must NOT fast-path the remainder the full total —
    // it has no per-payee amount, so it goes to manual review. (Codex Q2)
    mockFetchSequence([
      [{ application_id: 'app_partial' }],
      {
        application_id: 'app_partial',
        current_detail: { amount: 6000 },
        repayment_logs: [
          { repaid_to_user: { trap_id: 'alice' }, repaid_at: null },
          { repaid_to_user: { trap_id: 'bob' }, repaid_at: '2026-01-01' },
        ],
      },
    ])
    expect(await client.listApprovedTransferRequests()).toEqual([
      { jomonRef: 'app_partial', payeeTraqId: '', amount: 6000, currency: 'jpy', multiPayee: true },
    ])
  })

  it('flags an application with MULTIPLE unpaid payees as multiPayee (no auto-pay)', async () => {
    mockFetchSequence([
      [{ application_id: 'app_multi' }],
      {
        application_id: 'app_multi',
        current_detail: { amount: 5000 },
        repayment_logs: [
          { repaid_to_user: { trap_id: 'x' }, repaid_at: null },
          { repaid_to_user: { trap_id: 'y' }, repaid_at: null },
        ],
      },
    ])
    const out = await client.listApprovedTransferRequests()
    // No per-payee amount to split ⇒ a single marker for manual review, no payee.
    expect(out).toEqual([
      { jomonRef: 'app_multi', payeeTraqId: '', amount: 5000, currency: 'jpy', multiPayee: true },
    ])
  })

  it('emits nothing when every payee is already repaid', async () => {
    mockFetchSequence([
      [{ application_id: 'app_done' }],
      {
        application_id: 'app_done',
        current_detail: { amount: 4000 },
        repayment_logs: [{ repaid_to_user: { trap_id: 'z' }, repaid_at: '2026-01-01' }],
      },
    ])
    expect(await client.listApprovedTransferRequests()).toEqual([])
  })

  it('SKIPS a malformed application detail and still processes the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchSequence([
      // 1. list ?current_state=accepted (two accepted applications)
      [{ application_id: 'app_bad' }, { application_id: 'app_good' }],
      // 2. GET /api/applications/app_bad — malformed (missing repayment_logs) ⇒ skipped
      { application_id: 'app_bad' },
      // 3. GET /api/applications/app_good — valid ⇒ processed
      {
        application_id: 'app_good',
        current_detail: { amount: 3000 },
        repayment_logs: [
          { repaid_to_user: { trap_id: 'carol' }, repaid_at: null },
        ],
      },
    ])
    const out = await client.listApprovedTransferRequests()
    // The bad application is skipped (logged), the good one still comes through.
    expect(out).toEqual([
      { jomonRef: 'app_good:carol', payeeTraqId: 'carol', amount: 3000, currency: 'jpy' },
    ])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/app_bad/))
    warn.mockRestore()
  })

  it('SKIPS an application whose detail fetch errors and still processes the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spy = vi.spyOn(globalThis, 'fetch')
    // 1. list ?current_state=accepted (two accepted applications)
    spy.mockResolvedValueOnce(
      new Response(JSON.stringify([{ application_id: 'app_err' }, { application_id: 'app_ok' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    // 2. GET /api/applications/app_err — HTTP error ⇒ skipped
    spy.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    // 3. GET /api/applications/app_ok — valid ⇒ processed
    spy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          application_id: 'app_ok',
          current_detail: { amount: 1500 },
          repayment_logs: [{ repaid_to_user: { trap_id: 'dave' }, repaid_at: null }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const out = await client.listApprovedTransferRequests()
    expect(out).toEqual([
      { jomonRef: 'app_ok:dave', payeeTraqId: 'dave', amount: 1500, currency: 'jpy' },
    ])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/app_err/))
    warn.mockRestore()
  })

  it('SKIPS (never silently defaults the payee) an application with a missing trap_id', async () => {
    // Strict-within-app: a missing trap_id still fails zod validation, but the
    // per-application isolation turns that into a logged skip (no wrong payment),
    // not an aborting throw.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchSequence([
      [{ application_id: 'app_2' }],
      { application_id: 'app_2', current_detail: { amount: 4000 }, repayment_logs: [{ repaid_to_user: {}, repaid_at: null }] },
    ])
    const out = await client.listApprovedTransferRequests()
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/app_2/))
    warn.mockRestore()
  })

  it('SKIPS an application with a zero / non-positive amount', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchSequence([
      [{ application_id: 'app_3' }],
      { application_id: 'app_3', current_detail: { amount: 0 }, repayment_logs: [{ repaid_to_user: { trap_id: 'eve' }, repaid_at: null }] },
    ])
    const out = await client.listApprovedTransferRequests()
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/app_3/))
    warn.mockRestore()
  })

  it('THROWS on an unexpected list response shape', async () => {
    mockFetchSequence([{ unexpected: true }])
    await expect(client.listApprovedTransferRequests()).rejects.toThrow(/unexpected response shape/i)
  })

  it('writes back a paid result via PUT .../states/repaid/{trapId}', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
    await client.writeBackResult('app_1:alice', { status: 'paid', stripeTransferId: 'tr_x' })
    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://jomon.test/api/applications/app_1/states/repaid/alice')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toMatchObject({ repaid_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
  })

  it('does not call Jomon for a failed write-back (nothing to mark repaid)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
    await client.writeBackResult('app_1:alice', { status: 'failed', message: 'declined' })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('JomonV2Client (/api/applications, uuid->name, strict)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const client = new JomonV2Client('https://jomon.test', 'token')

  it('resolves target uuid via /api/users and normalizes unpaid targets', async () => {
    mockFetchSequence([
      // 1. GET /api/users
      [
        { id: 'uuid-alice', name: 'alice' },
        { id: 'uuid-bob', name: 'bob' },
      ],
      // 2. GET /api/applications?status=approved
      [
        {
          targets: [
            { id: 'tgt_1', target: 'uuid-alice', amount: 4000, paid_at: null },
            // already paid ⇒ skipped
            { id: 'tgt_2', target: 'uuid-bob', amount: 2000, paid_at: '2026-01-01' },
          ],
        },
      ],
    ])
    const out = await client.listApprovedTransferRequests()
    expect(out).toEqual([
      { jomonRef: 'tgt_1', payeeTraqId: 'alice', amount: 4000, currency: 'jpy' },
    ])
  })

  it('THROWS when a target references an unknown user uuid', async () => {
    mockFetchSequence([
      [{ id: 'uuid-alice', name: 'alice' }],
      [{ targets: [{ id: 'tgt_x', target: 'uuid-ghost', amount: 4000, paid_at: null }] }],
    ])
    await expect(client.listApprovedTransferRequests()).rejects.toThrow(/unknown user uuid/i)
  })

  it('THROWS on a zero / non-positive target amount', async () => {
    mockFetchSequence([
      [{ id: 'uuid-alice', name: 'alice' }],
      [{ targets: [{ id: 'tgt_z', target: 'uuid-alice', amount: 0, paid_at: null }] }],
    ])
    await expect(client.listApprovedTransferRequests()).rejects.toThrow(/validation/i)
  })

  it('write-back is UNSUPPORTED (throws JomonWriteBackUnsupportedError)', async () => {
    await expect(client.writeBackResult('tgt_1', { status: 'paid', stripeTransferId: 'tr_x' }))
      .rejects.toBeInstanceOf(JomonWriteBackUnsupportedError)
  })
})
