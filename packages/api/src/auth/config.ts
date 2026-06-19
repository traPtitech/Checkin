/**
 * Auth configuration. Values originate from environment variables and are
 * resolved by the host (Nuxt/Nitro reads runtimeConfig). The domain layer only
 * depends on this typed shape, never on `process.env` or the framework.
 */
export interface TraqOAuthConfig {
  clientId: string
  clientSecret: string
  authorizeUrl: string
  tokenUrl: string
  userinfoUrl: string
  scope: string
  /** Field in the userinfo response that holds the traQ ID (username). */
  userIdField: string
}

export interface MailerConfig {
  driver: 'log' | 'sendgrid'
  from: string
  sendgridApiKey?: string
}

export interface AuthConfig {
  /** HMAC secret for mail_hash. Required; empty is a hard error at derive time. */
  mailHashSecret: string
  /** Allowed isct email domains, e.g. ['m.isct.ac.jp']. */
  allowedEmailDomains: string[]
  /** Absolute origin used to build links and validate same-site redirects. */
  appOrigin: string
  emailVerificationTtlSec: number
  sessionTtlSec: number
  /** traQ IDs (usernames) granted accountant (admin) access. */
  accountantTraqIds: string[]
  traq: TraqOAuthConfig
  mailer: MailerConfig
}

/** Whether an email's domain is in the allow-list (case-insensitive). */
export function isAllowedEmailDomain(email: string, domains: string[]): boolean {
  const at = email.lastIndexOf('@')
  if (at < 0) {
    return false
  }
  const domain = email.slice(at + 1).trim().toLowerCase()
  return domains.some(d => d.trim().toLowerCase() === domain)
}

/** Whether a traQ ID is in the accountant allow-list. */
export function isAccountant(traqId: string, allow: string[]): boolean {
  return allow.includes(traqId)
}
