import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, schema, type Database } from '@checkin/db'
import { getUserByTraqId, linkTraqId } from './identity'
import { attachUserToSession, createSession, destroySession, resolveSession } from './session'

/**
 * DB-backed tests for the traQ-ID linking helpers and dual-identity session
 * resolution (add-traq-member-auth). They run against the MariaDB pointed at by
 * DATABASE_URL; if unreachable they self-skip so `pnpm test` stays green without
 * infrastructure. No live traQ/Stripe calls are made. (tasks 6.1)
 */

let db: Database
let available = false

beforeAll(async () => {
  try {
    db = createDatabase(process.env.DATABASE_URL ?? 'mysql://checkin:password@localhost:3306/checkin')
    await db.select({ id: schema.users.id }).from(schema.users).limit(1)
    available = true
  }
  catch {
    available = false
  }
})

/** Unique suffix so repeated runs don't collide on traq_id / mail_hash. */
const tag = randomUUID().slice(0, 8)
const userIds: string[] = []

afterAll(async () => {
  if (!available) {
    return
  }
  for (const id of userIds) {
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, id))
    await db.delete(schema.users).where(eq(schema.users.id, id))
  }
})

/** Insert a bare user row with a unique mail_hash; returns its id. */
async function makeUser(): Promise<string> {
  const id = randomUUID()
  const mailHash = `hash_${tag}_${id.slice(0, 8)}`
  await db.insert(schema.users).values({ id, mailHash })
  userIds.push(id)
  return id
}

describe('identity: linkTraqId + getUserByTraqId', () => {
  it('links a free traq_id, then resolves the person by it', async () => {
    if (!available) {
      return
    }
    const userId = await makeUser()
    const traqId = `traq_${tag}_${randomUUID().slice(0, 6)}`

    expect(await linkTraqId(db, userId, traqId)).toBe('linked')

    const resolved = await getUserByTraqId(db, traqId)
    expect(resolved?.id).toBe(userId)
    expect(resolved?.traqId).toBe(traqId)
  })

  it('returns "exists" when the SAME traq_id is re-linked (idempotent, no overwrite)', async () => {
    if (!available) {
      return
    }
    const userId = await makeUser()
    const traqId = `traq_${tag}_${randomUUID().slice(0, 6)}`

    expect(await linkTraqId(db, userId, traqId)).toBe('linked')
    expect(await linkTraqId(db, userId, traqId)).toBe('exists')
  })

  it('returns "conflict" when another person already owns that traq_id (unique)', async () => {
    if (!available) {
      return
    }
    const owner = await makeUser()
    const other = await makeUser()
    const traqId = `traq_${tag}_${randomUUID().slice(0, 6)}`

    expect(await linkTraqId(db, owner, traqId)).toBe('linked')
    // Another user tries to claim the same traq_id → unique violation.
    expect(await linkTraqId(db, other, traqId)).toBe('conflict')
    // The owner is unchanged.
    expect((await getUserByTraqId(db, traqId))?.id).toBe(owner)
  })

  it('returns "conflict" when the row already holds a DIFFERENT traq_id (no overwrite)', async () => {
    if (!available) {
      return
    }
    const userId = await makeUser()
    const first = `traq_${tag}_${randomUUID().slice(0, 6)}`
    const second = `traq_${tag}_${randomUUID().slice(0, 6)}`

    expect(await linkTraqId(db, userId, first)).toBe('linked')
    // Compare-and-set finds no NULL row → conflict; the first traq_id stays.
    expect(await linkTraqId(db, userId, second)).toBe('conflict')
    expect((await getUserByTraqId(db, first))?.id).toBe(userId)
    expect(await getUserByTraqId(db, second)).toBeNull()
  })

  it('getUserByTraqId returns null for an unlinked traq_id', async () => {
    if (!available) {
      return
    }
    expect(await getUserByTraqId(db, `nobody_${tag}_${randomUUID()}`)).toBeNull()
  })
})

describe('session: dual-identity resolution', () => {
  it('resolves a member-only session (traqId, no userId/mailHash)', async () => {
    if (!available) {
      return
    }
    const traqId = `traq_${tag}_${randomUUID().slice(0, 6)}`
    const token = await createSession(db, { traqId, isAdmin: true }, 3600)

    const session = await resolveSession(db, token)
    expect(session).toEqual({ traqId, isAdmin: true, userId: null, mailHash: null })

    await destroySession(db, token)
    expect(await resolveSession(db, token)).toBeNull()
  })

  it('resolves a user-only session with mailHash joined from users', async () => {
    if (!available) {
      return
    }
    const userId = await makeUser()
    const [row] = await db
      .select({ mailHash: schema.users.mailHash })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)
    const token = await createSession(db, { userId }, 3600)

    const session = await resolveSession(db, token)
    expect(session).toEqual({ traqId: null, isAdmin: false, userId, mailHash: row!.mailHash })
    await destroySession(db, token)
  })

  it('attachUserToSession upgrades a member session to carry both identities', async () => {
    if (!available) {
      return
    }
    const userId = await makeUser()
    const traqId = `traq_${tag}_${randomUUID().slice(0, 6)}`
    const token = await createSession(db, { traqId, isAdmin: false }, 3600)

    // Before: member only.
    expect((await resolveSession(db, token))?.userId).toBeNull()

    await attachUserToSession(db, token, userId)
    const session = await resolveSession(db, token)
    expect(session?.traqId).toBe(traqId)
    expect(session?.userId).toBe(userId)
    expect(session?.mailHash).not.toBeNull()
    await destroySession(db, token)
  })

  it('returns null for an unknown token', async () => {
    if (!available) {
      return
    }
    expect(await resolveSession(db, 'not-a-real-token')).toBeNull()
    expect(await resolveSession(db, undefined)).toBeNull()
  })
})
