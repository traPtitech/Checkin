import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDatabase, schema, type Database } from '@checkin/db'
import { deriveMailHash } from '../auth/crypto'
import { getUserByTraqId, setPayoutOnboardingStatus } from '../auth/identity'
import type { StripeClient } from '../stripe/client'
import { StubJomonClient } from '../jomon/stub'
import { JomonWriteBackUnsupportedError } from '../jomon/http'
import type { JomonTransferRequest, JomonWriteBackResult } from '../jomon/types'
import { executePayout, markPayoutManuallyPaid, processApprovedPayouts, type PayoutExecuteConfig } from './execute'
import { getPayoutByJomonRef, settlePayoutManually, upsertPayoutByJomonRef } from './store'

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
  it('auto-creates a payout-only user for an unlinked traQ ID and parks it as onboarding_waiting', async () => {
    if (!available) {
      return
    }
    const traqId = `nobody-${tag}`
    const jomon = new StubJomonClient([req(`jmn-unres-${tag}`, traqId)])
    const summary = await processApprovedPayouts(
      { db, stripe: fakeStripe(), jomon },
      config,
    )
    // No longer "unresolved": a payout-only user (traq_id, no mail_hash) is minted,
    // so a Jomon refund recipient who never did isct email verification can be paid.
    expect(summary.unresolved).toBe(0)
    expect(summary.onboardingWaiting).toBe(1)
    expect(summary.paid).toBe(0)

    const minted = await getUserByTraqId(db, traqId)
    expect(minted).not.toBeNull()
    expect(minted!.mailHash).toBeNull()
    userIds.push(minted!.id)

    const row = await getPayoutByJomonRef(db, `jmn-unres-${tag}`)
    expect(row?.userId).toBe(minted!.id)
    expect(row?.status).toBe('onboarding_waiting')
    // Not paid (onboarding not done) → no write-back.
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

describe('markPayoutManuallyPaid (manual bank transfer settle)', () => {
  /** Seed a payout row at a chosen status without touching Stripe/Jomon. */
  async function seedRow(
    ref: string,
    status: 'pending' | 'onboarding_waiting' | 'failed' | 'paid' | 'processing',
    extra: Partial<{ userId: string | null, stripeTransferId: string | null, jomonWrittenBackAt: Date | null }> = {},
  ): Promise<void> {
    refs.push(ref)
    await upsertPayoutByJomonRef(db, { jomonRef: ref, amount: 4000, currency: 'jpy' })
    await db.update(schema.payouts)
      .set({ status, ...extra })
      .where(eq(schema.payouts.jomonRef, ref))
  }

  it.each(['pending', 'onboarding_waiting', 'failed'] as const)(
    'settles a %s payout as paid (manual_bank) WITHOUT a Stripe transfer and writes back',
    async (status) => {
      if (!available) {
        return
      }
      const ref = `jmn-manual-${status}-${tag}`
      await seedRow(ref, status, { userId: null })
      const jomon = new StubJomonClient()

      // transferOk:false proves no Stripe transfer is attempted (it would throw).
      const result = await markPayoutManuallyPaid(
        { db, stripe: fakeStripe({ transferOk: false }), jomon },
        { jomonRef: ref, note: 'bank ref 12345', byUserId: null },
      )
      expect(result.outcome).toBe('paid')
      expect(result.status).toBe('paid')

      const row = await getPayoutByJomonRef(db, ref)
      expect(row?.status).toBe('paid')
      expect(row?.payoutMethod).toBe('manual_bank')
      expect(row?.manualPaidNote).toBe('bank ref 12345')
      expect(row?.manualPaidAt).toBeInstanceOf(Date)
      // No Stripe transfer id for a manual payout.
      expect(row?.stripeTransferId).toBeNull()
      // Settled result written back to Jomon as paid, with the note, no transfer id.
      expect(jomon.writeBacks).toEqual([
        { jomonRef: ref, result: { status: 'paid', message: 'bank ref 12345' } },
      ])
    },
  )

  it('works when userId is null and never relinks a payee', async () => {
    if (!available) {
      return
    }
    const ref = `jmn-manual-nulluser-${tag}`
    await seedRow(ref, 'onboarding_waiting', { userId: null })
    const jomon = new StubJomonClient()

    const result = await markPayoutManuallyPaid(
      { db, stripe: fakeStripe({ transferOk: false }), jomon },
      { jomonRef: ref, byUserId: null },
    )
    expect(result.outcome).toBe('paid')

    const row = await getPayoutByJomonRef(db, ref)
    expect(row?.status).toBe('paid')
    // userId stays null — manual settle does not invent/relink a payee.
    expect(row?.userId).toBeNull()
  })

  it('rejects a paid payout (short-circuits as already_paid, no double pay)', async () => {
    if (!available) {
      return
    }
    const ref = `jmn-manual-paid-${tag}`
    // Already paid via Stripe, write-back recorded.
    await seedRow(ref, 'paid', { stripeTransferId: 'tr_stripe', jomonWrittenBackAt: new Date() })
    const jomon = new StubJomonClient()

    const result = await markPayoutManuallyPaid(
      { db, stripe: fakeStripe({ transferOk: false }), jomon },
      { jomonRef: ref, note: 'should not apply' },
    )
    expect(result.outcome).toBe('already_paid')

    const row = await getPayoutByJomonRef(db, ref)
    // Untouched: still a Stripe payout, no manual fields, no re-write-back.
    expect(row?.payoutMethod).toBe('stripe_connect')
    expect(row?.stripeTransferId).toBe('tr_stripe')
    expect(row?.manualPaidAt).toBeNull()
    expect(jomon.writeBacks).toHaveLength(0)
  })

  it('rejects a processing payout (needs_review, never overwrites an in-flight Stripe run)', async () => {
    if (!available) {
      return
    }
    const ref = `jmn-manual-proc-${tag}`
    await seedRow(ref, 'processing')
    const jomon = new StubJomonClient()

    const result = await markPayoutManuallyPaid(
      { db, stripe: fakeStripe({ transferOk: false }), jomon },
      { jomonRef: ref, note: 'x' },
    )
    expect(result.outcome).toBe('needs_review')
    expect(result.status).toBe('processing')

    const row = await getPayoutByJomonRef(db, ref)
    // Unchanged — the manual path must not touch an in-flight Stripe execution.
    expect(row?.status).toBe('processing')
    expect(row?.payoutMethod).toBe('stripe_connect')
    expect(jomon.writeBacks).toHaveLength(0)
  })

  it('throws NOT_FOUND-style error when the payout row is missing', async () => {
    if (!available) {
      return
    }
    const jomon = new StubJomonClient()
    await expect(markPayoutManuallyPaid(
      { db, stripe: fakeStripe(), jomon },
      { jomonRef: `jmn-manual-missing-${tag}`, note: 'x' },
    )).rejects.toThrow(/payout not found/i)
  })

  it('never double-pays when racing a Stripe claim: the manual settle loses and short-circuits', async () => {
    if (!available) {
      return
    }
    const ref = `jmn-manual-race-${tag}`
    await seedRow(ref, 'onboarding_waiting', { userId: null })
    const jomon = new StubJomonClient()

    // Simulate the Stripe side winning the claim FIRST: the store's conditional
    // UPDATE shares the claimable predicate, so once the row is `paid` the manual
    // settle's WHERE no longer matches (affectedRows=0) and it short-circuits.
    await db.update(schema.payouts)
      .set({ status: 'paid', stripeTransferId: 'tr_stripe_won', jomonWrittenBackAt: new Date() })
      .where(eq(schema.payouts.jomonRef, ref))

    const result = await markPayoutManuallyPaid(
      { db, stripe: fakeStripe({ transferOk: false }), jomon },
      { jomonRef: ref, note: 'late manual' },
    )
    // The manual path read `onboarding_waiting` first, then the store UPDATE lost
    // the race; re-read shows `paid` ⇒ already_paid, NOT a second payment.
    expect(result.outcome).toBe('already_paid')

    const row = await getPayoutByJomonRef(db, ref)
    expect(row?.payoutMethod).toBe('stripe_connect')
    expect(row?.stripeTransferId).toBe('tr_stripe_won')
    expect(row?.manualPaidAt).toBeNull()
  })

  it('store settlePayoutManually returns false (no-op) for paid/processing rows', async () => {
    if (!available) {
      return
    }
    const paidRef = `jmn-store-paid-${tag}`
    const procRef = `jmn-store-proc-${tag}`
    await seedRow(paidRef, 'paid', { stripeTransferId: 'tr_x' })
    await seedRow(procRef, 'processing')

    expect(await settlePayoutManually(db, { jomonRef: paidRef })).toBe(false)
    expect(await settlePayoutManually(db, { jomonRef: procRef })).toBe(false)

    // A claimable row settles (returns true) and records the audit fields.
    const okRef = `jmn-store-ok-${tag}`
    await seedRow(okRef, 'failed')
    expect(await settlePayoutManually(db, { jomonRef: okRef, note: 'n', byUserId: null })).toBe(true)
    const okRow = await getPayoutByJomonRef(db, okRef)
    expect(okRow?.status).toBe('paid')
    expect(okRow?.payoutMethod).toBe('manual_bank')
    expect(okRow?.manualPaidNote).toBe('n')
  })

  it('isolates a write-back failure: the payout stays paid and is left for retry', async () => {
    if (!available) {
      return
    }
    const ref = `jmn-manual-wbfail-${tag}`
    await seedRow(ref, 'pending')

    class FlakyJomon extends StubJomonClient {
      override async writeBackResult(): Promise<void> {
        throw new Error('jomon write-back boom')
      }
    }
    const jomon = new FlakyJomon()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await markPayoutManuallyPaid(
      { db, stripe: fakeStripe({ transferOk: false }), jomon },
      { jomonRef: ref, note: 'wb fail' },
    )
    // Settle succeeded; the write-back failure is isolated (logged, not thrown).
    expect(result.outcome).toBe('paid')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()

    const row = await getPayoutByJomonRef(db, ref)
    expect(row?.status).toBe('paid')
    expect(row?.payoutMethod).toBe('manual_bank')
    // Write-back unrecorded ⇒ retried later (never re-settled).
    expect(row?.jomonWrittenBackAt).toBeNull()
  })

  it('retries ONLY the write-back for an already manual-paid row whose write-back never recorded', async () => {
    if (!available) {
      return
    }
    const ref = `jmn-manual-wbretry-${tag}`
    // Already manually paid, but write-back not recorded (jomonWrittenBackAt NULL).
    await seedRow(ref, 'paid', { jomonWrittenBackAt: null })
    await db.update(schema.payouts)
      .set({ payoutMethod: 'manual_bank', manualPaidNote: 'prior note', manualPaidAt: new Date() })
      .where(eq(schema.payouts.jomonRef, ref))
    const jomon = new StubJomonClient()

    const result = await markPayoutManuallyPaid(
      { db, stripe: fakeStripe({ transferOk: false }), jomon },
      { jomonRef: ref, note: 'ignored on re-run' },
    )
    expect(result.outcome).toBe('already_paid')

    // Re-attempted write-back exactly once: NO stripeTransferId (manual row), and
    // the STORED note is re-sent as `message` (the retry must not drop the note).
    expect(jomon.writeBacks).toEqual([
      { jomonRef: ref, result: { status: 'paid', message: 'prior note' } },
    ])
    const row = await getPayoutByJomonRef(db, ref)
    expect(row?.jomonWrittenBackAt).toBeInstanceOf(Date)
    // The note is NOT overwritten on an already-paid short-circuit.
    expect(row?.manualPaidNote).toBe('prior note')
  })

  it('preserves the manual note across a failed-then-retried write-back', async () => {
    if (!available) {
      return
    }
    const ref = `jmn-manual-wbnote-${tag}`
    await seedRow(ref, 'pending')

    // A stub whose write-back fails on the FIRST call (the initial settle) and
    // succeeds on the second (the retry). Records every attempted payload.
    class FailFirstJomon extends StubJomonClient {
      attempts = 0
      override async writeBackResult(jomonRef: string, result: JomonWriteBackResult): Promise<void> {
        this.attempts += 1
        if (this.attempts === 1) {
          throw new Error('jomon write-back boom (first attempt)')
        }
        return super.writeBackResult(jomonRef, result)
      }
    }
    const jomon = new FailFirstJomon()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 1. Initial settle: paid succeeds, but the write-back fails (isolated).
    const first = await markPayoutManuallyPaid(
      { db, stripe: fakeStripe({ transferOk: false }), jomon },
      { jomonRef: ref, note: 'bank ref ABCDEF', byUserId: null },
    )
    expect(first.outcome).toBe('paid')
    const afterFirst = await getPayoutByJomonRef(db, ref)
    expect(afterFirst?.status).toBe('paid')
    expect(afterFirst?.jomonWrittenBackAt).toBeNull() // unrecorded ⇒ retried later
    expect(jomon.writeBacks).toHaveLength(0) // first attempt threw, recorded nothing

    // 2. Re-run on the already-paid row: retries ONLY the write-back, re-sending
    //    the STORED note (proving the retry path does not drop it).
    const second = await markPayoutManuallyPaid(
      { db, stripe: fakeStripe({ transferOk: false }), jomon },
      { jomonRef: ref, note: 'a different note on re-run' },
    )
    expect(second.outcome).toBe('already_paid')
    expect(jomon.writeBacks).toEqual([
      { jomonRef: ref, result: { status: 'paid', message: 'bank ref ABCDEF' } },
    ])
    warn.mockRestore()

    const row = await getPayoutByJomonRef(db, ref)
    expect(row?.jomonWrittenBackAt).toBeInstanceOf(Date)
    expect(row?.manualPaidNote).toBe('bank ref ABCDEF')
  })

  it('exposes manualPaidBy on the row DTO for the UI', async () => {
    if (!available) {
      return
    }
    const ref = `jmn-manual-by-${tag}`
    // Seed a real payee so the FK on manual_paid_by is satisfied.
    const payee = await makePayee('manualby', 'none')
    await seedRow(ref, 'failed')
    const jomon = new StubJomonClient()

    await markPayoutManuallyPaid(
      { db, stripe: fakeStripe({ transferOk: false }), jomon },
      { jomonRef: ref, note: 'n', byUserId: payee.id },
    )
    const row = await getPayoutByJomonRef(db, ref)
    expect(row?.payoutMethod).toBe('manual_bank')
    expect(row?.manualPaidBy).toBe(payee.id)
    expect(row?.manualPaidAt).toBeInstanceOf(Date)
  })
})
