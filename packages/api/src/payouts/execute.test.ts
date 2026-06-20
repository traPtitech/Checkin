import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDatabase, schema, type Database } from '@checkin/db'
import { deriveMailHash } from '../auth/crypto'
import { setPayoutOnboardingStatus } from '../auth/identity'
import type { StripeClient } from '../stripe/client'
import { StubJomonClient } from '../jomon/stub'
import { JomonWriteBackUnsupportedError } from '../jomon/http'
import type { JomonTransferRequest, JomonWriteBackResult } from '../jomon/types'
import { executePayout, processApprovedPayouts, type PayoutExecuteConfig } from './execute'
import { getPayoutByJomonRef, upsertPayoutByJomonRef } from './store'

/**
 * DB-backed tests for the payout store + orchestration. They run against the
 * MariaDB pointed at by DATABASE_URL (see the change's tasks: MariaDB is up).
 * If the database is unreachable they self-skip so `pnpm test` stays green
 * without infrastructure. Stripe/Jomon are faked; no live calls are made.
 *
 * Payee resolution is now by traQ ID (`users.traq_id`) via `getUserByTraqId`
 * (fix-jomon-payout D5), so requests carry `payeeTraqId` and payees are seeded
 * with a linked `traq_id`.
 */

const config: PayoutExecuteConfig = {
  appOrigin: 'http://localhost:3000',
  defaultCurrency: 'jpy',
}

/** Minimal Stripe fake: only the surface the orchestration touches. */
function fakeStripe(opts: { transferOk?: boolean } = {}): StripeClient {
  const sdk = {
    accounts: {
      create: async () => ({ id: `acct_${randomUUID().slice(0, 8)}` }),
      del: async () => ({}),
    },
    accountLinks: {
      create: async () => ({ url: 'https://connect.stripe.test/onboard' }),
    },
    transfers: {
      create: async () => {
        if (opts.transferOk === false) {
          throw new Error('stripe transfer declined')
        }
        return { id: `tr_${randomUUID().slice(0, 8)}` }
      },
    },
  }
  return { sdk } as unknown as StripeClient
}

let db: Database
let available = false

beforeAll(async () => {
  try {
    db = createDatabase(process.env.DATABASE_URL ?? 'mysql://checkin:password@localhost:3306/checkin')
    await db.select({ id: schema.users.id }).from(schema.users).limit(1)
    available = true
  }
  catch {
    available = false
  }
})

/** Unique suffix so repeated runs don't collide on jomon_ref / traq_id. */
const tag = randomUUID().slice(0, 8)
const refs: string[] = []
const userIds: string[] = []

afterAll(async () => {
  if (!available) {
    return
  }
  for (const ref of refs) {
    await db.delete(schema.payouts).where(eq(schema.payouts.jomonRef, ref))
  }
  for (const id of userIds) {
    await db.delete(schema.users).where(eq(schema.users.id, id))
  }
})

/** Insert a payee user with a known traq_id; returns its traqId + id. */
async function makePayee(localPart: string, onboarding: 'none' | 'done'): Promise<{ traqId: string, id: string }> {
  const traqId = `${localPart}-${tag}`
  const id = randomUUID()
  // mail_hash is NOT NULL/unique; derive a unique one (no longer used for resolution).
  const mailHash = deriveMailHash(`${traqId}@m.isct.ac.jp`, 'test-secret')
  await db.insert(schema.users).values({ id, mailHash, traqId })
  if (onboarding === 'done') {
    // `done` requires a linked connected account for the transfer path.
    await db.update(schema.users)
      .set({ stripeConnectedAccountId: `acct_seed_${id.slice(0, 8)}` })
      .where(eq(schema.users.id, id))
    await setPayoutOnboardingStatus(db, id, 'done')
  }
  userIds.push(id)
  return { traqId, id }
}

function req(jomonRef: string, payeeTraqId: string, amount = 4000): JomonTransferRequest {
  refs.push(jomonRef)
  return { jomonRef, payeeTraqId, amount, currency: 'jpy' }
}

describe('upsertPayoutByJomonRef (idempotent ingestion)', () => {
  it('keeps a single row and preserves state on re-ingest', async () => {
    if (!available) {
      return
    }
    const jomonRef = `jmn-idem-${tag}`
    refs.push(jomonRef)

    const first = await upsertPayoutByJomonRef(db, { jomonRef, amount: 4000, currency: 'jpy' })
    expect(first.status).toBe('pending')

    // Advance the row to a non-default state, then re-ingest the same ref.
    await db.update(schema.payouts)
      .set({ status: 'paid', stripeTransferId: 'tr_keep' })
      .where(eq(schema.payouts.jomonRef, jomonRef))

    const second = await upsertPayoutByJomonRef(db, { jomonRef, amount: 9999, currency: 'usd' })
    // Same id (no duplicate) and the accumulated state is preserved (no-op update).
    expect(second.id).toBe(first.id)
    expect(second.status).toBe('paid')
    expect(second.stripeTransferId).toBe('tr_keep')
    // amount/currency are NOT overwritten by re-ingest.
    expect(second.amount).toBe(4000)
    expect(second.currency).toBe('jpy')
  })
})

describe('processApprovedPayouts (orchestration)', () => {
  it('leaves an unidentifiable (unlinked traQ ID) payee as pending and does not pay out', async () => {
    if (!available) {
      return
    }
    const jomon = new StubJomonClient([req(`jmn-unres-${tag}`, `nobody-${tag}`)])
    const summary = await processApprovedPayouts(
      { db, stripe: fakeStripe(), jomon },
      config,
    )
    expect(summary.unresolved).toBe(1)
    expect(summary.paid).toBe(0)

    const row = await getPayoutByJomonRef(db, `jmn-unres-${tag}`)
    expect(row?.userId).toBeNull()
    expect(row?.status).toBe('pending')
    // No write-back for an unresolved request.
    expect(jomon.writeBacks).toHaveLength(0)
  })

  it('resolves a linked traQ ID and parks a not-onboarded payee as onboarding_waiting', async () => {
    if (!available) {
      return
    }
    const payee = await makePayee('waiting', 'none')
    const jomon = new StubJomonClient([req(`jmn-wait-${tag}`, payee.traqId)])
    const summary = await processApprovedPayouts(
      { db, stripe: fakeStripe(), jomon },
      config,
    )
    expect(summary.onboardingWaiting).toBe(1)

    const row = await getPayoutByJomonRef(db, `jmn-wait-${tag}`)
    expect(row?.userId).toBe(payee.id)
    expect(row?.status).toBe('onboarding_waiting')
    expect(jomon.writeBacks).toHaveLength(0)
  })

  it('pays out a done payee and writes the result back to Jomon', async () => {
    if (!available) {
      return
    }
    const payee = await makePayee('paid', 'done')
    const ref = `jmn-paid-${tag}`
    const jomon = new StubJomonClient([req(ref, payee.traqId)])
    const summary = await processApprovedPayouts(
      { db, stripe: fakeStripe({ transferOk: true }), jomon },
      config,
    )
    expect(summary.paid).toBe(1)

    const row = await getPayoutByJomonRef(db, ref)
    expect(row?.status).toBe('paid')
    expect(row?.stripeTransferId).toBeTruthy()
    expect(jomon.writeBacks).toEqual([
      { jomonRef: ref, result: expect.objectContaining({ status: 'paid' }) },
    ])
  })

  it('does not re-transfer a paid payout on re-run (idempotent)', async () => {
    if (!available) {
      return
    }
    const payee = await makePayee('again', 'done')
    const ref = `jmn-again-${tag}`
    // Pre-mark this ref paid AND already-written-back, then re-execute via the
    // stub. A fully-settled paid row short-circuits with no transfer and no
    // new write-back. (jomonWrittenBackAt set ⇒ write-back not re-attempted.)
    const jomon = new StubJomonClient([req(ref, payee.traqId)])
    await upsertPayoutByJomonRef(db, { jomonRef: ref, amount: 4000, currency: 'jpy' })
    await db.update(schema.payouts)
      .set({ status: 'paid', stripeTransferId: 'tr_existing', userId: payee.id, jomonWrittenBackAt: new Date() })
      .where(eq(schema.payouts.jomonRef, ref))

    const result = await executePayout({ db, stripe: fakeStripe({ transferOk: true }), jomon }, config, ref)
    expect(result.outcome).toBe('already_paid')

    const row = await getPayoutByJomonRef(db, ref)
    expect(row?.stripeTransferId).toBe('tr_existing')
    // No new write-back for a short-circuited, already-written-back paid payout.
    expect(jomon.writeBacks).toHaveLength(0)
  })

  it('marks failed and writes back when the transfer is declined', async () => {
    if (!available) {
      return
    }
    const payee = await makePayee('fail', 'done')
    const ref = `jmn-fail-${tag}`
    const jomon = new StubJomonClient([req(ref, payee.traqId)])
    const summary = await processApprovedPayouts(
      { db, stripe: fakeStripe({ transferOk: false }), jomon },
      config,
    )
    expect(summary.failed).toBe(1)

    const row = await getPayoutByJomonRef(db, ref)
    expect(row?.status).toBe('failed')
    expect(jomon.writeBacks).toEqual([
      { jomonRef: ref, result: expect.objectContaining({ status: 'failed' }) },
    ])
  })

  it('records jomonWrittenBackAt on a successful payout', async () => {
    if (!available) {
      return
    }
    const payee = await makePayee('wbts', 'done')
    const ref = `jmn-wbts-${tag}`
    const jomon = new StubJomonClient([req(ref, payee.traqId)])
    await processApprovedPayouts({ db, stripe: fakeStripe({ transferOk: true }), jomon }, config)

    const row = await getPayoutByJomonRef(db, ref)
    expect(row?.status).toBe('paid')
    expect(row?.jomonWrittenBackAt).toBeInstanceOf(Date)
  })

  it('does NOT auto-retry a failed row in processApproved (skips it)', async () => {
    if (!available) {
      return
    }
    const payee = await makePayee('skip', 'done')
    const ref = `jmn-skip-${tag}`
    await upsertPayoutByJomonRef(db, { jomonRef: ref, amount: 4000, currency: 'jpy' })
    await db.update(schema.payouts)
      .set({ status: 'failed', userId: payee.id })
      .where(eq(schema.payouts.jomonRef, ref))

    const jomon = new StubJomonClient([req(ref, payee.traqId)])
    const summary = await processApprovedPayouts(
      { db, stripe: fakeStripe({ transferOk: true }), jomon },
      config,
    )
    expect(summary.skippedFailed).toBe(1)
    expect(summary.paid).toBe(0)

    const row = await getPayoutByJomonRef(db, ref)
    // Still failed — no transfer, no write-back.
    expect(row?.status).toBe('failed')
    expect(jomon.writeBacks).toHaveLength(0)
  })

  it('lets the admin execute RETRY a failed row (paying it out)', async () => {
    if (!available) {
      return
    }
    const payee = await makePayee('retry', 'done')
    const ref = `jmn-retry-${tag}`
    await upsertPayoutByJomonRef(db, { jomonRef: ref, amount: 4000, currency: 'jpy' })
    await db.update(schema.payouts)
      .set({ status: 'failed', userId: payee.id })
      .where(eq(schema.payouts.jomonRef, ref))

    const jomon = new StubJomonClient([req(ref, payee.traqId)])
    const result = await executePayout(
      { db, stripe: fakeStripe({ transferOk: true }), jomon },
      config,
      ref,
    )
    expect(result.outcome).toBe('paid')

    const row = await getPayoutByJomonRef(db, ref)
    expect(row?.status).toBe('paid')
    expect(jomon.writeBacks).toEqual([
      { jomonRef: ref, result: expect.objectContaining({ status: 'paid' }) },
    ])
  })

  it('flags a userId mismatch for manual review and does not relink/transfer', async () => {
    if (!available) {
      return
    }
    const original = await makePayee('orig', 'done')
    const other = await makePayee('other', 'done')
    const ref = `jmn-immut-${tag}`
    // Row already linked to `original`; the request now resolves to `other`.
    await upsertPayoutByJomonRef(db, { jomonRef: ref, amount: 4000, currency: 'jpy' })
    await db.update(schema.payouts)
      .set({ userId: original.id })
      .where(eq(schema.payouts.jomonRef, ref))

    const jomon = new StubJomonClient([req(ref, other.traqId)])
    const summary = await processApprovedPayouts(
      { db, stripe: fakeStripe({ transferOk: true }), jomon },
      config,
    )
    expect(summary.needsReview).toBe(1)
    expect(summary.paid).toBe(0)

    const row = await getPayoutByJomonRef(db, ref)
    // userId is immutable — still the original; no transfer, no write-back.
    expect(row?.userId).toBe(original.id)
    expect(jomon.writeBacks).toHaveLength(0)
  })

  it('re-attempts the Jomon write-back for a paid row without re-transferring', async () => {
    if (!available) {
      return
    }
    const payee = await makePayee('wbretry', 'done')
    const ref = `jmn-wbretry-${tag}`
    // Already paid, but write-back never recorded (jomonWrittenBackAt NULL).
    await upsertPayoutByJomonRef(db, { jomonRef: ref, amount: 4000, currency: 'jpy' })
    await db.update(schema.payouts)
      .set({ status: 'paid', stripeTransferId: 'tr_done', userId: payee.id })
      .where(eq(schema.payouts.jomonRef, ref))

    const jomon = new StubJomonClient([req(ref, payee.traqId)])
    // A transfer here would throw (transferOk: false) — proving no re-transfer.
    const result = await executePayout(
      { db, stripe: fakeStripe({ transferOk: false }), jomon },
      config,
      ref,
    )
    expect(result.outcome).toBe('already_paid')

    const row = await getPayoutByJomonRef(db, ref)
    expect(row?.stripeTransferId).toBe('tr_done')
    expect(row?.jomonWrittenBackAt).toBeInstanceOf(Date)
    // Write-back was re-attempted exactly once with the original transfer id.
    expect(jomon.writeBacks).toEqual([
      { jomonRef: ref, result: { status: 'paid', stripeTransferId: 'tr_done' } },
    ])
  })

  it('does NOT re-attempt write-back when jomonWrittenBackAt is already set', async () => {
    if (!available) {
      return
    }
    const payee = await makePayee('wbskip', 'done')
    const ref = `jmn-wbskip-${tag}`
    await upsertPayoutByJomonRef(db, { jomonRef: ref, amount: 4000, currency: 'jpy' })
    await db.update(schema.payouts)
      .set({ status: 'paid', stripeTransferId: 'tr_done', userId: payee.id, jomonWrittenBackAt: new Date() })
      .where(eq(schema.payouts.jomonRef, ref))

    const jomon = new StubJomonClient([req(ref, payee.traqId)])
    const result = await executePayout(
      { db, stripe: fakeStripe({ transferOk: false }), jomon },
      config,
      ref,
    )
    expect(result.outcome).toBe('already_paid')
    // Already written back — no repeat.
    expect(jomon.writeBacks).toHaveLength(0)
  })

  it('keeps the payout paid when v2 write-back is unsupported, leaving it for retry', async () => {
    if (!available) {
      return
    }
    const payee = await makePayee('v2wb', 'done')
    const ref = `jmn-v2wb-${tag}`
    // A stub whose write-back is UNSUPPORTED, like the real v2 driver.
    class UnsupportedWriteBackJomon extends StubJomonClient {
      override async writeBackResult(): Promise<void> {
        throw new JomonWriteBackUnsupportedError('v2 write-back unsupported')
      }
    }
    const jomon = new UnsupportedWriteBackJomon([req(ref, payee.traqId)])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = await processApprovedPayouts(
      { db, stripe: fakeStripe({ transferOk: true }), jomon },
      config,
    )
    // The payout itself succeeded (transfer ran) and was NOT isolated as errored.
    expect(summary.paid).toBe(1)
    expect(summary.errored).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()

    const row = await getPayoutByJomonRef(db, ref)
    // paid is preserved; write-back stays unrecorded so it retries later.
    expect(row?.status).toBe('paid')
    expect(row?.jomonWrittenBackAt).toBeNull()
  })

  it('returns a summary with listError (not a throw) when the approved-requests fetch fails', async () => {
    if (!available) {
      return
    }
    // A stub whose list pull throws — mirrors a Jomon list/HTTP/zod failure.
    class ListFailsJomon extends StubJomonClient {
      override async listApprovedTransferRequests(): Promise<JomonTransferRequest[]> {
        throw new Error('jomon list boom')
      }
    }
    const jomon = new ListFailsJomon()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const summary = await processApprovedPayouts(
      { db, stripe: fakeStripe(), jomon },
      config,
    )
    // Reported, not thrown: empty body + a top-level error indicator.
    expect(summary.listError).toMatch(/jomon list boom/)
    expect(summary.ingested).toBe(0)
    expect(summary.errored).toBe(0)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('isolates a write-back failure: payout stays paid and is retried (not errored, not re-transferred)', async () => {
    if (!available) {
      return
    }
    const goodPayee = await makePayee('iso-good', 'done')
    const badPayee = await makePayee('iso-bad', 'done')
    const goodRef = `jmn-iso-good-${tag}`
    const badRef = `jmn-iso-bad-${tag}`

    // A stub whose write-back throws ONLY for the bad ref.
    class FlakyJomon extends StubJomonClient {
      override async writeBackResult(jomonRef: string, result: JomonWriteBackResult): Promise<void> {
        if (jomonRef === badRef) {
          throw new Error('jomon write-back boom')
        }
        return super.writeBackResult(jomonRef, result)
      }
    }
    const jomon = new FlakyJomon([req(badRef, badPayee.traqId), req(goodRef, goodPayee.traqId)])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = await processApprovedPayouts(
      { db, stripe: fakeStripe({ transferOk: true }), jomon },
      config,
    )
    // Both items paid out; the write-back failure is isolated inside the step
    // (logged warning), so it is NOT counted as an errored item.
    expect(summary.paid).toBe(2)
    expect(summary.errored).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()

    const goodRow = await getPayoutByJomonRef(db, goodRef)
    expect(goodRow?.status).toBe('paid')
    expect(goodRow?.jomonWrittenBackAt).toBeInstanceOf(Date)
    // The bad item transferred (paid) but its write-back failed; left for retry
    // with jomonWrittenBackAt still NULL (so a later run retries write-back only).
    const badRow = await getPayoutByJomonRef(db, badRef)
    expect(badRow?.status).toBe('paid')
    expect(badRow?.jomonWrittenBackAt).toBeNull()
  })
})
