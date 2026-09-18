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

/**
 * SMTP relay settings for the production mailer. Provider-neutral: SendGrid's
 * relay, for one, is host `smtp.sendgrid.net` with the literal string `apikey`
 * as the user name and an API key as the password (SendGrid docs, Integrating
 * with the SMTP API), so a change of provider changes these values and nothing
 * else.
 */
export interface SmtpConfig {
  host: string
  port: number
  /** True: TLS from the start of the connection. False: STARTTLS upgrades it. */
  secure: boolean
  user: string
  pass: string
}

export interface MailerConfig {
  driver: 'log' | 'smtp'
  from: string
  /** Read by the `smtp` driver only; the `log` driver never looks at it. */
  smtp?: SmtpConfig
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
  /**
   * Trust the reverse proxy's `X-Forwarded-User` header as the authenticated
   * traQ identity (NeoShowcase "Soft" member-auth). When true, the traQ identity
   * comes from the proxy rather than our own traQ OAuth. Enable ONLY where the
   * app is reachable solely via the trusted proxy, which overwrites/strips any
   * client-supplied value — otherwise the header is spoofable.
   */
  trustForwardAuth: boolean
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
