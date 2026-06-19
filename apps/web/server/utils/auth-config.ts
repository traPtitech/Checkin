import type { AuthConfig } from '@checkin/api'

let cached: AuthConfig | undefined

function csv(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Resolve the typed AuthConfig from Nuxt runtimeConfig (env-backed). Cached per
 * server instance. The domain layer in @checkin/api only sees this typed shape.
 */
export function resolveAuthConfig(): AuthConfig {
  if (cached) {
    return cached
  }
  const rc = useRuntimeConfig()
  const domains = csv(rc.allowedEmailDomains)

  cached = {
    mailHashSecret: String(rc.mailHashSecret ?? ''),
    allowedEmailDomains: domains.length ? domains : ['m.isct.ac.jp'],
    appOrigin: String(rc.appOrigin || 'http://localhost:3000'),
    emailVerificationTtlSec: num(rc.emailVerificationTtlSec, 1800),
    sessionTtlSec: num(rc.sessionTtlSec, 2592000),
    accountantTraqIds: csv(rc.accountantTraqIds),
    traq: {
      clientId: String(rc.traqClientId ?? ''),
      clientSecret: String(rc.traqClientSecret ?? ''),
      authorizeUrl: String(rc.traqAuthorizeUrl ?? ''),
      tokenUrl: String(rc.traqTokenUrl ?? ''),
      userinfoUrl: String(rc.traqUserinfoUrl ?? ''),
      scope: String(rc.traqScope ?? ''),
      userIdField: String(rc.traqUserIdField || 'name'),
    },
    mailer: {
      driver: String(rc.mailerDriver || 'log') === 'sendgrid' ? 'sendgrid' : 'log',
      from: String(rc.mailFrom || 'noreply@localhost'),
      sendgridApiKey: String(rc.sendgridApiKey ?? '') || undefined,
    },
  }
  return cached
}
