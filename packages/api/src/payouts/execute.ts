import type { Database } from '@checkin/db'
import { getOrCreateUserByTraqId, getUserById, getUserByTraqId } from '../auth/identity'
import type { StripeClient } from '../stripe/client'
import { createAccountOnboardingLink, getOrCreateConnectedAccount } from '../stripe/connect'
import { createTransfer } from '../stripe/transfers'
import { JomonWriteBackUnsupportedError } from '../jomon/http'
import type { JomonClient, JomonTransferRequest, JomonWriteBackResult } from '../jomon/types'
import { nextPayoutStatus, type PayoutStatus } from './status'
import {
  claimPayoutForExecution,
  getPayoutByJomonRef,
  settlePayoutManually,
  setPayoutJomonWrittenBackAt,
  setPayoutStatus,
  setPayoutUserId,
  upsertPayoutByJomonRef,
  type PayoutRow,
} from './store'

/**
 * Payout execution orchestration (design D4): thin wiring over the pure state
 * machine. Stripe/Jomon access goes through the adapters passed in as args; this
 * module never imports the Stripe SDK. It pulls approved requests, identifies the
 * payee, gates on onboarding, runs the transfer (idempotently), and writes the
 * result back to Jomon.
 */

/** Dependencies injected into the orchestration (host wires the concrete ones). */
export interface PayoutDeps {
  db: Database
  stripe: StripeClient
  jomon: JomonClient
}

/** Config the orchestration needs (resolved by the host). */
export interface PayoutExecuteConfig {
  /** App origin for onboarding refresh/return URLs. */
  appOrigin: string
  /** Default payout currency when a request omits one (e.g. 'jpy'). */
  defaultCurrency: string
}

/**
 * The outcome of advancing a single payout one step.
 *   - `unresolved`: payee not identified by traQ ID — not paid out, 要対応.
 *   - `onboarding_waiting`: onboarding not done — link issued, parked.
 *   - `paid`: transfer succeeded.
 *   - `failed`: transfer attempted but failed.
 *   - `already_paid`: terminal `paid` — short-circuited, no re-transfer.
 *   - `needs_review`: a guard prevented progress and a human must act, 要対応:
 *       the resolved user differs from the immutably-linked one (mis-mapping), a
 *       row was already claimed/`processing` by a concurrent run, or `processApproved`
 *       skipped a `failed` row (only the admin `execute` may retry `failed`).
 *   - `skipped_failed`: `processApproved` did not auto-retry a `failed` row.
 */
export type PayoutOutcome
  = 'unresolved' | 'onboarding_waiting' | 'paid' | 'failed' | 'already_paid'
    | 'needs_review' | 'skipped_failed'

/** Per-payout result returned to callers (Stripe/Jomon-type-free). */
export interface PayoutStepResult {
  jomonRef: string
  outcome: PayoutOutcome
  status: PayoutStatus
  /** Hosted onboarding URL, present when the outcome is `onboarding_waiting`. */
  onboardingUrl?: string
}

/** Aggregate summary of a `processApproved` run. */
export interface ProcessApprovedSummary {
  /** Total approved requests ingested this run. */
  ingested: number
  /** Count newly/again paid out. */
  paid: number
  /** Count waiting on onboarding. */
  onboardingWaiting: number
  /** Count whose payee could not be identified (要対応). */
  unresolved: number
  /** Count whose transfer failed. */
  failed: number
  /** Count already `paid` and short-circuited. */
  alreadyPaid: number
  /** Count flagged for manual review (userId mis-map / claimed by another run). */
  needsReview: number
  /** Count of `failed` rows skipped (not auto-retried by `processApproved`). */
  skippedFailed: number
  /** Count of items that threw and were isolated (one bad item never aborts the batch). */
  errored: number
  /** `jomon_ref`s of items that threw, for accountant follow-up. */
  errors: string[]
  /**
   * Application ids (v1) skipped because they have MORE THAN ONE unpaid payee:
   * v1 has no per-payee amount, so they are not auto-paid. Counted in
   * `needsReview`; listed here so the UI can alert the accountant for manual
   * handling. (payout-execution: §v1 の払い戻し金額と複数受取人の扱い)
   */
  multiPayeeRefs: string[]
  /**
   * Set when the approved-requests fetch itself failed: the run is reported with
   * an empty body and this top-level error indicator instead of throwing, so a
   * Jomon list/HTTP/zod failure never aborts the whole run with nothing recorded.
   */
  listError?: string
}

/**
 * Ingest approved requests and advance each one step (the accounting trigger).
 *
 * Idempotent end-to-end: ingestion upserts by `jomon_ref`, `paid` payouts
 * short-circuit, and the transfer uses a deterministic idempotency key — so a
 * repeated run never double-pays. (design D4 / D5; spec §取込は jomon_ref で冪等)
 */
export async function processApprovedPayouts(
  deps: PayoutDeps,
  config: PayoutExecuteConfig,
): Promise<ProcessApprovedSummary> {
  const summary: ProcessApprovedSummary = {
    ingested: 0,
    paid: 0,
    onboardingWaiting: 0,
    unresolved: 0,
    failed: 0,
    alreadyPaid: 0,
    needsReview: 0,
    skippedFailed: 0,
    errored: 0,
    errors: [],
    multiPayeeRefs: [],
  }

  // Batch-fetch isolation: the approved-requests pull happens BEFORE any per-item
  // work, so a list/HTTP/zod failure here would otherwise abort the whole run with
  // nothing recorded. Catch it, log, and RETURN the (empty) summary with a
  // top-level `listError` so callers/tests see the fetch failed rather than a
  // throw. No money has moved at this point. (Codex hardening: §batch-abort)
  let requests: JomonTransferRequest[]
  try {
    requests = await deps.jomon.listApprovedTransferRequests()
  }
  catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[payout] failed to list approved transfer requests; nothing processed this run: ${reason}`)
    summary.listError = reason
    return summary
  }

  for (const req of requests) {
    // Multi-payee application (v1): no per-payee amount exists, so it must NOT be
    // auto-paid. Do NOT upsert a payout row (there is no single payee/userId) and
    // do NOT transfer — flag needs-review and surface it for the accountant.
    // (payout-execution: §v1 の払い戻し金額と複数受取人の扱い)
    if (req.multiPayee) {
      summary.ingested += 1
      summary.needsReview += 1
      summary.multiPayeeRefs.push(req.jomonRef)
      continue
    }

    // Per-item error isolation: one bad item (Jomon write-back, DB hiccup,
    // malformed request, etc.) must NOT abort the rest of the batch. Record it
    // and continue. (Codex hardening)
    try {
      // 1. Idempotent upsert by jomon_ref (preserves any existing state).
      await upsertPayoutByJomonRef(deps.db, {
        jomonRef: req.jomonRef,
        amount: req.amount,
        currency: req.currency || config.defaultCurrency,
      })
      summary.ingested += 1

      // `processApproved` is the automated trigger: it must NOT auto-retry
      // `failed` rows — only the admin single-item `execute` may. (Codex hardening)
      const result = await advancePayout(deps, config, req, { allowFailedRetry: false })
      tally(summary, result.outcome)
    }
    catch (err) {
      summary.errored += 1
      summary.errors.push(req.jomonRef)
      // Swallow: isolation is the point. Detail is surfaced via the summary.
      void err
    }
  }

  return summary
}

/**
 * Advance a single payout (by `jomonRef`) one step — for manual resume of an
 * `onboarding_waiting` payout or a retry after `failed`. Re-pulls the request
 * from Jomon so amount/payee are current; throws if it is no longer approved.
 * (design D5: `payouts.execute`)
 */
export async function executePayout(
  deps: PayoutDeps,
  config: PayoutExecuteConfig,
  jomonRef: string,
): Promise<PayoutStepResult> {
  const requests = await deps.jomon.listApprovedTransferRequests()
  const req = requests.find(r => r.jomonRef === jomonRef)
  if (req?.multiPayee) {
    // Defensive: a multi-payee application has no single payee/amount, so it must
    // NOT be paid even via the manual single-item path. No row is created.
    // (The UI never offers `execute` on a marker — markers are not table rows —
    // but guard here so no caller can promote one to a transfer.)
    // (payout-execution: §v1 の払い戻し金額と複数受取人の扱い)
    return { jomonRef, outcome: 'needs_review', status: 'pending' }
  }
  if (!req) {
    // It may have already settled (and been removed from "approved"). If we have
    // a local row, advance using its stored amount/currency; else surface it.
    const existing = await getPayoutByJomonRef(deps.db, jomonRef)
    if (!existing) {
      throw new Error(`payout not found and not approved in Jomon: ${jomonRef}`)
    }
    // Admin single-item path: `execute` MAY retry a `failed` row. (Codex hardening)
    return advancePayout(deps, config, {
      jomonRef: existing.jomonRef,
      payeeTraqId: '',
      amount: existing.amount,
      currency: existing.currency,
    }, { allowFailedRetry: true })
  }
  // Ensure the row exists (idempotent) before advancing.
  await upsertPayoutByJomonRef(deps.db, {
    jomonRef: req.jomonRef,
    amount: req.amount,
    currency: req.currency || config.defaultCurrency,
  })
  // Admin single-item path: `execute` MAY retry a `failed` row. (Codex hardening)
  return advancePayout(deps, config, req, { allowFailedRetry: true })
}

/** Inputs to record a manual bank transfer as a settled `paid` payout. */
export interface MarkPayoutManuallyPaidInput {
  jomonRef: string
  /** Free-text reference note for the manual transfer (e.g. bank ref number). */
  note?: string
  /** The accountant (`users.id`) recording it — resolved server-side, may be null. */
  byUserId?: string | null
}

/**
 * Record a MANUAL bank transfer as a settled `paid` payout — WITHOUT issuing a
 * Stripe transfer. For a payee who cannot complete Connect onboarding, the
 * accountant pays them by hand and records that fact here. Unlike
 * {@link executePayout}/{@link processApprovedPayouts}, this does NOT pull Jomon's
 * approved list: it operates on the LOCAL payout row only (the request may no
 * longer be approved, or the payee may have no connected account — that is the
 * whole point). (add-manual-bank-payout D3; spec §手動振込での paid 確定)
 *
 * Atomic, idempotent, and race-safe against the Stripe execution claim:
 *   1. Load the local row; throw if missing (router maps to NOT_FOUND).
 *   2. Already `paid` ⇒ short-circuit (retry ONLY the write-back if not yet done).
 *      `processing` ⇒ `needs_review` — never overwrite an in-flight Stripe run.
 *   3. The store's single conditional UPDATE settles it ONLY from a claimable
 *      state, sharing `claimPayoutForExecution`'s predicate. If it loses the race
 *      (`affectedRows === 0`), re-read: now `paid` ⇒ `already_paid` (+ write-back
 *      retry), else `needs_review`. Never double-pay.
 *   4. On win, write the settled result back to Jomon via {@link tryWriteBack}
 *      with `{ status: 'paid', message: note }` — NO `stripeTransferId` (a manual
 *      payout has none; v1 write-back does not require it).
 *
 * `user_id` immutability is preserved: this never sets or relinks the payee
 * (null is allowed — onboarding may never have started). (spec §本人特定の不変条件)
 */
export async function markPayoutManuallyPaid(
  deps: PayoutDeps,
  input: MarkPayoutManuallyPaidInput,
): Promise<PayoutStepResult> {
  const { jomonRef, note, byUserId } = input

  // 1. Operate on the LOCAL row only — do NOT pull Jomon's approved list.
  const row = await getPayoutByJomonRef(deps.db, jomonRef)
  if (!row) {
    throw new Error(`payout not found for jomon_ref: ${jomonRef}`)
  }

  // 2. Terminal `paid` ⇒ never re-settle. Retry ONLY the write-back if it never
  //    recorded (decoupled from settlement, like the Stripe path).
  if (row.status === 'paid') {
    if (row.jomonWrittenBackAt === null) {
      await reattemptWriteBack(deps, row)
    }
    return { jomonRef, outcome: 'already_paid', status: 'paid' }
  }
  // `processing` ⇒ a Stripe execution is mid-flight; do NOT overwrite it. Leave
  // it to the winner / an admin (stale `processing` after a crash = 要対応).
  if (row.status === 'processing') {
    return { jomonRef, outcome: 'needs_review', status: 'processing' }
  }

  // 3. Atomically settle from a claimable state. Shares the Stripe claim's
  //    predicate, so a concurrent Stripe execution and this manual settle can
  //    never both win — the loser short-circuits without paying twice.
  const won = await settlePayoutManually(deps.db, { jomonRef, note, byUserId })
  if (!won) {
    const fresh = await getPayoutByJomonRef(deps.db, jomonRef)
    // The other side won and already paid ⇒ short-circuit (retry write-back if needed).
    if (fresh?.status === 'paid') {
      if (fresh.jomonWrittenBackAt === null) {
        await reattemptWriteBack(deps, fresh)
      }
      return { jomonRef, outcome: 'already_paid', status: 'paid' }
    }
    // Otherwise mid-flight (`processing`) or unexpected ⇒ leave it. Never pay.
    return { jomonRef, outcome: 'needs_review', status: fresh?.status ?? row.status }
  }

  // 4. Won the settle — write the (manual) settled result back to Jomon. No
  //    stripeTransferId: a manual payout has none, and v1 write-back does not
  //    require it (it only sends `repaid_at`). The note rides along as `message`.
  //    A write-back failure (incl. v2 unsupported) is isolated by tryWriteBack:
  //    the payout stays `paid`, the write-back is retried later, never re-paid.
  await tryWriteBack(deps, jomonRef, { status: 'paid', message: note })

  return { jomonRef, outcome: 'paid', status: 'paid' }
}

/** Options that gate how `advancePayout` treats certain statuses. */
interface AdvanceOptions {
  /**
   * Whether a `failed` row may be retried. `processApproved` (automated trigger)
   * passes `false` — it must NOT auto-retry failures; only the admin single-item
   * `execute` passes `true`. (Codex hardening: §explicit retry policy for failed)
   */
  allowFailedRetry: boolean
}

/**
 * Advance one payout exactly one step. Assumes the row already exists. Resolves
 * the payee, enforces userId immutability, gates on onboarding, ATOMICALLY claims
 * the row before the transfer, runs the transfer (idempotently), persists status,
 * and writes the settled result back to Jomon. (design D4 + Codex hardening)
 */
async function advancePayout(
  deps: PayoutDeps,
  config: PayoutExecuteConfig,
  req: JomonTransferRequest,
  options: AdvanceOptions,
): Promise<PayoutStepResult> {
  const row = await getPayoutByJomonRef(deps.db, req.jomonRef)
  if (!row) {
    throw new Error(`payout row missing for jomon_ref: ${req.jomonRef}`)
  }

  // `paid` is terminal — never re-transfer. But the Jomon write-back is decoupled
  // from the transfer: if a previous run paid but the write-back failed, retry
  // ONLY the write-back here (it never re-transfers). (Codex hardening: §retryable
  // write-back / spec §再実行は二重送金しない)
  if (row.status === 'paid') {
    if (row.jomonWrittenBackAt === null) {
      await reattemptWriteBack(deps, row)
    }
    return { jomonRef: req.jomonRef, outcome: 'already_paid', status: 'paid' }
  }

  // A row already mid-flight (`processing`) was claimed by a concurrent run; do
  // NOT advance/transfer it. Stale `processing` after a crash needs an admin's
  // attention; the claim deliberately excludes `processing`, and Stripe's
  // idempotency key prevents double money movement on any manual re-run.
  if (row.status === 'processing') {
    return { jomonRef: req.jomonRef, outcome: 'needs_review', status: 'processing' }
  }

  // Retry policy for `failed`: only the admin single-item `execute` may retry;
  // `processApproved` skips them so the batch never auto-re-pays a failure. The
  // atomic claim WHERE-clause stays inclusive of `failed`; we gate the difference
  // here at the orchestration level. (Codex hardening: §explicit retry policy)
  if (row.status === 'failed' && !options.allowFailedRetry) {
    return { jomonRef: req.jomonRef, outcome: 'skipped_failed', status: 'failed' }
  }

  // 2. Identify the payee by their linked traQ ID (`users.traq_id`). We prefer the
  //    freshly-pulled traQ ID; an empty one (resume without a live request) falls
  //    back to the already-linked userId. Unresolved ⇒ leave userId null, no payout.
  const user = await resolvePayee(deps, req, row)
  if (!user) {
    return { jomonRef: req.jomonRef, outcome: 'unresolved', status: row.status }
  }

  // userId is IMMUTABLE once set. If a later run resolves a DIFFERENT user from
  // the traQ ID, do NOT relink — that signals a traQ mapping change / mis-route,
  // so flag for manual review and never transfer. Only set userId when still null.
  // (Codex hardening: §userId immutability)
  if (row.userId === null) {
    await setPayoutUserId(deps.db, req.jomonRef, user.id)
  }
  else if (row.userId !== user.id) {
    return { jomonRef: req.jomonRef, outcome: 'needs_review', status: row.status }
  }

  // 3. Onboarding gate: not `done` ⇒ get-or-create the connected account, issue a
  //    hosted onboarding link, and park the payout as `onboarding_waiting`.
  if (user.payoutOnboardingStatus !== 'done') {
    const accountId = await getOrCreateConnectedAccount(deps.stripe, deps.db, {
      userId: user.id,
      stripeConnectedAccountId: user.stripeConnectedAccountId,
      mailHash: user.mailHash,
      traqId: user.traqId,
    })
    const onboardingUrl = await createAccountOnboardingLink(deps.stripe, {
      accountId,
      refreshUrl: `${config.appOrigin}/payouts/onboarding/refresh`,
      returnUrl: `${config.appOrigin}/payouts/onboarding/return`,
    })
    const status = nextPayoutStatus(row.status, { onboardingDone: false })
    await setPayoutStatus(deps.db, req.jomonRef, status)
    return { jomonRef: req.jomonRef, outcome: 'onboarding_waiting', status, onboardingUrl }
  }

  // 4. Onboarding is `done`.
  if (!user.stripeConnectedAccountId) {
    // Defensive: `done` implies a linked account; if not, treat as not-ready.
    const status = nextPayoutStatus(row.status, { onboardingDone: false })
    await setPayoutStatus(deps.db, req.jomonRef, status)
    return { jomonRef: req.jomonRef, outcome: 'onboarding_waiting', status }
  }

  // 4a. ATOMICALLY claim the row for execution BEFORE the transfer. Only one
  //     concurrent run can flip a claimable row (`pending`/`onboarding_waiting`/
  //     `failed`) to `processing`; the loser re-reads and short-circuits without
  //     transferring, so two callers can never both pass the pre-transfer check
  //     and double-pay. (Codex hardening: §atomic execution claim)
  const claimed = await claimPayoutForExecution(deps.db, req.jomonRef)
  if (!claimed) {
    const fresh = await getPayoutByJomonRef(deps.db, req.jomonRef)
    // Already paid by the winning run ⇒ short-circuit (retry write-back if needed).
    if (fresh?.status === 'paid') {
      if (fresh.jomonWrittenBackAt === null) {
        await reattemptWriteBack(deps, fresh)
      }
      return { jomonRef: req.jomonRef, outcome: 'already_paid', status: 'paid' }
    }
    // Otherwise it is mid-flight (`processing`) or in an unexpected state ⇒ leave
    // it to the winner / an admin. Never transfer. (stale `processing` = 要対応)
    return { jomonRef: req.jomonRef, outcome: 'needs_review', status: fresh?.status ?? row.status }
  }

  // 4b. Claim won — run the transfer (idempotency key `payout:${ref}`; a retry
  //     with the same key returns the original Transfer, never a second one) and
  //     settle to `paid`+stripeTransferId or `failed`.
  let transferOk: boolean
  let transferId: string | undefined
  let failureMessage: string | undefined
  try {
    const result = await createTransfer(deps.stripe, {
      destinationAccountId: user.stripeConnectedAccountId,
      amount: row.amount,
      currency: row.currency,
      idempotencyKey: `payout:${req.jomonRef}`,
      metadata: { jomon_ref: req.jomonRef },
    })
    transferId = result.transferId
    transferOk = true
  }
  catch (err) {
    transferOk = false
    failureMessage = err instanceof Error ? err.message : String(err)
  }

  // Settle from `processing`: success ⇒ `paid`, failure ⇒ `failed`. We never let
  // a stale caller overwrite `paid` because the claim excludes `paid`/`processing`.
  const status = transferOk ? 'paid' : 'failed'
  await setPayoutStatus(deps.db, req.jomonRef, status, transferId)

  // 5. Write the settled result back to Jomon, then record the write-back so a
  //    later `paid` re-run does not repeat it. A write-back failure (including v2
  //    being unsupported) is isolated: we log a warning, KEEP the payout in its
  //    settled state, and leave jomonWrittenBackAt NULL so the write-back is
  //    retried on the next pass WITHOUT re-transferring. (design D3 / spec
  //    §書き戻し失敗は再試行され、再送金はしない)
  await tryWriteBack(deps, req.jomonRef, {
    status: transferOk ? 'paid' : 'failed',
    stripeTransferId: transferId,
    message: failureMessage,
  })

  return {
    jomonRef: req.jomonRef,
    outcome: transferOk ? 'paid' : 'failed',
    status,
  }
}

/**
 * Re-attempt ONLY the Jomon write-back for an already-`paid` payout whose
 * write-back has not yet been recorded. Never re-transfers. A failure (incl. v2
 * unsupported) is isolated by {@link tryWriteBack}: it stays unrecorded for a
 * future retry. (Codex hardening: §retryable write-back avoids re-transfer)
 *
 * Reconstructs the write-back result from the row so a retry carries the SAME
 * payload as the original settle: a Stripe payout re-sends its `stripeTransferId`;
 * a `manual_bank` payout has no transfer id but re-sends its `manual_paid_note`
 * as `message` (so the reference note is not lost on retry). (add-manual-bank-payout D4)
 */
async function reattemptWriteBack(deps: PayoutDeps, row: PayoutRow): Promise<void> {
  if (row.payoutMethod === 'manual_bank') {
    await tryWriteBack(deps, row.jomonRef, {
      status: 'paid',
      message: row.manualPaidNote ?? undefined,
    })
    return
  }
  await tryWriteBack(deps, row.jomonRef, {
    status: 'paid',
    stripeTransferId: row.stripeTransferId ?? undefined,
  })
}

/**
 * Write a settled result back to Jomon and record `jomon_written_back_at` ON
 * SUCCESS ONLY. A write-back failure — a v2 {@link JomonWriteBackUnsupportedError}
 * or any transport/validation error — is caught, logged as a warning, and
 * swallowed: the payout's `paid`/`failed` state is preserved and the timestamp
 * stays NULL, so a later run retries the write-back ONLY (never re-transfers).
 * v2 keeps failing until Jomon adds the endpoint, but no double payout occurs.
 * (design D3 / spec §v2 の書き戻しは未対応として扱う)
 */
async function tryWriteBack(
  deps: PayoutDeps,
  jomonRef: string,
  result: JomonWriteBackResult,
): Promise<void> {
  try {
    await deps.jomon.writeBackResult(jomonRef, result)
    await setPayoutJomonWrittenBackAt(deps.db, jomonRef)
  }
  catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const unsupported = err instanceof JomonWriteBackUnsupportedError
    console.warn(
      `[payout] Jomon write-back ${unsupported ? 'unsupported' : 'failed'} for ${jomonRef}; `
      + `payout stays settled, will retry write-back later: ${reason}`,
    )
  }
}

/**
 * Resolve the payee for a request: by fresh traQ ID, else by the linked userId.
 * A traQ ID with no person row yet mints a payout-only row (mail_hash NULL) — a
 * Jomon refund recipient need not have done isct email verification to be paid.
 * (add-traq-only-payout-recipient)
 */
async function resolvePayee(
  deps: PayoutDeps,
  req: JomonTransferRequest,
  row: PayoutRow,
) {
  if (req.payeeTraqId) {
    return (await getUserByTraqId(deps.db, req.payeeTraqId))
      ?? (await getOrCreateUserByTraqId(deps.db, req.payeeTraqId))
  }
  // No traQ ID (resume of an existing row): use the already-linked payee if any.
  if (row.userId) {
    return getUserById(deps.db, row.userId)
  }
  return null
}

/** Increment the matching summary counter for an outcome. */
function tally(summary: ProcessApprovedSummary, outcome: PayoutOutcome): void {
  switch (outcome) {
    case 'paid':
      summary.paid += 1
      break
    case 'onboarding_waiting':
      summary.onboardingWaiting += 1
      break
    case 'unresolved':
      summary.unresolved += 1
      break
    case 'failed':
      summary.failed += 1
      break
    case 'already_paid':
      summary.alreadyPaid += 1
      break
    case 'needs_review':
      summary.needsReview += 1
      break
    case 'skipped_failed':
      summary.skippedFailed += 1
      break
  }
}
