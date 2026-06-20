import {
  attachUserToSession,
  consumeEmailVerification,
  createSession,
  getOrCreateUserByMailHash,
  linkTraqId,
  resolveSession,
  sanitizeRedirect,
} from '@checkin/api'

/**
 * GET /verify-email/confirm — consume a magic-link token (single-use, expiry,
 * reuse-safe) and get-or-create the person row.
 *
 * If the request already carries a traQ **member** session that has no user yet,
 * we first try to `linkTraqId` the authenticated traQ ID onto the confirmed user
 * row. Only when that link is coherent (`linked`/`exists`, i.e. the traq_id truly
 * belongs to this user) do we attach `user_id` onto the SAME session, so the
 * member ends up with both identities on one session. On `conflict` (the traq_id
 * is owned by a DIFFERENT user) we do NOT attach to the traQ session — that would
 * fabricate a dual identity the DB disagrees with. Instead we mint a FRESH plain
 * user session so the person is logged in as their own isct identity, and warn for
 * admin attention. Otherwise (no traQ session) we mint a plain user session as
 * before. Then navigate to the stored same-site redirect.
 * (session spec: §連結済みは両アイデンティティを持つ)
 */
export default defineEventHandler(async (event) => {
  const config = resolveAuthConfig()
  const query = getQuery(event)
  const token = typeof query.token === 'string' ? query.token : ''
  if (!token) {
    return sendRedirect(event, '/?verify=invalid')
  }

  const db = useDatabase()
  const consumed = await consumeEmailVerification(db, token)
  if (!consumed) {
    return sendRedirect(event, '/?verify=invalid')
  }

  const user = await getOrCreateUserByMailHash(db, consumed.mailHash)

  // An existing traQ member session without a linked user → connect them in place.
  const sessionToken = getCookie(event, SESSION_COOKIE)
  const existing = await resolveSession(db, sessionToken)
  if (sessionToken && existing?.traqId && !existing.userId) {
    // Link BEFORE attaching: only fuse the two identities onto the live traQ
    // session when the traq_id legitimately belongs to this user. A `conflict`
    // (the traq_id is owned by someone else) must NOT be attached, or the session
    // would carry a traQ linkage the DB attributes to a different person.
    const result = await linkTraqId(db, user.id, existing.traqId)
    if (result === 'conflict') {
      console.warn(`linkTraqId conflict on verify-email confirm: traqId=${existing.traqId} userId=${user.id}`)
      // Don't fabricate a dual identity. Mint a fresh plain user session so the
      // person is logged in as their own isct identity (no false traQ linkage).
      const conflictToken = await createSession(db, { userId: user.id }, config.sessionTtlSec)
      setSessionCookie(event, conflictToken, config.sessionTtlSec)
      return sendRedirect(event, sanitizeRedirect(consumed.redirect))
    }
    // Coherent linkage (linked/exists) → attach the user onto the SAME session so
    // it carries both identities. Same cookie/token — no need to reset it.
    await attachUserToSession(db, sessionToken, user.id)
    return sendRedirect(event, sanitizeRedirect(consumed.redirect))
  }

  // No traQ session (isct-only): establish a fresh user session as before.
  const newToken = await createSession(db, { userId: user.id }, config.sessionTtlSec)
  setSessionCookie(event, newToken, config.sessionTtlSec)
  return sendRedirect(event, sanitizeRedirect(consumed.redirect))
})
