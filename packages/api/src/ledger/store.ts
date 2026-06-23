import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { schema, type Database } from '@checkin/db'
import type { Half } from './coverage'

/** Slot lifecycle. `void`/failure removes the row, so two states suffice. */
export type SlotStatus = 'open' | 'paid'

/** A membership ledger slot as the domain reads it. */
export interface SlotRow {
  id: string
  userId: string
  activityYear: number
  half: Half
  chargeGroup: string
  stripeInvoiceId: string | null
  status: SlotStatus
}

const SLOT_COLUMNS = {
  id: schema.membershipSlots.id,
  userId: schema.membershipSlots.userId,
  activityYear: schema.membershipSlots.activityYear,
  half: schema.membershipSlots.half,
  chargeGroup: schema.membershipSlots.chargeGroup,
  stripeInvoiceId: schema.membershipSlots.stripeInvoiceId,
  status: schema.membershipSlots.status,
} as const

/**
 * Whether an error is a MySQL/MariaDB duplicate-key (ER_DUP_ENTRY = 1062). Walks
 * the `cause` chain because drizzle wraps the mysql2 error. (mirrors identity.ts)
 */
function isDuplicateKeyError(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: string }).code
    const errno = (cur as { errno?: number }).errno
    if (code === 'ER_DUP_ENTRY' || errno === 1062) {
      return true
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

/** Fetch existing slots for a person/year limited to the given halves. */
export async function getSlots(
  db: Database,
  userId: string,
  activityYear: number,
  halves: Half[],
): Promise<SlotRow[]> {
  if (halves.length === 0) {
    return []
  }
  return db
    .select(SLOT_COLUMNS)
    .from(schema.membershipSlots)
    .where(and(
      eq(schema.membershipSlots.userId, userId),
      eq(schema.membershipSlots.activityYear, activityYear),
      inArray(schema.membershipSlots.half, halves),
    ))
}

/** Fetch all slots of a charge group (the 1–2 halves of one issuance). */
export async function getSlotsByChargeGroup(db: Database, chargeGroup: string): Promise<SlotRow[]> {
  return db
    .select(SLOT_COLUMNS)
    .from(schema.membershipSlots)
    .where(eq(schema.membershipSlots.chargeGroup, chargeGroup))
}

/**
 * Atomically reserve `halves` as a single new charge group (`open`), each row
 * carrying the Stripe Invoice id from the start. The insert is one multi-row
 * statement, so a UNIQUE `(user_id, activity_year, half)` violation on ANY half
 * rolls back the whole reservation (no partial reserve). Returns the new
 * `chargeGroup`, or `'conflict'` if a half was already taken.
 *
 * The invoice id is set at reservation time (the issuance flow creates a
 * non-payable DRAFT first, reserves, THEN finalizes), so a slot is NEVER open
 * with a null invoice id — the webhook can always match it, and there is no
 * "orphaned reservation" to mistakenly delete. (issuance-ledger: money-safety)
 */
export async function reserveSlots(
  db: Database,
  input: { userId: string, activityYear: number, halves: Half[], stripeInvoiceId: string },
): Promise<{ chargeGroup: string } | 'conflict'> {
  const chargeGroup = randomUUID()
  const rows = input.halves.map(half => ({
    id: randomUUID(),
    userId: input.userId,
    activityYear: input.activityYear,
    half,
    chargeGroup,
    stripeInvoiceId: input.stripeInvoiceId,
    status: 'open' as const,
  }))
  try {
    await db.insert(schema.membershipSlots).values(rows)
    return { chargeGroup }
  }
  catch (err) {
    if (isDuplicateKeyError(err)) {
      return 'conflict'
    }
    throw err
  }
}

/**
 * Mark every slot of an Invoice `paid` (idempotent). Returns the affected row
 * count — 0 means the invoice has no ledger slots (台帳外) and the caller treats
 * the webhook as a success no-op. (issuance-ledger spec: §入金時の paid 確定)
 */
export async function markPaidByInvoiceId(db: Database, invoiceId: string, at: Date = new Date()): Promise<number> {
  const result = await db
    .update(schema.membershipSlots)
    .set({ status: 'paid', paidAt: at })
    .where(and(
      eq(schema.membershipSlots.stripeInvoiceId, invoiceId),
      eq(schema.membershipSlots.status, 'open'),
    ))
  const affected = (result as unknown as { affectedRows?: number })?.affectedRows ?? 0
  return Array.isArray(result)
    ? ((result[0] as { affectedRows?: number })?.affectedRows ?? 0)
    : affected
}

/** Release (delete) all slots of a charge group — void / issuance failure. */
export async function releaseByChargeGroup(db: Database, chargeGroup: string): Promise<void> {
  await db.delete(schema.membershipSlots).where(eq(schema.membershipSlots.chargeGroup, chargeGroup))
}
