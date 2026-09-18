import type { AuthConfig } from '@checkin/api'

let cached: AuthConfig | undefined

// Every value read here comes from `runtimeConfig`, which Nuxt types as `string`
// because each entry declares a string default in `nuxt.config.ts`. The helpers
// and the reads below therefore take the value as-is: a `String()` wrapper or a
// `?? ''` fallback would be dead code.
function csv(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function num(value: string, fallback: number): number {
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
    mailHashSecret: rc.mailHashSecret,
    allowedEmailDomains: domains.length ? domains : ['m.isct.ac.jp'],
    appOrigin: rc.appOrigin || 'http://localhost:3000',
    emailVerificationTtlSec: num(rc.emailVerificationTtlSec, 1800),
    sessionTtlSec: num(rc.sessionTtlSec, 2592000),
    accountantTraqIds: csv(rc.accountantTraqIds),
    trustForwardAuth: rc.trustForwardAuth === '1',
    traq: {
      clientId: rc.traqClientId,
      clientSecret: rc.traqClientSecret,
      authorizeUrl: rc.traqAuthorizeUrl,
      tokenUrl: rc.traqTokenUrl,
      userinfoUrl: rc.traqUserinfoUrl,
      scope: rc.traqScope,
      userIdField: rc.traqUserIdField || 'name',
    },
    mailer: {
      driver: rc.mailerDriver === 'smtp' ? 'smtp' : 'log',
      from: rc.mailFrom || 'noreply@localhost',
      smtp: {
        host: rc.smtpHost,
        // 587 is the port for a connection that STARTTLS upgrades; 465 is the
        // one for a connection that is TLS from the start, and needs SMTP_SECURE.
        port: num(rc.smtpPort, 587),
        secure: rc.smtpSecure === '1',
        user: rc.smtpUser,
        pass: rc.smtpPassword,
      },
    },
  }
  return cached
}
