import { destroySession } from '@checkin/api'

/** POST /logout — destroy the current session and clear the cookie. */
export default defineEventHandler(async (event) => {
  if (!isCsrfValid(event)) {
    throw createError({ statusCode: 403, statusMessage: 'CSRF token missing or invalid' })
  }
  await destroySession(useDatabase(), getCookie(event, SESSION_COOKIE))
  clearSessionCookie(event)

  // Under NeoShowcase "Soft" forward-auth the traQ identity comes from the
  // proxy's X-Forwarded-User, NOT our session — so clearing the session alone
  // leaves the user logged in (the header re-asserts the identity on the next
  // request). Tell the client to also drop the platform forward-auth state via
  // the proxy's logout endpoint. (deploy: NeoShowcase Soft auth)
  if (resolveAuthConfig().trustForwardAuth) {
    return { ok: true, redirect: '/_oauth/logout?redirect=/' }
  }
  return { ok: true }
})
