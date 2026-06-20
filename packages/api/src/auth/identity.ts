import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { schema, type Database } from '@checkin/db'

export interface UserRow {
  id: string
  mailHash: string
}

/**
 * A person row including its (nullable) Stripe Customer link and Connect payout
 * fields — for billing and payouts. `traqId` is the linked authenticated traQ ID
 * (副キー) used to resolve Jomon payouts. (identity spec: §Stripe 参照・状態は保持してよい
 * / §traQ ID による本人解決と連結)
 */
export interface BillingUserRow {
  id: string
  mailHash: string
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
