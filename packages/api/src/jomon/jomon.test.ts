import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJomonClient } from './factory'
import {
  JOMON_READ_RETRIES,
  JOMON_REQUEST_TIMEOUT_MS,
  JOMON_RETRY_DELAY_MS,
  JomonV1Client,
  JomonV2Client,
  JomonWriteBackUnsupportedError,
} from './http'
import { StubJomonClient } from './stub'
import type { JomonTransferRequest } from './types'

/**
 * Read `repaid_at` off a parsed write-back body. Returns `undefined` when the
 * body is not an object or the field is absent, so the assertion on it fails
 * instead of passing on a missing field.
 */
function readRepaidAt(parsed: unknown): unknown {
  return typeof parsed === 'object' && parsed !== null && 'repaid_at' in parsed
    ? parsed.repaid_at
    : undefined
}

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

/** One `200 application/json` response carrying `body`. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** A retryable answer — 503 is in ofetch's default `retryStatusCodes`. */
function unavailableResponse(): Response {
  return new Response('unavailable', { status: 503 })
}

/**
 * Run `body` on fake timers. Every read that retries sleeps
 * {@link JOMON_RETRY_DELAY_MS} between attempts, and every attempt arms a
 * timeout of {@link JOMON_REQUEST_TIMEOUT_MS}; on real timers those delays would
 * be spent idling, and an attempt's timeout would outlast the test itself.
 * `body` drives the clock itself.
 */
async function onFakeTimers<T>(body: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  try {
    return await body()
  }
  finally {
    vi.useRealTimers()
  }
}

/** Advance past every retry delay a single read can sleep through. */
async function passRetryDelays(): Promise<void> {
  await vi.advanceTimersByTimeAsync(JOMON_READ_RETRIES * JOMON_RETRY_DELAY_MS)
}

/**
 * Queue several JSON `ok` responses for sequential `fetch` calls (v1 lists then
 * fetches each application detail; v2 fetches users then applications).
 */
function mockFetchSequence(bodies: unknown[]): void {
  const spy = vi.spyOn(globalThis, 'fetch')
  for (const body of bodies) {
    spy.mockResolvedValueOnce(jsonResponse(body))
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
    spy.mockResolvedValueOnce(jsonResponse([{ application_id: 'app_err' }, { application_id: 'app_ok' }]))
    // 2. GET /api/applications/app_err — 500 on every allowed attempt ⇒ skipped.
    //    500 is retryable, so the read is attempted JOMON_READ_RETRIES + 1 times
    //    before the driver gives up on this application.
    for (let attempt = 0; attempt <= JOMON_READ_RETRIES; attempt++) {
      spy.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    }
    // 3. GET /api/applications/app_ok — valid ⇒ processed
    spy.mockResolvedValueOnce(jsonResponse({
      application_id: 'app_ok',
      current_detail: { amount: 1500 },
      repayment_logs: [{ repaid_to_user: { trap_id: 'dave' }, repaid_at: null }],
    }))
    const out = await onFakeTimers(async () => {
      const pending = client.listApprovedTransferRequests()
      await passRetryDelays()
      return await pending
    })
    expect(out).toEqual([
      { jomonRef: 'app_ok:dave', payeeTraqId: 'dave', amount: 1500, currency: 'jpy' },
    ])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/app_err/))
    warn.mockRestore()
  })

  it('waits the retry delay before attempting a refused read again', async () => {
    await onFakeTimers(async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(unavailableResponse()))
      const pending = client.listApprovedTransferRequests()
      const settled = expect(pending).rejects.toThrow(/failed: 503 unavailable$/)
      // The first attempt goes out without waiting for anything.
      await vi.advanceTimersByTimeAsync(0)
      expect(spy).toHaveBeenCalledTimes(1)
      // One millisecond short of the delay, the second attempt is still held back.
      await vi.advanceTimersByTimeAsync(JOMON_RETRY_DELAY_MS - 1)
      expect(spy).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(spy).toHaveBeenCalledTimes(2)
      await passRetryDelays()
      await settled
    })
  })

  it('retries a retryable read and normalizes the answer the retry returned', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    // The list read is refused with a retryable status on every attempt but the last.
    for (let attempt = 0; attempt < JOMON_READ_RETRIES; attempt++) {
      spy.mockResolvedValueOnce(unavailableResponse())
    }
    spy.mockResolvedValueOnce(jsonResponse([{ application_id: 'app_1' }]))
    spy.mockResolvedValueOnce(jsonResponse({
      application_id: 'app_1',
      current_detail: { amount: 4000 },
      repayment_logs: [{ repaid_to_user: { trap_id: 'alice' }, repaid_at: null }],
    }))
    const out = await onFakeTimers(async () => {
      const pending = client.listApprovedTransferRequests()
      await passRetryDelays()
      return await pending
    })
    expect(out).toEqual([
      { jomonRef: 'app_1:alice', payeeTraqId: 'alice', amount: 4000, currency: 'jpy' },
    ])
    // The refused attempts, the list answer that followed them, and the detail read.
    expect(spy).toHaveBeenCalledTimes(JOMON_READ_RETRIES + 2)
  })

  it('gives up a read after the allowed retries and reports the last status and body', async () => {
    // A fresh Response per call: a body can only be read once.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(unavailableResponse()))
    await onFakeTimers(async () => {
      const settled = expect(client.listApprovedTransferRequests())
        .rejects.toThrow('Jomon GET /api/applications?current_state=accepted failed: 503 unavailable')
      await passRetryDelays()
      await settled
    })
    expect(spy).toHaveBeenCalledTimes(JOMON_READ_RETRIES + 1)
  })

  it('does NOT retry a read refused with a non-retryable status', async () => {
    // 404 is outside ofetch's default retryStatusCodes: a wrong path or a wrong
    // token must fail at once rather than be asked three times.
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('no such path', { status: 404 })))
    await expect(client.listApprovedTransferRequests())
      .rejects.toThrow('Jomon GET /api/applications?current_state=accepted failed: 404 no such path')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('THROWS on a response body that is not JSON', async () => {
    // ofetch parses the body, so a non-JSON answer no longer raises a parse
    // error — the strict schema is what has to reject it.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<html>gateway</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }))
    await expect(client.listApprovedTransferRequests()).rejects.toThrow(/unexpected response shape/i)
  })

  it('does NOT retry a write-back refused with a retryable status', async () => {
    // A second delivery of a write-back could be a second "mark repaid" on the
    // Jomon side, and nothing here can confirm that it would be a no-op.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(unavailableResponse()))
    await expect(client.writeBackResult('app_1:alice', { status: 'paid', stripeTransferId: 'tr_x' }))
      .rejects.toThrow('Jomon PUT /api/applications/app_1/states/repaid/alice failed: 503 unavailable')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('retries a read whose connection is refused and reports the refusal', async () => {
    // The other path to a failure with no response: the connection is refused,
    // so the read fails at once instead of running out of time. Having no status
    // of its own, it is retried like a failure that did carry one, and the
    // refusal is then reported to the caller.
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new TypeError('fetch failed: ECONNREFUSED')))
    await onFakeTimers(async () => {
      const settled = expect(client.listApprovedTransferRequests()).rejects
        .toThrow(/^Jomon GET \/api\/applications\?current_state=accepted failed: .*ECONNREFUSED/)
      await passRetryDelays()
      await settled
    })
    expect(spy).toHaveBeenCalledTimes(JOMON_READ_RETRIES + 1)
  })

  it('aborts every attempt of a read that is never answered', async () => {
    await onFakeTimers(async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
        const signal = init?.signal
        return new Promise((_resolve, reject) => {
          if (!signal) {
            // No AbortSignal means this attempt carries no timeout and would wait
            // forever. Report that instead, so the assertion below names it.
            reject(new Error('this attempt carried no AbortSignal'))
            return
          }
          signal.addEventListener('abort', () => {
            const reason: unknown = signal.reason
            reject(new Error(`aborted with ${reason instanceof Error ? reason.name : String(reason)}`))
          })
        })
      })
      const pending = client.listApprovedTransferRequests()
      // The LAST attempt's abort is what surfaces, so every attempt was aborted
      // rather than left hanging — including the retries, which ofetch would
      // otherwise run under the first attempt's spent signal.
      const settled = expect(pending).rejects.toThrow('aborted with TimeoutError')
      await vi.advanceTimersByTimeAsync(
        (JOMON_READ_RETRIES + 1) * JOMON_REQUEST_TIMEOUT_MS + JOMON_READ_RETRIES * JOMON_RETRY_DELAY_MS,
      )
      await settled
      expect(spy).toHaveBeenCalledTimes(JOMON_READ_RETRIES + 1)
    })
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
    const call = spy.mock.calls[0]
    expect(call?.[0]).toBe('https://jomon.test/api/applications/app_1/states/repaid/alice')
    expect(call?.[1]?.method).toBe('PUT')
    const body = call?.[1]?.body
    if (typeof body !== 'string') {
      throw new TypeError(`expected a string request body, got ${typeof body}`)
    }
    expect(readRepaidAt(JSON.parse(body))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // ofetch hands `fetch` a Headers instance. The driver sets `authorization`
    // itself and leaves `content-type` to ofetch, which adds it for a PUT that
    // carries an object body — so both have to be observed here.
    const headers = call?.[1]?.headers
    if (!(headers instanceof Headers)) {
      throw new TypeError(`expected a Headers instance, got ${typeof headers}`)
    }
    expect(headers.get('authorization')).toBe('Bearer token')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('does not call Jomon for a failed write-back (nothing to mark repaid)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
    await client.writeBackResult('app_1:alice', { status: 'failed', message: 'declined' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('writes back a MANUAL paid (no stripeTransferId) — still sends repaid_at', async () => {
    // A manual bank transfer settles `paid` with no Stripe transfer id; v1
    // write-back only needs `repaid_at`, so the absence of stripeTransferId must
    // NOT prevent the repaid write-back. (add-manual-bank-payout D4)
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
    await client.writeBackResult('app_1:alice', { status: 'paid', message: 'bank ref 999' })
    expect(spy).toHaveBeenCalledTimes(1)
    const call = spy.mock.calls[0]
    expect(call?.[0]).toBe('https://jomon.test/api/applications/app_1/states/repaid/alice')
    expect(call?.[1]?.method).toBe('PUT')
    const body = call?.[1]?.body
    if (typeof body !== 'string') {
      throw new TypeError(`expected a string request body, got ${typeof body}`)
    }
    expect(readRepaidAt(JSON.parse(body))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
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

  it('manual paid (no stripeTransferId) write-back is also UNSUPPORTED — kept for retry', async () => {
    // A manual-bank paid result has no stripeTransferId; v2 still has no write-back
    // API, so it throws Unsupported. The orchestration keeps the payout `paid` and
    // leaves jomon_written_back_at NULL for retry. (add-manual-bank-payout D4)
    await expect(client.writeBackResult('tgt_1', { status: 'paid', message: 'bank ref 999' }))
      .rejects.toBeInstanceOf(JomonWriteBackUnsupportedError)
  })
})
