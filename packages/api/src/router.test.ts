import { call } from '@orpc/server'
import { describe, expect, it } from 'vitest'
import type { Context } from './orpc'
import { appRouter } from './router'

// health.check は DB にも Stripe にも一切アクセスしないため、空スタブで足りる。
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 未使用の依存を空オブジェクトで供給する意図的なテストスタブ
const context = { db: {}, stripe: {} } as unknown as Context

describe('health.check', () => {
  it('reports ok with an ISO timestamp', async () => {
    const result = await call(appRouter.health.check, undefined, { context })

    expect(result.ok).toBe(true)
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp)
  })
})
