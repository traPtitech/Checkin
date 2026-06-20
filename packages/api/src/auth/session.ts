import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { schema, type Database } from '@checkin/db'
import { generateToken, sha256hex } from './crypto'

/**
 * The dual identity a session represents. A session can carry a traQ identity
 * (`traqId`, from traQ OAuth), an isct user identity (`userId`/`mailHash`, from
 * email confirmation), or both (a member who has also confirmed their isct
 * email). `isAdmin` is the accountant flag. Any field may be absent — the
 * principal is expressed by which fields are set, not by an actor enum.
 * (session spec: §セッションは利用者・会計のいずれかのアクターを表す)
 */
export interface SessionIdentity {
  /** Authenticated traQ ID, or null if not logged in via traQ. */
  traqId: string | null
  /** Accountant権限 (env allow-list). */
  isAdmin: boolean
  /** Linked/confirmed isct user (`users.id`), or null if no user is resolved. */
  userId: string | null
  /** The user's `mail_hash` (joined from `users` when `userId` is set), or null. */
  mailHash: string | null
}

/** What to store when creating a session. `mailHash` is NOT stored — it is joined from `users`. */
export interface NewSession {
  /** Authenticated traQ ID to attach, if any. */
  traqId?: string | null
  /** Whether the session is an accountant. Defaults to false. */
  isAdmin?: boolean
  /** Linked isct user id, if already resolved at creation time. */
  userId?: string | null
}

/**
 * Create a server-side session and return the opaque token to put in the cookie.
 * Only the token's hash is persisted, so a DB leak cannot reconstruct live cookies.
 * Stores `user_id`, `traq_id`, and `is_admin`; `mail_hash` is never stored (it is
 * resolved by joining `users` on `user_id` in {@link resolveSession}).
 */
export async function createSession(
  db: Database,
  identity: NewSession,
  ttlSec: number,
): Promise<string> {
  const token = generateToken()
  const expiresAt = new Date(Date.now() + ttlSec * 1000)
  await db.insert(schema.sessions).values({
    id: randomUUID(),
    idHash: sha256hex(token),
    userId: identity.userId ?? null,
    traqId: identity.traqId ?? null,
    isAdmin: identity.isAdmin ?? false,
    expiresAt,
  })
  return token
}

/**
 * Resolve a session token to its dual identity, or null if missing/expired.
 * Expired sessions are best-effort deleted. The left join on `users` supplies
 * `mailHash` whenever the session has a `user_id`. (session spec: §期限切れセッションは無効)
 */
export async function resolveSession(db: Database, token: string | undefined): Promise<SessionIdentity | null> {
  if (!token) {
    return null
  }
  const idHash = sha256hex(token)
  const [row] = await db
    .select({
      userId: schema.sessions.userId,
      traqId: schema.sessions.traqId,
      isAdmin: schema.sessions.isAdmin,
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

  return {
    traqId: row.traqId ?? null,
    isAdmin: row.isAdmin,
    // Only expose a userId when the joined `users` row actually exists (mailHash
    // present) — a dangling user_id (e.g. deleted user) must not look logged-in.
    userId: row.userId && row.mailHash ? row.userId : null,
    mailHash: row.mailHash ?? null,
  }
}

/**
 * Attach an isct user to an EXISTING session (keeping the same token/cookie).
 * Used when an isct email confirmation happens on a live traQ member session:
 * we link `user_id` onto that session rather than minting a new one, so the
 * member ends up with both identities on one session. Safe to call on an
 * unknown token (no-op). (session spec: §連結済みは両アイデンティティを持つ)
 */
export async function attachUserToSession(db: Database, token: string | undefined, userId: string): Promise<void> {
  if (!token) {
    return
  }
  await db
    .update(schema.sessions)
    .set({ userId })
    .where(eq(schema.sessions.idHash, sha256hex(token)))
}

/** Invalidate a session (logout). Safe to call with an unknown/expired token. */
export async function destroySession(db: Database, token: string | undefined): Promise<void> {
  if (!token) {
    return
  }
  await db.delete(schema.sessions).where(eq(schema.sessions.idHash, sha256hex(token)))
}
