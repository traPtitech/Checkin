import { describe, expect, it, vi } from 'vitest'
import { processInvoicePaid, type InvoicePaidOps, type VerifiedInvoiceEvent } from './process'

/**
 * Tests for the `invoice.paid` webhook flow (payment-webhook / issuance-ledger).
 * The flow is pure with all side effects injected, so these run with spies and
 * NO DB — always executed in `pnpm test`. They pin the behaviour the route used
 * to inline: happy-path dedup, ledger confirm, notify→record ordering, and the
 * at-least-once guarantee that a notify failure leaves the event unrecorded.
 */

/** Spy ops: each side effect resolves; tests override individual ones as needed. */
function spyOps(): InvoicePaidOps {
  return {
    hasProcessed: vi.fn(async () => false),
    markPaid: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    recordOnce: vi.fn(async () => true),
  }
}

const EVENT: VerifiedInvoiceEvent = {
  id: 'evt_123',
  type: 'invoice.paid',
  objectId: 'in_abc',
}

describe('processInvoicePaid', () => {
  it('横-01: unprocessed + objectId → markPaid→notify→recordOnce in order, returns { ok: true }', async () => {
    const ops = spyOps()

    const result = await processInvoicePaid(ops, EVENT)

    expect(result).toEqual({ ok: true })

    // Each side effect runs exactly once.
    expect(ops.markPaid).toHaveBeenCalledTimes(1)
    expect(ops.markPaid).toHaveBeenCalledWith('in_abc')
    expect(ops.notify).toHaveBeenCalledTimes(1)
    expect(ops.recordOnce).toHaveBeenCalledTimes(1)

    // Notify text is part of the contract — byte-for-byte stable.
    expect(ops.notify).toHaveBeenCalledWith('入金を確認しました（Stripe event evt_123）。')
    // recordOnce gets the id+type only (not objectId).
    expect(ops.recordOnce).toHaveBeenCalledWith({ id: 'evt_123', type: 'invoice.paid' })

    // Strict ordering markPaid → notify → recordOnce via invocation order.
    const markPaidOrder = (ops.markPaid as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
    const notifyOrder = (ops.notify as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
    const recordOrder = (ops.recordOnce as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
    expect(markPaidOrder).toBeLessThan(notifyOrder)
    expect(notifyOrder).toBeLessThan(recordOrder)
  })

  it('横-02: already processed → { ok: true, duplicate: true }, no side effects run', async () => {
    const ops = spyOps()
    ops.hasProcessed = vi.fn(async () => true)

    const result = await processInvoicePaid(ops, EVENT)

    expect(result).toEqual({ ok: true, duplicate: true })
    expect(ops.markPaid).not.toHaveBeenCalled()
    expect(ops.notify).not.toHaveBeenCalled()
    expect(ops.recordOnce).not.toHaveBeenCalled()
  })

  it('横-22: notify rejects → rejects (Stripe retries) and recordOnce is NOT called', async () => {
    const ops = spyOps()
    ops.notify = vi.fn(async () => {
      throw new Error('notify boom')
    })

    await expect(processInvoicePaid(ops, EVENT)).rejects.toThrow('notify boom')

    // markPaid runs before notify, so it may have run; recordOnce must NOT — the
    // event stays unrecorded so Stripe re-sends (at-least-once).
    expect(ops.markPaid).toHaveBeenCalledTimes(1)
    expect(ops.recordOnce).not.toHaveBeenCalled()
  })

  it('台帳外 (boundary): objectId null → markPaid skipped, notify + recordOnce still run', async () => {
    const ops = spyOps()
    const event: VerifiedInvoiceEvent = { id: 'evt_456', type: 'invoice.paid', objectId: null }

    const result = await processInvoicePaid(ops, event)

    expect(result).toEqual({ ok: true })
    expect(ops.markPaid).not.toHaveBeenCalled()
    expect(ops.notify).toHaveBeenCalledWith('入金を確認しました（Stripe event evt_456）。')
    expect(ops.recordOnce).toHaveBeenCalledWith({ id: 'evt_456', type: 'invoice.paid' })
  })

  it('duplicate insert: recordOnce returns false → does not change the outcome', async () => {
    const ops = spyOps()
    ops.recordOnce = vi.fn(async () => false)

    const result = await processInvoicePaid(ops, EVENT)

    expect(result).toEqual({ ok: true })
    expect(ops.recordOnce).toHaveBeenCalledTimes(1)
  })
})
