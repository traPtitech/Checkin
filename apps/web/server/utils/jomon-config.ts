import type { JomonConfig } from '@checkin/api'

let cached: JomonConfig | undefined

// Every value read below comes from `runtimeConfig`, which Nuxt types as `string`
// because each entry declares a string default in `nuxt.config.ts`. They are used
// as-is: a `String()` wrapper or a `?? ''` fallback would be dead code.

/** Coerce an env value to a known Jomon driver, defaulting to `stub`. */
function version(value: unknown): JomonConfig['version'] {
  return value === 'v1' || value === 'v2' ? value : 'stub'
}

/**
 * Resolve the typed JomonConfig from Nuxt runtimeConfig (env-backed). Cached per
 * server instance. The domain in @checkin/api only sees this typed shape; live
 * driver creds (base URL / token) may be empty in `stub` mode (the default), so
 * non-payout dev works without Jomon configured.
 */
export function resolveJomonConfig(): JomonConfig {
  if (cached) {
    return cached
  }
  const rc = useRuntimeConfig()

  cached = {
    version: version(rc.jomonApiVersion),
    baseUrl: rc.jomonApiBaseUrl,
    token: rc.jomonApiToken,
    payoutCurrency: rc.payoutCurrency,
  }
  return cached
}
