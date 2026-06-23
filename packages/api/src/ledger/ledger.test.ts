import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, schema, type Database } from '@checkin/db'
import { halvesForCoverage, standardActivityYear, standardCoverage } from './coverage'
import { getSlots, markPaidByInvoiceId } from './store'
import { issueWithLedger, resolveIssuance, type IssuanceOps } from './issue'
import { computeActivityYear } from '../billing/term'

/**
 * Tests for the membership issuance ledger (add-issuance-ledger). The coverage
 * pure functions always run; the slot/gate tests are DB-backed against the
 * MariaDB at DATABASE_URL and self-skip when unreachable so `pnpm test` stays
 * green without infrastructure.
 */

describe('ledger: coverage (pure)', () => {
  it('standardCoverage: 前期入部=通期, 後期入部=後期のみ, 継続=通期', () => {
    expect(standardCoverage('new', 'zenki')).toBe('full')
    expect(standardCoverage('new', 'kouki')).toBe('kouki')
    expect(standardCoverage('continuation', 'zenki')).toBe('full')
    expect(standardCoverage('continuation', 'kouki')).toBe('full')
  })

  it('halvesForCoverage: full=both, half=one', () => {
    expect(halvesForCoverage('full').sort()).toEqual(['kouki', 'zenki'])
    expect(halvesForCoverage('zenki')).toEqual(['zenki'])
    expect(halvesForCoverage('kouki')).toEqual(['kouki'])
  })

  it('standardActivityYear: 継続は翌年度(+1)、入部は現年度', () => {
    const now = new Date('2027-02-15T00:00:00Z') // 後期 of activity year 2026
    const base = computeActivityYear(now)
    expect(standardActivityYear(now, 'new')).toBe(base)
    expect(standardActivityYear(now, 'continuation')).toBe(base + 1)
  })
})

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

const userIds: string[] = []

afterAll(async () => {
  if (!available) {
    return
  }
  for (const id of userIds) {
    await db.delete(schema.membershipSlots).where(eq(schema.membershipSlots.userId, id))
    await db.delete(schema.users).where(eq(schema.users.id, id))
  }
})

async function makeUser(): Promise<string> {
  const id = randomUUID()
  await db.insert(schema.users).values({ id, mailHash: `hash_${id.slice(0, 12)}` })
  userIds.push(id)
  return id
}

/** In-memory fake of the Stripe issuance ops; tracks invoice lifecycle. */
function fakeOps(): IssuanceOps & { invoices: Map<string, string>, created: number } {
  const invoices = new Map<string, string>()
  const ctx = {
    invoices,
    created: 0,
    createDraft: async () => {
      ctx.created += 1
      const id = `in_${ctx.created}_${randomUUID().slice(0, 6)}`
      invoices.set(id, 'draft')
      return id
    },
    finalizeAndSend: async (id: string) => {
      if (invoices.get(id) === 'draft') {
        invoices.set(id, 'open')
      }
      return { invoiceId: id, hostedInvoiceUrl: `https://pay.example/${id}` }
    },
    voidInvoice: async (id: string) => {
      invoices.set(id, 'void')
    },
  }
  return ctx
}

const YEAR = 2099

describe('ledger: issueWithLedger (DB + fake Stripe)', () => {
  it('issues on free halves, reuses the same invoice while unpaid', async () => {
    if (!available) {
      return
    }
    const userId = await makeUser()
    const ops = fakeOps()

    const first = await issueWithLedger(db, { userId, activityYear: YEAR, halves: ['zenki', 'kouki'] }, ops)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    expect(ops.created).toBe(1)
    const slots = await getSlots(db, userId, YEAR, ['zenki', 'kouki'])
    expect(slots.length).toBe(2)
    expect(slots.every(s => s.stripeInvoiceId === first.invoiceId)).toBe(true) // reserved WITH the id

    // Re-issue while unpaid → reuse the SAME invoice, no new draft.
    const again = await issueWithLedger(db, { userId, activityYear: YEAR, halves: ['zenki', 'kouki'] }, ops)
    expect(again.ok && again.invoiceId).toBe(first.invoiceId)
    expect(ops.created).toBe(1)
  })

  it('rejects re-issue after the invoice is paid', async () => {
    if (!available) {
      return
    }
    const userId = await makeUser()
    const ops = fakeOps()
    const r = await issueWithLedger(db, { userId, activityYear: YEAR, halves: ['kouki'] }, ops)
    expect(r.ok).toBe(true)
    if (!r.ok) {
      return
    }
    expect(await markPaidByInvoiceId(db, r.invoiceId)).toBe(1)

    const after = await issueWithLedger(db, { userId, activityYear: YEAR, halves: ['kouki'] }, ops)
    expect(after).toEqual({ ok: false, rejected: 'paid' })
  })

  it('allows 後期 after 前期-only (rule 4), but rejects 通期 overlap', async () => {
    if (!available) {
      return
    }
    const userId = await makeUser()
    const ops = fakeOps()

    expect((await issueWithLedger(db, { userId, activityYear: YEAR, halves: ['zenki'] }, ops)).ok).toBe(true)
    expect((await issueWithLedger(db, { userId, activityYear: YEAR, halves: ['kouki'] }, ops)).ok).toBe(true)

    const full = await issueWithLedger(db, { userId, activityYear: YEAR, halves: ['zenki', 'kouki'] }, ops)
    expect(full).toEqual({ ok: false, rejected: 'conflict' })
  })

  it('rejects a half that a full issuance already covers', async () => {
    if (!available) {
      return
    }
    const userId = await makeUser()
    const ops = fakeOps()
    expect((await issueWithLedger(db, { userId, activityYear: YEAR, halves: ['zenki', 'kouki'] }, ops)).ok).toBe(true)

    const kouki = await issueWithLedger(db, { userId, activityYear: YEAR, halves: ['kouki'] }, ops)
    expect(kouki).toEqual({ ok: false, rejected: 'conflict' })
  })

  it('releases the slots and voids the invoice when finalize fails', async () => {
    if (!available) {
      return
    }
    const userId = await makeUser()
    const ops = fakeOps()
    // Force finalize to fail: the slots must be released and the draft voided so
    // no payable invoice survives and the half stays issuable.
    ops.finalizeAndSend = async () => {
      throw new Error('stripe finalize boom')
    }
    await expect(issueWithLedger(db, { userId, activityYear: YEAR, halves: ['zenki'] }, ops)).rejects.toThrow('boom')
    expect((await getSlots(db, userId, YEAR, ['zenki'])).length).toBe(0) // released
    const voided = [...ops.invoices.values()]
    expect(voided).toContain('void')

    // The half is free again — a retry succeeds.
    const retry = await issueWithLedger(db, { userId, activityYear: YEAR, halves: ['zenki'] }, fakeOps())
    expect(retry.ok).toBe(true)
  })
})

describe('ledger: resolveIssuance (DB, read-only)', () => {
  it('returns free when nothing occupies the halves', async () => {
    if (!available) {
      return
    }
    const userId = await makeUser()
    expect(await resolveIssuance(db, { userId, activityYear: YEAR, halves: ['zenki'] })).toEqual({ kind: 'free' })
  })
})
