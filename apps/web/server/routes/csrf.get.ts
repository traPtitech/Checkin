import { generateToken } from '@checkin/api'

/** GET /csrf — issue a double-submit CSRF token + `__Host-checkin_csrf` cookie. */
export default defineEventHandler((event) => {
  const config = resolveAuthConfig()
  const token = generateToken()
  setCsrfCookie(event, token, config.sessionTtlSec)
  return { csrfToken: token }
})
