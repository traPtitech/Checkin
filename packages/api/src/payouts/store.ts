import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { schema, type Database } from '@checkin/db'
import type { PayoutStatus } from './status'

/** A payout row as the domain reads it (Stripe/Jomon-type-free). */
export interface PayoutRow {
  id: string
  jomonRef: string
  userId: string | null
  amount: number
  currency: string
  status: PayoutStatus
  stripeTransferId: string | null
  /** When the settled result was written back to Jomon, or null if not yet. */
  jomonWrittenBackAt: Date | null
}

const PAYOUT_COLUMNS = {
  id: schema.payouts.id,
  jomonRef: schema.payouts.jomonRef,
  userId: schema.payouts.userId,
  amount: schema.payouts.amount,
  currency: schema.payouts.currency,
  status: schema.payouts.status,
  stripeTransferId: schema.payouts.stripeTransferId,
  jomonWrittenBackAt: schema.payouts.jomonWrittenBackAt,
} as const

/** Statuses from which a payout may be claimed for execution (not `paid`/`processing`). */
const CLAIMABLE_STATUSES: PayoutStatus[] = ['pending', 'onboarding_waiting', 'failed']

/** Inputs to upsert a payout from an ingested Jomon transfer request. */
export interface UpsertPayoutInput {
  jomonRef: string
  amount: number
  currency: string
}

/**
 * Idempotently record an ingested transfer request and return its row.
 *
 * Upsert by `jomon_ref` with an `INSERT ... ON DUPLICATE KEY UPDATE` no-op
 * (mirrors `getOrCreateUserByMailHash`): re-ingesting the same request keeps the
 * single existing row and its accumulated state (status / userId / transfer id)
 * — it never creates a duplicate or resets progress. (payout-execution spec:
 * §取込は jomon_ref で冪等)
 */
export async function upsertPayoutByJomonRef(
  db: Database,
  input: UpsertPayoutInput,
): Promise<PayoutRow> {
  const id = randomUUID()
  await db
    .insert(schema.payouts)
    .values({
      id,
      jomonRef: input.jomonRef,
      amount: input.amount,
      currency: input.currency,
    })
    // No-op on conflict: preserve existing status/userId/stripeTransferId. We
    // touch `jomonRef` (the conflict key itself) so the row is "updated" without
    // changing any meaningful column.
    .onDuplicateKeyUpdate({ set: { jomonRef: input.jomonRef } })

  const row = await getPayoutByJomonRef(db, input.jomonRef)
  if (!row) {
    throw new Error('failed to upsert payout by jomon_ref')
  }
  return row
}

/** Fetch a payout row by its Jomon ref, or null. */
export async function getPayoutByJomonRef(
  db: Database,
  jomonRef: string,
): Promise<PayoutRow | null> {
  const [row] = await db
    .select(PAYOUT_COLUMNS)
    .from(schema.payouts)
    .where(eq(schema.payouts.jomonRef, jomonRef))
    .limit(1)
  return row ?? null
}

/** List payouts, optionally filtered by status (newest first). */
export async function listPayouts(
  db: Database,
  filter?: { status?: PayoutStatus },
): Promise<PayoutRow[]> {
  const base = db.select(PAYOUT_COLUMNS).from(schema.payouts)
  const rows = filter?.status
    ? await base.where(eq(schema.payouts.status, filter.status))
    : await base
  return rows
}

/** Link a payout to a resolved payee (`users.id`). */
export async function setPayoutUserId(
  db: Database,
  jomonRef: string,
  userId: string,
): Promise<void> {
  await db
    .update(schema.payouts)
    .set({ userId })
    .where(eq(schema.payouts.jomonRef, jomonRef))
}

/** Update a payout's status (and optionally its Stripe transfer id). */
export async function setPayoutStatus(
  db: Database,
  jomonRef: string,
  status: PayoutStatus,
  stripeTransferId?: string,
): Promise<void> {
  await db
    .update(schema.payouts)
    .set({ status, ...(stripeTransferId ? { stripeTransferId } : {}) })
    .where(eq(schema.payouts.jomonRef, jomonRef))
}

/**
 * Atomically claim a payout for execution: a single conditional UPDATE flips it
 * to `processing` ONLY if it is currently in a claimable state (`pending` /
 * `onboarding_waiting` / `failed`) — i.e. NOT already `paid` or `processing`.
 *
 *   UPDATE payouts SET status='processing'
 *   WHERE jomon_ref=? AND status IN ('pending','onboarding_waiting','failed')
 *
 * Returns `true` iff this call won the claim (`affectedRows === 1`). Two
 * concurrent executions for the same `jomon_ref` cannot both win — the loser
 * sees the row already `processing`/`paid` and must short-circuit (NOT transfer).
 * The Stripe idempotency key (`payout:${jomonRef}`) is the last line of defence
 * against double money movement if a claim is ever bypassed. (Codex hardening)
 */
export async function claimPayoutForExecution(
  db: Database,
  jomonRef: string,
): Promise<boolean> {
  const result = await db
    .update(schema.payouts)
    .set({ status: 'processing' })
    .where(and(
      eq(schema.payouts.jomonRef, jomonRef),
      inArray(schema.payouts.status, CLAIMABLE_STATUSES),
    ))

  // mysql2 returns affectedRows; 1 ⇒ we won the claim, 0 ⇒ already paid/processing.
  // (Same affectedRows extraction as email-verification / identity.)
  const affected = (result as unknown as { affectedRows?: number })?.affectedRows ?? 0
  const claimed = Array.isArray(result)
    ? ((result[0] as { affectedRows?: number })?.affectedRows ?? 0)
    : affected
  return claimed === 1
}

/** Mark a payout's Jomon write-back as completed (records the timestamp). */
export async function setPayoutJomonWrittenBackAt(
  db: Database,
  jomonRef: string,
  at: Date = new Date(),
): Promise<void> {
  await db
    .update(schema.payouts)
    .set({ jomonWrittenBackAt: at })
    .where(eq(schema.payouts.jomonRef, jomonRef))
}
