import {
  createSession,
  exchangeCodeForToken,
  fetchTraqUserId,
  getUserByTraqId,
  isAccountant,
  safeEqual,
  sanitizeRedirect,
} from '@checkin/api'

/**
 * GET /login/callback — validate state, exchange the code, resolve the traQ ID,
 * then establish a **member** session for ANY successful traQ login. The env
 * allow-list only decides `isAdmin` (accountant) — it no longer gates login.
 * If the traQ ID is already linked to a user (`users.traq_id`), the resolved
 * userId is put on the session too (linked members skip re-confirmation).
 * (admin-authorization spec: §traQ OAuth による会計ログイン / §env 許可リストによる会計判定)
 */
export default defineEventHandler(async (event) => {
  const config = resolveAuthConfig()
  const query = getQuery(event)
  const cookies = getOAuthCookies(event)
  clearOAuthCookies(event)

  const code = typeof query.code === 'string' ? query.code : ''
  const state = typeof query.state === 'string' ? query.state : ''

  // state must match the value we stored before redirecting (CSRF for OAuth).
  if (!code || !state || !cookies.state || !cookies.verifier || !safeEqual(state, cookies.state)) {
    return sendRedirect(event, '/?login=error')
  }

  try {
    const redirectUri = `${config.appOrigin}/login/callback`
    const accessToken = await exchangeCodeForToken(config.traq, {
      code,
      codeVerifier: cookies.verifier,
      redirectUri,
    })
    const traqId = await fetchTraqUserId(config.traq, accessToken)
    const db = useDatabase()

    // Accountant权限 is a subset: granted only to allow-listed traQ IDs. Login
    // succeeds regardless (everyone becomes a member).
    const isAdmin = isAccountant(traqId, config.accountantTraqIds)
    // Already-linked member → resolve their user so the session carries both
    // identities without requiring a fresh isct confirmation.
    const linked = await getUserByTraqId(db, traqId)

    const token = await createSession(
      db,
      { traqId, isAdmin, userId: linked?.id ?? null },
      config.sessionTtlSec,
    )
    setSessionCookie(event, token, config.sessionTtlSec)
    return sendRedirect(event, sanitizeRedirect(cookies.redirect))
  }
  catch (error) {
    console.error('traQ OAuth callback failed:', error)
    return sendRedirect(event, '/?login=error')
  }
})
