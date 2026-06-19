import { os } from '@orpc/server'
import type { Database } from '@checkin/db'
import type { AuthConfig } from './auth/config'
import type { Mailer } from './auth/mailer'
import type { SessionActor } from './auth/session'
import type { AuthHelpers } from './auth/context'
import type { BillingConfig } from './billing/config'
import type { StripeClient } from './stripe/client'
import type { Notifier } from './notify/notifier'

/**
 * Request context shared by every procedure. The Nitro handler builds this
 * per request: it injects the database handle, resolved auth + billing config,
 * the mailer + accountant notifier, a (lazy) Stripe adapter, the authenticated
 * session (from the session cookie), and the authorization helpers (CSRF-aware).
 */
export interface Context extends AuthHelpers {
  db: Database
  config: AuthConfig
  billing: BillingConfig
  mailer: Mailer
  notifier: Notifier
  /** Lazy Stripe adapter — only instantiates the SDK when a procedure uses it. */
  stripe: StripeClient
  /** The authenticated actor, or null when unauthenticated. */
  session: SessionActor | null
}

/** Base procedure builder — start all procedures from here. */
export const pub = os.$context<Context>()
