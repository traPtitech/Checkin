import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { schema, type Database } from '@checkin/db'
import type { PayoutStatus } from './status'

/** How a payout was settled: a Stripe Connect transfer or a manual bank transfer. */
export type PayoutMethod = 'stripe_connect' | 'manual_bank'

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
  /** How this payout was settled (`stripe_connect` default / `manual_bank`). */
  payoutMethod: PayoutMethod
  /** Manual bank transfer reference note (NULL for Stripe payouts). */
  manualPaidNote: string | null
  /** When a `manual_bank` payout was confirmed paid (NULL for Stripe payouts). */
  manualPaidAt: Date | null
  /** The accountant (`users.id`) who recorded the manual transfer, or null. */
  manualPaidBy: string | null
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
  payoutMethod: schema.payouts.payoutMethod,
  manualPaidNote: schema.payouts.manualPaidNote,
  manualPaidAt: schema.payouts.manualPaidAt,
  manualPaidBy: schema.payouts.manualPaidBy,
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

/** Inputs to the atomic store-level manual-paid settle. */
export interface SettlePayoutManuallyInput {
  jomonRef: string
  /** Free-text reference note for the manual transfer (e.g. bank ref number). */
  note?: string
  /** The accountant (`users.id`) recording it — resolved server-side, may be null. */
  byUserId?: string | null
}

/**
 * Atomically settle a payout as `paid` via a MANUAL bank transfer (no Stripe
 * transfer): a single conditional UPDATE flips it to `paid` and records the audit
 * fields ONLY if it is currently in a claimable state — i.e. NOT already `paid`
 * or `processing`.
 *
 *   UPDATE payouts
 *      SET status='paid', payout_method='manual_bank', manual_paid_at=NOW(),
 *          manual_paid_note=?, manual_paid_by=?
 *    WHERE jomon_ref=? AND status IN ('pending','onboarding_waiting','failed')
 *
 * It deliberately shares the SAME `CLAIMABLE_STATUSES` predicate as
 * {@link claimPayoutForExecution}, so the manual settle and the Stripe execution
 * claim stay in lockstep: if both race for the same `jomon_ref`, only the one
 * whose WHERE matches first wins (`affectedRows === 1`) and the loser short-
 * circuits with `affectedRows === 0` — never a double payout. `stripe_transfer_id`
 * is NOT touched (a manual payout has none). The orchestration wrapper
 * `markPayoutManuallyPaid` (execute.ts) adds the Jomon write-back. (add-manual-bank-payout D2)
 */
export async function settlePayoutManually(
  db: Database,
  input: SettlePayoutManuallyInput,
): Promise<boolean> {
  const result = await db
    .update(schema.payouts)
    .set({
      status: 'paid',
      payoutMethod: 'manual_bank',
      manualPaidAt: new Date(),
      manualPaidNote: input.note ?? null,
      manualPaidBy: input.byUserId ?? null,
    })
    .where(and(
      eq(schema.payouts.jomonRef, input.jomonRef),
      inArray(schema.payouts.status, CLAIMABLE_STATUSES),
    ))

  // Same affectedRows extraction as `claimPayoutForExecution`: 1 ⇒ we settled it,
  // 0 ⇒ it was already paid/processing (claimable WHERE matched nothing).
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
