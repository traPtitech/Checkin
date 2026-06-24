import {
  attachUserToSession,
  consumeEmailVerification,
  createSession,
  resolveSession,
  resolveUserForEmailVerify,
  sanitizeRedirect,
} from '@checkin/api'

/**
 * GET /verify-email/confirm — consume a magic-link token (single-use, expiry,
 * reuse-safe) and resolve the person row, fusing it with the authenticated traQ
 * identity (forward-auth header under NeoShowcase Soft, else the traQ-OAuth cookie
 * session) when present. `resolveUserForEmailVerify` handles every case — create,
 * link a member, MERGE a payout-only (traq_id, no mail_hash) row, or refuse to
 * auto-merge two separate rows — so a Jomon refund recipient who later verifies
 * their isct email keeps a single person row. (identity: §traQ ID 連結 / merge)
 *
 * Session: when a coherent traQ-member cookie session exists (legacy OAuth), we
 * attach `user_id` onto it in place; otherwise (forward-auth, or a conflict) we
 * mint a fresh user session. Then navigate to the stored same-site redirect.
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

  // The authenticated traQ identity: the forward-auth header (NeoShowcase Soft)
  // when enabled, else the traQ-OAuth cookie session.
  const sessionToken = getCookie(event, SESSION_COOKIE)
  const existing = await resolveSession(db, sessionToken)
  const traqId = (config.trustForwardAuth ? forwardedTraqId(event) : null) ?? existing?.traqId ?? null

  const { userId, linkage } = await resolveUserForEmailVerify(db, { mailHash: consumed.mailHash, traqId })
  if (linkage === 'conflict') {
    console.warn(`identity conflict on verify-email confirm: traqId=${traqId} userId=${userId}`)
  }

  // Attach onto an existing traQ-member cookie session in place when coherent;
  // otherwise (forward-auth has no such cookie, or a conflict) mint a fresh session.
  if (sessionToken && existing?.traqId && !existing.userId && linkage !== 'conflict') {
    await attachUserToSession(db, sessionToken, userId)
  }
  else {
    const newToken = await createSession(db, { userId }, config.sessionTtlSec)
    setSessionCookie(event, newToken, config.sessionTtlSec)
  }
  return sendRedirect(event, sanitizeRedirect(consumed.redirect))
})
