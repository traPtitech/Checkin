import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { schema, type Database } from '@checkin/db'
import { generateToken, sha256hex } from './crypto'

/**
 * Issue a single-use, time-limited magic-link token for a `mail_hash` and
 * return the raw token (to embed in the emailed link). Only the hash is stored.
 * (email-verification spec: §単回・期限付きマジックリンクの発行)
 */
export async function createEmailVerification(
  db: Database,
  params: { mailHash: string, redirect: string | null, ttlSec: number },
): Promise<string> {
  const token = generateToken()
  await db.insert(schema.emailVerifications).values({
    id: randomUUID(),
    tokenHash: sha256hex(token),
    mailHash: params.mailHash,
    redirect: params.redirect,
    expiresAt: new Date(Date.now() + params.ttlSec * 1000),
  })
  return token
}

export interface ConsumedVerification {
  mailHash: string
  redirect: string | null
}

/**
 * Consume a magic-link token: valid, unexpired and unused tokens are marked
 * consumed and their `mail_hash`/`redirect` returned. Invalid, expired or
 * already-consumed tokens return null and establish nothing.
 * (email-verification spec: §有効なトークンの消費 / §無効・期限切れ・再利用トークンの拒否)
 */
export async function consumeEmailVerification(
  db: Database,
  token: string,
): Promise<ConsumedVerification | null> {
  const tokenHash = sha256hex(token)
  const now = new Date()

  // Atomically claim the token: only succeeds if currently unconsumed.
  const result = await db
    .update(schema.emailVerifications)
    .set({ consumedAt: now })
    .where(and(
      eq(schema.emailVerifications.tokenHash, tokenHash),
      isNull(schema.emailVerifications.consumedAt),
    ))

  // mysql2 returns affectedRows; if nothing was claimed it was missing or reused.
  const affected = (result as unknown as { affectedRows?: number })?.affectedRows ?? 0
  const claimed = Array.isArray(result)
    ? ((result[0] as { affectedRows?: number })?.affectedRows ?? 0)
    : affected
  if (!claimed) {
    return null
  }

  const [row] = await db
    .select({
      mailHash: schema.emailVerifications.mailHash,
      redirect: schema.emailVerifications.redirect,
      expiresAt: schema.emailVerifications.expiresAt,
    })
    .from(schema.emailVerifications)
    .where(eq(schema.emailVerifications.tokenHash, tokenHash))
    .limit(1)

  if (!row) {
    return null
  }
  // Expired tokens: we claimed it (so it can't be reused) but reject the login.
  if (row.expiresAt.getTime() <= now.getTime()) {
    return null
  }
  return { mailHash: row.mailHash, redirect: row.redirect }
}
