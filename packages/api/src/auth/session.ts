import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { schema, type Database } from '@checkin/db'
import { generateToken, sha256hex } from './crypto'

/** The authenticated principal a session represents. Exactly one actor kind. */
export type SessionActor
  = | { actor: 'user', userId: string, mailHash: string }
    | { actor: 'admin', traqId: string }

/** What to store when creating a session. */
export type NewSessionActor
  = | { actor: 'user', userId: string }
    | { actor: 'admin', traqId: string }

/**
 * Create a server-side session and return the opaque token to put in the cookie.
 * Only the token's hash is persisted, so a DB leak cannot reconstruct live cookies.
 */
export async function createSession(
  db: Database,
  actor: NewSessionActor,
  ttlSec: number,
): Promise<string> {
  const token = generateToken()
  const expiresAt = new Date(Date.now() + ttlSec * 1000)
  await db.insert(schema.sessions).values({
    id: randomUUID(),
    idHash: sha256hex(token),
    actorType: actor.actor,
    userId: actor.actor === 'user' ? actor.userId : null,
    traqId: actor.actor === 'admin' ? actor.traqId : null,
    expiresAt,
  })
  return token
}

/**
 * Resolve a session token to its actor, or null if missing/expired. Expired
 * sessions are best-effort deleted. (session spec: §期限切れセッションは無効)
 */
export async function resolveSession(db: Database, token: string | undefined): Promise<SessionActor | null> {
  if (!token) {
    return null
  }
  const idHash = sha256hex(token)
  const [row] = await db
    .select({
      actorType: schema.sessions.actorType,
      userId: schema.sessions.userId,
      traqId: schema.sessions.traqId,
      expiresAt: schema.sessions.expiresAt,
      mailHash: schema.users.mailHash,
    })
    .from(schema.sessions)
    .leftJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.idHash, idHash))
    .limit(1)

  if (!row) {
    return null
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(schema.sessions).where(eq(schema.sessions.idHash, idHash))
    return null
  }

  if (row.actorType === 'admin' && row.traqId) {
    return { actor: 'admin', traqId: row.traqId }
  }
  if (row.actorType === 'user' && row.userId && row.mailHash) {
    return { actor: 'user', userId: row.userId, mailHash: row.mailHash }
  }
  return null
}

/** Invalidate a session (logout). Safe to call with an unknown/expired token. */
export async function destroySession(db: Database, token: string | undefined): Promise<void> {
  if (!token) {
    return
  }
  await db.delete(schema.sessions).where(eq(schema.sessions.idHash, sha256hex(token)))
}
