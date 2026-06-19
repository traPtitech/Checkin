import type { H3Event } from 'h3'
import {
  type Context,
  createAuthHelpers,
  createMailer,
  createNotifier,
  createStripeClient,
  resolveSession,
  safeEqual,
} from '@checkin/api'

export const SESSION_COOKIE = '__Host-checkin_session'
export const CSRF_COOKIE = '__Host-checkin_csrf'
export const OAUTH_STATE_COOKIE = '__Host-checkin_oauth_state'
export const OAUTH_VERIFIER_COOKIE = '__Host-checkin_oauth_verifier'
export const OAUTH_REDIRECT_COOKIE = '__Host-checkin_oauth_redirect'

/** Base attributes satisfying the `__Host-` cookie prefix (Secure, Path=/, no Domain). */
const hostCookieBase = { secure: true, path: '/' as const, sameSite: 'lax' as const }

/** Set the server-side session cookie (HttpOnly). */
export function setSessionCookie(event: H3Event, token: string, ttlSec: number): void {
  setCookie(event, SESSION_COOKIE, token, { ...hostCookieBase, httpOnly: true, maxAge: ttlSec })
}

/** Clear the session cookie (logout). */
export function clearSessionCookie(event: H3Event): void {
  deleteCookie(event, SESSION_COOKIE, { ...hostCookieBase, httpOnly: true })
}

/** Issue a CSRF cookie (readable by JS for double-submit) and return the token. */
export function setCsrfCookie(event: H3Event, token: string, ttlSec: number): void {
  setCookie(event, CSRF_COOKIE, token, { ...hostCookieBase, httpOnly: false, maxAge: ttlSec })
}

const OAUTH_TEMP_TTL = 600

/** Persist short-lived OAuth flow state across the redirect to traQ and back. */
export function setOAuthCookies(
  event: H3Event,
  values: { state: string, verifier: string, redirect: string },
): void {
  const opts = { ...hostCookieBase, httpOnly: true, maxAge: OAUTH_TEMP_TTL }
  setCookie(event, OAUTH_STATE_COOKIE, values.state, opts)
  setCookie(event, OAUTH_VERIFIER_COOKIE, values.verifier, opts)
  setCookie(event, OAUTH_REDIRECT_COOKIE, values.redirect, opts)
}

export function getOAuthCookies(event: H3Event): {
  state: string | undefined
  verifier: string | undefined
  redirect: string | undefined
} {
  return {
    state: getCookie(event, OAUTH_STATE_COOKIE),
    verifier: getCookie(event, OAUTH_VERIFIER_COOKIE),
    redirect: getCookie(event, OAUTH_REDIRECT_COOKIE),
  }
}

export function clearOAuthCookies(event: H3Event): void {
  const opts = { ...hostCookieBase, httpOnly: true }
  deleteCookie(event, OAUTH_STATE_COOKIE, opts)
  deleteCookie(event, OAUTH_VERIFIER_COOKIE, opts)
  deleteCookie(event, OAUTH_REDIRECT_COOKIE, opts)
}

/** Compute double-submit CSRF validity from the cookie and `x-csrf-token` header. */
export function isCsrfValid(event: H3Event): boolean {
  const cookie = getCookie(event, CSRF_COOKIE)
  const header = getHeader(event, 'x-csrf-token')
  return !!cookie && !!header && safeEqual(cookie, header)
}

/**
 * Build the per-request oRPC Context: db handle, resolved auth + billing config,
 * mailer + accountant notifier, a lazy Stripe adapter (no SDK is instantiated
 * unless a billing procedure actually uses it, so non-billing requests work even
 * without a Stripe key), the session restored from the cookie, and the
 * CSRF-aware authorization helpers.
 */
export async function buildRequestContext(event: H3Event): Promise<Context> {
  const db = useDatabase()
  const config = resolveAuthConfig()
  const billing = resolveBillingConfig()
  const mailer = createMailer(config.mailer)
  const notifier = createNotifier()
  const stripe = createStripeClient(billing.stripeSecretKey)
  const session = await resolveSession(db, getCookie(event, SESSION_COOKIE))
  const helpers = createAuthHelpers(session, isCsrfValid(event))
  return { db, config, billing, mailer, notifier, stripe, session, ...helpers }
}
