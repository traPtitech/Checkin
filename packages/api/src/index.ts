import type { appRouter } from './router'

export { appRouter } from './router'
export { pub, type Context } from './orpc'

/** Type of the application router — import this (type-only) on the client. */
export type AppRouter = typeof appRouter
