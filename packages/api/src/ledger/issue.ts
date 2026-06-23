import type { Database } from '@checkin/db'
import type { Half } from './coverage'
import {
  getSlots,
  getSlotsByChargeGroup,
  releaseByChargeGroup,
  reserveSlots,
  type SlotRow,
} from './store'

/** Target person/year/halves an issuance wants to cover. */
export interface LedgerTarget {
  userId: string
  activityYear: number
  halves: Half[]
}

/**
 * Read-only decision over a target half-set — NO reservation, NO deletion.
 * (issuance-ledger spec: §原子的な予約と重複拒否 / §未払い既存発行の再利用)
 *   - `paid`     : a target half is already paid → reject.
 *   - `existing` : an OPEN issuance covers exactly these halves → reuse its invoice.
 *   - `conflict` : a target half overlaps a different issuance → reject (期間重複).
 *   - `free`     : nothing occupies the target halves → safe to issue.
 */
export type IssuanceResolution
  = | { kind: 'paid' }
    | { kind: 'existing', invoiceId: string }
    | { kind: 'conflict' }
    | { kind: 'free' }

/** Set-equality of two half lists (order-independent, 1–2 elements). */
function sameHalves(a: Half[], b: Half[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  const setB = new Set(b)
  return a.every(h => setB.has(h))
}

/** First non-null Stripe invoice id among a charge group's slots. */
function firstInvoiceId(slots: SlotRow[]): string | null {
  for (const s of slots) {
    if (s.stripeInvoiceId) {
      return s.stripeInvoiceId
    }
  }
  return null
}

/** Decide the ledger outcome for a target WITHOUT mutating anything. */
export async function resolveIssuance(db: Database, target: LedgerTarget): Promise<IssuanceResolution> {
  const { userId, activityYear, halves } = target
  const existing = await getSlots(db, userId, activityYear, halves)

  if (existing.some(s => s.status === 'paid')) {
    return { kind: 'paid' }
  }

  if (existing.length > 0) {
    const chargeGroups = [...new Set(existing.map(s => s.chargeGroup))]
    if (chargeGroups.length === 1) {
      const groupSlots = await getSlotsByChargeGroup(db, chargeGroups[0]!)
      // Exact match: an existing open charge covers precisely the target halves.
      if (sameHalves(groupSlots.map(s => s.half), halves)) {
        const invoiceId = firstInvoiceId(groupSlots)
        // Slots are always reserved WITH an invoice id, so this is non-null in
        // practice; reuse the existing issuance's invoice.
        if (invoiceId) {
          return { kind: 'existing', invoiceId }
        }
      }
    }
    // Different/partial coverage overlaps the target → 期間重複.
    return { kind: 'conflict' }
  }

  return { kind: 'free' }
}

/** What an issuance returns: the invoice to pay, or why it was rejected. */
export type IssuanceOutcome
  = | { ok: true, invoiceId: string, hostedInvoiceUrl: string | null }
    | { ok: false, rejected: 'paid' | 'conflict' }

/**
 * Stripe-backed operations the ledger flow drives (injected so the orchestration
 * is unit-testable without Stripe). `createDraft` makes a NON-payable draft
 * invoice (so a lost reservation race only discards a harmless draft);
 * `finalizeAndSend` makes an invoice payable and returns its hosted URL (and is
 * idempotent for an already-finalized invoice, recovering a stuck draft);
 * `voidInvoice` discards a draft/finalized-unpaid invoice (best-effort).
 */
export interface IssuanceOps {
  createDraft: () => Promise<string>
  finalizeAndSend: (invoiceId: string) => Promise<{ invoiceId: string, hostedInvoiceUrl: string | null }>
  voidInvoice: (invoiceId: string) => Promise<void>
}

/**
 * Issue over `target` with the ledger as the duplicate-payment guard, ordered so
 * a payable invoice NEVER exists without a slot guarding it:
 *   1. Decide (resolve). paid/conflict → reject; existing → finalize+reuse.
 *   2. free → create a non-payable DRAFT, then reserve the slot(s) WITH its id.
 *      - reservation conflict (race) → void the draft and re-decide.
 *   3. Finalize the invoice (now payable) — the guard is already in place.
 *      - finalize failure → void the (non-payable) invoice AND release the slots.
 * (issuance-ledger: money-safety — reserve-with-id before finalize)
 */
export async function issueWithLedger(
  db: Database,
  target: LedgerTarget,
  ops: IssuanceOps,
  attempt = 0,
): Promise<IssuanceOutcome> {
  const resolution = await resolveIssuance(db, target)
  if (resolution.kind === 'paid') {
    return { ok: false, rejected: 'paid' }
  }
  if (resolution.kind === 'conflict') {
    return { ok: false, rejected: 'conflict' }
  }
  if (resolution.kind === 'existing') {
    // Reuse: finalize-if-needed (recovers a crash-stuck draft) and return the URL.
    const sent = await ops.finalizeAndSend(resolution.invoiceId)
    return { ok: true, ...sent }
  }

  // free: create a non-payable draft, then reserve the slot(s) carrying its id.
  const invoiceId = await ops.createDraft()
  const reserved = await reserveSlots(db, { ...target, stripeInvoiceId: invoiceId })
  if (reserved === 'conflict') {
    // A concurrent issuer won the slot; discard our (non-payable) draft and
    // re-decide — the winner now shows as existing/paid/conflict.
    await ops.voidInvoice(invoiceId)
    if (attempt < 2) {
      return issueWithLedger(db, target, ops, attempt + 1)
    }
    return { ok: false, rejected: 'conflict' }
  }

  // Guard is in place; make the invoice payable. On failure void it (not payable)
  // and release the slots — a payable invoice without a guard can never result.
  try {
    const sent = await ops.finalizeAndSend(invoiceId)
    return { ok: true, ...sent }
  }
  catch (err) {
    await ops.voidInvoice(invoiceId).catch(() => {})
    await releaseByChargeGroup(db, reserved.chargeGroup)
    throw err
  }
}
