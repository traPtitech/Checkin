import {
  createSession,
  exchangeCodeForToken,
  fetchTraqUserId,
  isAccountant,
  safeEqual,
  sanitizeRedirect,
} from '@checkin/api'

/**
 * GET /login/callback — validate state, exchange the code, resolve the traQ ID,
 * gate on the accountant allow-list, then establish an admin session.
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

    if (!isAccountant(traqId, config.accountantTraqIds)) {
      return sendRedirect(event, '/?login=forbidden')
    }

    const token = await createSession(useDatabase(), { actor: 'admin', traqId }, config.sessionTtlSec)
    setSessionCookie(event, token, config.sessionTtlSec)
    return sendRedirect(event, sanitizeRedirect(cookies.redirect))
  }
  catch (error) {
    console.error('traQ OAuth callback failed:', error)
    return sendRedirect(event, '/?login=error')
  }
})
