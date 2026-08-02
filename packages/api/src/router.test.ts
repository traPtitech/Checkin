import { call } from '@orpc/server'
import type { Database } from '@checkin/db'
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'

// health.check は DB に一切アクセスしないため、このキャストは Context の型を満たすためだけのもの。
const context = { db: {} as unknown as Database }

describe('health.check', () => {
  it('reports ok with an ISO timestamp', async () => {
    const result = await call(appRouter.health.check, undefined, { context })

    expect(result.ok).toBe(true)
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp)
  })
})
