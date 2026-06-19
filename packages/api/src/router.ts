import { pub } from './orpc'

/**
 * Application router.
 *
 * Only a `health.check` probe exists for now; real procedures are added per
 * feature via OpenSpec change proposals. Keep procedures grouped by capability.
 */
export const appRouter = {
  health: {
    check: pub.handler(() => ({ ok: true, timestamp: new Date().toISOString() })),
  },
}
