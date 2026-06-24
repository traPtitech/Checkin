import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { schema, type Database } from '@checkin/db'

export interface UserRow {
  id: string
  /** Null for a payout-only recipient (identified by traq_id, never email-verified). */
  mailHash: string | null
}

/**
 * A person row including its (nullable) Stripe Customer link and Connect payout
 * fields — for billing and payouts. `traqId` is the linked authenticated traQ ID
 * (副キー) used to resolve Jomon payouts. (identity spec: §Stripe 参照・状態は保持してよい
 * / §traQ ID による本人解決と連結)
 */
export interface BillingUserRow {
  id: string
  /** Null for a payout-only recipient (identified by traq_id, never email-verified). */
  mailHash: string | null
  traqId: string | null
  stripeCustomerId: string | null
  stripeConnectedAccountId: string | null
  payoutOnboardingStatus: 'none' | 'requested' | 'done'
}

/** Fetch a person row by id, including its Stripe links/state, or null. */
export async function getUserById(db: Database, id: string): Promise<BillingUserRow | null> {
  const [row] = await db
    .select({
      id: schema.users.id,
      mailHash: schema.users.mailHash,
      traqId: schema.users.traqId,
      stripeCustomerId: schema.users.stripeCustomerId,
      stripeConnectedAccountId: schema.users.stripeConnectedAccountId,
      payoutOnboardingStatus: schema.users.payoutOnboardingStatus,
    })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1)
  return row ?? null
}

/**
 * Look up a person row by `mail_hash` WITHOUT creating one. Returns null when no
 * row matches — payout person-resolution must not invent a payee, so an
 * unresolved request stays "要対応" (and is not paid out). Distinct from
 * {@link getOrCreateUserByMailHash}, which is for login. (payout-execution spec:
 * §本人特定（対応表 mail_hash）)
 */
export async function getUserByMailHash(
  db: Database,
  mailHash: string,
): Promise<BillingUserRow | null> {
  const [row] = await db
    .select({
      id: schema.users.id,
      mailHash: schema.users.mailHash,
      traqId: schema.users.traqId,
      stripeCustomerId: schema.users.stripeCustomerId,
      stripeConnectedAccountId: schema.users.stripeConnectedAccountId,
      payoutOnboardingStatus: schema.users.payoutOnboardingStatus,
    })
    .from(schema.users)
    .where(eq(schema.users.mailHash, mailHash))
    .limit(1)
  return row ?? null
}

/**
 * Look up a person row by their linked authenticated `traq_id`, or null. Used to
 * resolve the user behind a traQ login (already-linked members skip re-confirm)
 * and to resolve Jomon payouts (keyed by traQ ID). Returns null when no row
 * carries that traq_id — payout person-resolution must not invent a payee.
 * (identity spec: §連結済み traq_id で本人解決 / §未連結は解決できない)
 */
export async function getUserByTraqId(db: Database, traqId: string): Promise<BillingUserRow | null> {
  const [row] = await db
    .select({
      id: schema.users.id,
      mailHash: schema.users.mailHash,
      traqId: schema.users.traqId,
      stripeCustomerId: schema.users.stripeCustomerId,
      stripeConnectedAccountId: schema.users.stripeConnectedAccountId,
      payoutOnboardingStatus: schema.users.payoutOnboardingStatus,
    })
    .from(schema.users)
    .where(eq(schema.users.traqId, traqId))
    .limit(1)
  return row ?? null
}

/** Fetch a person row by its Connect connected-account id, or null. */
export async function getUserByConnectedAccountId(
  db: Database,
  accountId: string,
): Promise<BillingUserRow | null> {
  const [row] = await db
    .select({
      id: schema.users.id,
      mailHash: schema.users.mailHash,
      traqId: schema.users.traqId,
      stripeCustomerId: schema.users.stripeCustomerId,
      stripeConnectedAccountId: schema.users.stripeConnectedAccountId,
      payoutOnboardingStatus: schema.users.payoutOnboardingStatus,
    })
    .from(schema.users)
    .where(eq(schema.users.stripeConnectedAccountId, accountId))
    .limit(1)
  return row ?? null
}

/**
 * Race-safe compare-and-set of a person's connected-account id: only links it
 * when the column is still NULL. Returns whether *this* call won the claim — a
 * concurrent caller that set it first leaves us with `false` (no overwrite of an
 * already-linked account). The `unique` constraint on the column backs this up
 * as a last line of defence. (connect-onboarding spec: §connected account の get-or-create)
 */
export async function claimConnectedAccountId(
  db: Database,
  userId: string,
  accountId: string,
): Promise<boolean> {
  // UPDATE ... WHERE id = ? AND stripe_connected_account_id IS NULL
  const result = await db
    .update(schema.users)
    .set({ stripeConnectedAccountId: accountId })
    .where(and(
      eq(schema.users.id, userId),
      isNull(schema.users.stripeConnectedAccountId),
    ))

  // mysql2 returns affectedRows; 1 ⇒ we set it, 0 ⇒ someone else already did.
  const affected = (result as unknown as { affectedRows?: number })?.affectedRows ?? 0
  const claimed = Array.isArray(result)
    ? ((result[0] as { affectedRows?: number })?.affectedRows ?? 0)
    : affected
  return claimed > 0
}

/**
 * Race-safe compare-and-set of a person's authenticated `traq_id`: only links it
 * when the column is still NULL. Mirrors {@link claimConnectedAccountId} and the
 * spec's "未設定なら保存・上書きしない" rule.
 *
 *   - `'linked'`   — this call set the column (`affectedRows === 1`).
 *   - `'exists'`   — the row already carries the SAME traq_id (idempotent re-link).
 *   - `'conflict'` — another person already owns that traq_id (unique violation),
 *                    OR our compare-and-set matched no row because this row holds
 *                    a DIFFERENT traq_id. Caller logs and proceeds (best-effort).
 *
 * The `unique` constraint on `users.traq_id` backs the conditional UPDATE: even
 * if the IS NULL guard were lost to a race, the second writer hits ER_DUP_ENTRY.
 * (identity spec: §traQ ID による本人解決と連結 / membership-billing spec: §既に連結済みなら維持)
 */
export async function linkTraqId(
  db: Database,
  userId: string,
  traqId: string,
): Promise<'linked' | 'exists' | 'conflict'> {
  // UPDATE ... WHERE id = ? AND traq_id IS NULL — only fills an unset column.
  let result: unknown
  try {
    result = await db
      .update(schema.users)
      .set({ traqId })
      .where(and(
        eq(schema.users.id, userId),
        isNull(schema.users.traqId),
      ))
  }
  catch (err) {
    // Someone else already owns this traq_id (unique violation) → conflict.
    if (isDuplicateKeyError(err)) {
      return 'conflict'
    }
    throw err
  }

  // mysql2 returns affectedRows; 1 ⇒ we set it. 0 ⇒ the IS NULL guard failed
  // (the row already has a traq_id — same value is idempotent, a different value
  // is a conflict we must not overwrite).
  const affected = (result as { affectedRows?: number })?.affectedRows ?? 0
  const claimed = Array.isArray(result)
    ? ((result[0] as { affectedRows?: number })?.affectedRows ?? 0)
    : affected
  if (claimed > 0) {
    return 'linked'
  }

  const existing = await getUserById(db, userId)
  return existing?.traqId === traqId ? 'exists' : 'conflict'
}

/**
 * Whether an error is a MySQL/MariaDB duplicate-key (ER_DUP_ENTRY = 1062). Walks
 * the `cause` chain because drizzle wraps the mysql2 error ("Failed query: ...")
 * and carries the original (with `code`/`errno`) as `.cause`.
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

/** Update a person's payout onboarding status (none / requested / done). */
export async function setPayoutOnboardingStatus(
  db: Database,
  userId: string,
  status: 'none' | 'requested' | 'done',
): Promise<void> {
  await db
    .update(schema.users)
    .set({ payoutOnboardingStatus: status })
    .where(eq(schema.users.id, userId))
}

/**
 * Get the person row for a `mail_hash`, creating it if absent. Idempotent and
 * race-safe: the `INSERT ... ON DUPLICATE KEY UPDATE` no-op plus the unique
 * `mail_hash` constraint guarantee a single row even under concurrency.
 * (identity spec: §本人行の get-or-create)
 */
export async function getOrCreateUserByMailHash(db: Database, mailHash: string): Promise<UserRow> {
  const id = randomUUID()
  await db
    .insert(schema.users)
    .values({ id, mailHash })
    .onDuplicateKeyUpdate({ set: { mailHash } })

  const [row] = await db
    .select({ id: schema.users.id, mailHash: schema.users.mailHash })
    .from(schema.users)
    .where(eq(schema.users.mailHash, mailHash))
    .limit(1)

  if (!row) {
    throw new Error('failed to get-or-create user by mail_hash')
  }
  return row
}

/**
 * Get the person row for a `traq_id`, creating a payout-only row (mail_hash NULL)
 * if absent. For Jomon refunds whose payee has never done isct email verification:
 * a person is identified by EITHER mail_hash or traq_id, so we mint a traq-keyed
 * row to anchor the connected account + onboarding. Idempotent and race-safe via
 * the unique `traq_id` constraint. (add-traq-only-payout-recipient)
 */
export async function getOrCreateUserByTraqId(db: Database, traqId: string): Promise<BillingUserRow> {
  await db
    .insert(schema.users)
    .values({ id: randomUUID(), traqId })
    .onDuplicateKeyUpdate({ set: { traqId } })

  const row = await getUserByTraqId(db, traqId)
  if (!row) {
    throw new Error('failed to get-or-create user by traq_id')
  }
  return row
}

/**
 * Race-safe compare-and-set of a person's `mail_hash`: only sets it when the
 * column is still NULL (a payout-only row gaining an isct identity). Mirrors
 * {@link linkTraqId}.
 *   - `'set'`      — this call filled the column.
 *   - `'exists'`   — the row already carries the SAME mail_hash (idempotent).
 *   - `'conflict'` — that mail_hash is owned by another row (unique violation), or
 *                    this row holds a DIFFERENT mail_hash. Caller must NOT merge.
 * (add-traq-only-payout-recipient)
 */
export async function setUserMailHash(
  db: Database,
  userId: string,
  mailHash: string,
): Promise<'set' | 'exists' | 'conflict'> {
  let result: unknown
  try {
    result = await db
      .update(schema.users)
      .set({ mailHash })
      .where(and(
        eq(schema.users.id, userId),
        isNull(schema.users.mailHash),
      ))
  }
  catch (err) {
    if (isDuplicateKeyError(err)) {
      return 'conflict'
    }
    throw err
  }

  const affected = (result as { affectedRows?: number })?.affectedRows ?? 0
  const claimed = Array.isArray(result)
    ? ((result[0] as { affectedRows?: number })?.affectedRows ?? 0)
    : affected
  if (claimed > 0) {
    return 'set'
  }

  const existing = await getUserById(db, userId)
  return existing?.mailHash === mailHash ? 'exists' : 'conflict'
}

/** How an email-verification resolved the person row (for logging/diagnostics). */
export type EmailVerifyLinkage = 'isct-only' | 'created' | 'linked' | 'merged' | 'already' | 'conflict'

/**
 * Resolve the person row for an isct email verification, fusing it with the
 * authenticated traQ identity (forward-auth header or traQ-OAuth session) when
 * present, so payouts to this traQ ID resolve without a membership payment.
 *
 * Cases (rowX = by traq_id, rowH = by mail_hash):
 *   - no traqId            → get-or-create by mail_hash (isct-only).
 *   - rowX & rowH same row → already fully linked.
 *   - rowX & rowH differ   → CONFLICT: two rows for one person; do NOT auto-merge
 *                            (FK move is risky). Resolve to the billing row (rowH).
 *   - rowX only (mail null)→ MERGE: set mail_hash onto the payout-only row.
 *   - rowX with other mail → CONFLICT: traq_id bound to a different mail; fall back
 *                            to the caller's own mail_hash row.
 *   - rowH / neither       → get-or-create by mail_hash, then link the traq_id.
 * Never fabricates a dual identity the DB disagrees with. (add-traq-only-payout-recipient)
 */
export async function resolveUserForEmailVerify(
  db: Database,
  input: { mailHash: string, traqId: string | null },
): Promise<{ userId: string, linkage: EmailVerifyLinkage }> {
  const { mailHash, traqId } = input

  if (!traqId) {
    const u = await getOrCreateUserByMailHash(db, mailHash)
    return { userId: u.id, linkage: 'isct-only' }
  }

  const [rowX, rowH] = await Promise.all([
    getUserByTraqId(db, traqId),
    getUserByMailHash(db, mailHash),
  ])

  if (rowX && rowH) {
    if (rowX.id === rowH.id) {
      return { userId: rowX.id, linkage: 'already' }
    }
    // Two separate rows for one person — refuse to auto-merge; prefer billing row.
    return { userId: rowH.id, linkage: 'conflict' }
  }

  if (rowX) {
    if (rowX.mailHash === mailHash) {
      return { userId: rowX.id, linkage: 'already' }
    }
    if (rowX.mailHash === null) {
      const r = await setUserMailHash(db, rowX.id, mailHash)
      return { userId: rowX.id, linkage: r === 'conflict' ? 'conflict' : 'merged' }
    }
    // traq_id is bound to a DIFFERENT mail_hash — don't link; use own isct row.
    const u = await getOrCreateUserByMailHash(db, mailHash)
    return { userId: u.id, linkage: 'conflict' }
  }

  // No row carries this traq_id: create-or-find by mail_hash, then link the traq.
  const created = rowH === null
  const u = await getOrCreateUserByMailHash(db, mailHash)
  const link = await linkTraqId(db, u.id, traqId)
  if (link === 'conflict') {
    return { userId: u.id, linkage: 'conflict' }
  }
  return { userId: u.id, linkage: created ? 'created' : 'linked' }
}
