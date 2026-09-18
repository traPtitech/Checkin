import type { BillingConfig } from '@checkin/api'
import { positiveNumberOr } from './config-value'

let cached: BillingConfig | undefined

// Every value read below comes from `runtimeConfig`, which Nuxt types as `string`
// because each entry declares a string default in `nuxt.config.ts`. They are used
// as-is: a `String()` wrapper or a `?? ''` fallback would be dead code.
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
      shinkiZenki: rc.priceShinkiZenki,
      shinkiKouki: rc.priceShinkiKouki,
      keizokuStandard: rc.priceKeizokuStandard,
      keizokuSpecial: rc.priceKeizokuSpecial,
    },
    stripeSecretKey: rc.stripeSecretKey,
    stripeWebhookSecret: rc.stripeWebhookSecret,
    connectWebhookSecret: rc.stripeConnectWebhookSecret,
    invoiceDaysUntilDue: positiveNumberOr(rc.invoiceDaysUntilDue, 7),
  }
  return cached
}
