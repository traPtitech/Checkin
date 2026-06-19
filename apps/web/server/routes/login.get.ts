import { buildAuthorizeUrl, generatePkce, generateToken, sanitizeRedirect } from '@checkin/api'

/** GET /login — start traQ OAuth (authorization code + PKCE). Preserves `redirect`. */
export default defineEventHandler((event) => {
  const config = resolveAuthConfig()
  const query = getQuery(event)
  const redirect = sanitizeRedirect(typeof query.redirect === 'string' ? query.redirect : undefined)

  const state = generateToken(16)
  const { verifier, challenge } = generatePkce()
  setOAuthCookies(event, { state, verifier, redirect })

  const redirectUri = `${config.appOrigin}/login/callback`
  const authorizeUrl = buildAuthorizeUrl(config.traq, {
    state,
    codeChallenge: challenge,
    redirectUri,
  })
  return sendRedirect(event, authorizeUrl)
})
