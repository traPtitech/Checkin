/** Stripe Dashboard mode — drives the `/test/` path segment. */
export type StripeMode = 'test' | 'live'

/** The object kinds we can deep-link to in the Dashboard. */
export type DashboardKind = 'invoice' | 'checkout-session'

/**
 * Derive the Dashboard mode from the configured secret key (design D4): test
 * keys start with `sk_test_` / `rk_test_`; anything else is treated as live.
 * Pure function — takes the key string, never the Stripe SDK.
 */
export function modeFromSecretKey(secretKey: string): StripeMode {
  return secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_') ? 'test' : 'live'
}

/**
 * Build the Stripe Dashboard URL for an object (payment-listing spec:
 * §Dashboard URL の生成 / design D4):
 *   - invoice          → `…/{test/}invoices/{id}`
 *   - checkout session → `…/{test/}checkout/sessions/{id}`
 * test mode inserts the `/test/` segment; live omits it.
 */
export function buildDashboardUrl(mode: StripeMode, kind: DashboardKind, id: string): string {
  const base = 'https://dashboard.stripe.com'
  const modeSegment = mode === 'test' ? '/test' : ''
  const path = kind === 'invoice' ? `/invoices/${id}` : `/checkout/sessions/${id}`
  return `${base}${modeSegment}${path}`
}
