import type { JomonConfig } from '@checkin/api'

let cached: JomonConfig | undefined

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
    baseUrl: String(rc.jomonApiBaseUrl ?? ''),
    token: String(rc.jomonApiToken ?? ''),
    payoutCurrency: String(rc.payoutCurrency ?? 'jpy'),
  }
  return cached
}
