import { consumeEmailVerification, createSession, getOrCreateUserByMailHash, sanitizeRedirect } from '@checkin/api'

/**
 * GET /verify-email/confirm — consume a magic-link token (single-use, expiry,
 * reuse-safe), get-or-create the person row, establish a user session, then
 * navigate to the stored same-site redirect.
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
  const sessionToken = await createSession(db, { actor: 'user', userId: user.id }, config.sessionTtlSec)
  setSessionCookie(event, sessionToken, config.sessionTtlSec)
  return sendRedirect(event, sanitizeRedirect(consumed.redirect))
})
