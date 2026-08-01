import { pub } from './orpc'

/**
 * Application router — implements `@checkin/api-contract`.
 *
 * Only a `health.check` probe exists for now; real procedures are added per
 * feature via OpenSpec change proposals. Keep procedures grouped by capability.
 */
export const appRouter = pub.router({
  health: {
    check: pub.health.check.handler(() => ({ ok: true, timestamp: new Date().toISOString() })),
  },
})
