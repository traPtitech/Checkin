import type { BillingConfig } from '@checkin/api'

let cached: BillingConfig | undefined

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Resolve the typed BillingConfig from Nuxt runtimeConfig (env-backed). Cached
 * per server instance. The domain layer in @checkin/api only sees this typed
 * shape; Stripe keys may be empty until billing is configured (the Stripe
 * adapter is lazy, so non-billing requests are unaffected).
 */
export function resolveBillingConfig(): BillingConfig {
  if (cached) {
    return cached
  }
  const rc = useRuntimeConfig()

  cached = {
    prices: {
      shinkiZenki: String(rc.priceShinkiZenki ?? ''),
      shinkiKouki: String(rc.priceShinkiKouki ?? ''),
      keizokuStandard: String(rc.priceKeizokuStandard ?? ''),
      keizokuSpecial: String(rc.priceKeizokuSpecial ?? ''),
    },
    stripeSecretKey: String(rc.stripeSecretKey ?? ''),
    stripeWebhookSecret: String(rc.stripeWebhookSecret ?? ''),
    connectWebhookSecret: String(rc.stripeConnectWebhookSecret ?? ''),
    invoiceDaysUntilDue: num(rc.invoiceDaysUntilDue, 7),
  }
  return cached
}
