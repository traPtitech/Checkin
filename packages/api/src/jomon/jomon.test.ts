import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJomonClient } from './factory'
import { JomonV1Client } from './http'
import { StubJomonClient } from './stub'
import type { JomonTransferRequest } from './types'

const seed: JomonTransferRequest[] = [
  { jomonRef: 'jmn_1', payeeEmail: 'alice@m.isct.ac.jp', amount: 4000, currency: 'jpy' },
  { jomonRef: 'jmn_2', payeeEmail: 'bob@m.isct.ac.jp', amount: 2000, currency: 'jpy' },
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

describe('JomonHttpClient strict response validation (fail-safe)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Stub global fetch with one JSON `ok` response body. */
  function mockFetch(body: unknown): void {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  }

  const client = new JomonV1Client('https://jomon.test', 'token')

  it('parses a valid array response into DTOs', async () => {
    mockFetch([
      { jomonRef: 'jmn_a', payeeEmail: 'a@m.isct.ac.jp', amount: 4000, currency: 'jpy' },
      // `id`/`email` aliases also accepted (best-effort until live field names confirmed).
      { id: 7, email: 'b@m.isct.ac.jp', amount: 2000, currency: 'jpy' },
    ])
    const out = await client.listApprovedTransferRequests()
    expect(out).toEqual([
      { jomonRef: 'jmn_a', payeeEmail: 'a@m.isct.ac.jp', amount: 4000, currency: 'jpy' },
      { jomonRef: '7', payeeEmail: 'b@m.isct.ac.jp', amount: 2000, currency: 'jpy' },
    ])
  })

  it('parses a `{ data: [...] }` envelope', async () => {
    mockFetch({ data: [{ jomonRef: 'jmn_c', payeeEmail: 'c@m.isct.ac.jp', amount: 100, currency: 'jpy' }] })
    const out = await client.listApprovedTransferRequests()
    expect(out.map(r => r.jomonRef)).toEqual(['jmn_c'])
  })

  it('THROWS on a missing payee identifier (never silently defaults)', async () => {
    mockFetch([{ jomonRef: 'jmn_d', amount: 4000, currency: 'jpy' }])
    await expect(client.listApprovedTransferRequests()).rejects.toThrow(/validation/i)
  })

  it('THROWS on a zero / non-positive amount', async () => {
    mockFetch([{ jomonRef: 'jmn_e', payeeEmail: 'e@m.isct.ac.jp', amount: 0, currency: 'jpy' }])
    await expect(client.listApprovedTransferRequests()).rejects.toThrow(/validation/i)
  })

  it('THROWS on a missing jomonRef / id', async () => {
    mockFetch([{ payeeEmail: 'f@m.isct.ac.jp', amount: 4000, currency: 'jpy' }])
    await expect(client.listApprovedTransferRequests()).rejects.toThrow(/validation/i)
  })

  it('THROWS on a missing currency', async () => {
    mockFetch([{ jomonRef: 'jmn_g', payeeEmail: 'g@m.isct.ac.jp', amount: 4000 }])
    await expect(client.listApprovedTransferRequests()).rejects.toThrow(/validation/i)
  })

  it('THROWS on an unknown top-level response shape', async () => {
    mockFetch({ unexpected: true })
    await expect(client.listApprovedTransferRequests()).rejects.toThrow(/unexpected response shape/i)
  })
})
