import type { appRouter } from './router'

export { appRouter } from './router'
export { pub, type Context } from './orpc'

/** Auth / identity domain utilities (used by the Nitro host to build context). */
export * from './auth'

/** Membership-collection domain (Stripe-independent: term/pricing/authorize + config). */
export * from './billing'

/** Payments-listing domain (Stripe-independent: row DTOs / Dashboard URL / pagination). */
export * from './payments'

/** Payout onboarding domain (Stripe-independent: readiness + state machine). */
export * from './payouts'

/** Stripe adapter layer (all Stripe SDK usage is isolated here). */
export * from './stripe'

/** Jomon integration (pull adapter: interface + stub / v1 / v2 + config + factory). */
export * from './jomon'

/** Accountant notification abstraction (used by the payment webhook). */
export * from './notify'

/** Webhook idempotency ledger helpers. */
export * from './webhook'

/** Membership issuance/payment ledger (half-period slots, duplicate-payment guard). */
export * from './ledger'

/** Type of the application router — import this (type-only) on the client. */
export type AppRouter = typeof appRouter
