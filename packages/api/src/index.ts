import type { appRouter } from './router'

export { appRouter } from './router'
export { pub, type Context } from './orpc'

/** Auth / identity domain utilities (used by the Nitro host to build context). */
export * from './auth'

/** Membership-collection domain (Stripe-independent: term/pricing/authorize + config). */
export * from './billing'

/** Stripe adapter layer (all Stripe SDK usage is isolated here). */
export * from './stripe'

/** Accountant notification abstraction (used by the payment webhook). */
export * from './notify'

/** Webhook idempotency ledger helpers. */
export * from './webhook'

/** Type of the application router — import this (type-only) on the client. */
export type AppRouter = typeof appRouter
