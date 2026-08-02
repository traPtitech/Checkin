import { call } from '@orpc/server'
import type { Database } from '@checkin/db'
import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'

// health.check は DB にも Stripe にも一切アクセスしないため、これらのキャストは
// Context の型を満たすためだけのもの。
const context = {
  db: {} as unknown as Database,
  stripe: {} as unknown as Stripe,
}

describe('health.check', () => {
  it('reports ok with an ISO timestamp', async () => {
    const result = await call(appRouter.health.check, undefined, { context })

    expect(result.ok).toBe(true)
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp)
  })
})
