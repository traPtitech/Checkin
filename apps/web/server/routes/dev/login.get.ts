import { createSession, deriveMailHash, getOrCreateUserByMailHash, linkTraqId, sanitizeRedirect } from '@checkin/api'

/**
 * GET /dev/login — DEV-ONLY session minting for local UI testing.
 *
 * **Hard-gated**: returns 404 unless `import.meta.dev` is true AND
 * `CHECKIN_DEV_LOGIN === '1'`. This route bypasses traQ OAuth and isct email
 * verification, so it must NEVER be reachable in production. `import.meta.dev`
 * is replaced with a literal `false` at build time, so in the production bundle
 * the guard short-circuits to a 404 regardless of any runtime env (more reliable
 * than a NODE_ENV check, which a node-server run may leave unset). The explicit
 * `CHECKIN_DEV_LOGIN` flag is the dev opt-in so it stays off unless asked for.
 *
 * Query:
 *   ?as=admin (default) — accountant session (isAdmin); drives /payments・/payouts
 *      =member          — traQ member only, no linked user; /membership prompts to link
 *      =user            — isct user only (hasUser); can issue invoices
 *      =both            — traQ member + linked user (isAdmin off)
 *   ?redirect=/path     — same-site landing page after login (default /)
 *
 * The dev user/member identities reuse fixed dev keys so repeated logins land on
 * the same person row (idempotent get-or-create).
 */
export default defineEventHandler(async (event) => {
  if (!import.meta.dev || process.env.CHECKIN_DEV_LOGIN !== '1') {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  const config = resolveAuthConfig()
  const db = useDatabase()
  const query = getQuery(event)
  const as = typeof query.as === 'string' ? query.as : 'admin'
  const redirect = sanitizeRedirect(typeof query.redirect === 'string' ? query.redirect : '/')

  let identity: { traqId: string | null, isAdmin: boolean, userId: string | null }

  if (as === 'admin') {
    identity = { traqId: 'devadmin', isAdmin: true, userId: null }
  }
  else if (as === 'member') {
    identity = { traqId: 'devmember', isAdmin: false, userId: null }
  }
  else if (as === 'user' || as === 'both') {
    // Mint (or reuse) an isct user row keyed by a dev email's mail_hash. The
    // email can be overridden (?email=) for a fresh customer/key space in tests.
    const email = typeof query.email === 'string' && query.email ? query.email : 'dev-user@m.isct.ac.jp'
    const mailHash = deriveMailHash(email, config.mailHashSecret)
    const user = await getOrCreateUserByMailHash(db, mailHash)
    const traqId = as === 'both' ? 'devmember' : null
    if (traqId) {
      // Best-effort link; 'exists'/'conflict' are fine for repeated dev logins.
      await linkTraqId(db, user.id, traqId)
    }
    identity = { traqId, isAdmin: false, userId: user.id }
  }
  else {
    throw createError({ statusCode: 400, statusMessage: 'invalid ?as (admin|member|user|both)' })
  }

  const token = await createSession(db, identity, config.sessionTtlSec)
  setSessionCookie(event, token, config.sessionTtlSec)
  return sendRedirect(event, redirect)
})
