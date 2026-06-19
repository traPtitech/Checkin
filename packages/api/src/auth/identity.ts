import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { schema, type Database } from '@checkin/db'

export interface UserRow {
  id: string
  mailHash: string
}

/** A person row including its (nullable) Stripe Customer link — for billing. */
export interface BillingUserRow {
  id: string
  mailHash: string
  stripeCustomerId: string | null
}

/** Fetch a person row by id, including its Stripe Customer link, or null. */
export async function getUserById(db: Database, id: string): Promise<BillingUserRow | null> {
  const [row] = await db
    .select({
      id: schema.users.id,
      mailHash: schema.users.mailHash,
      stripeCustomerId: schema.users.stripeCustomerId,
    })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1)
  return row ?? null
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
