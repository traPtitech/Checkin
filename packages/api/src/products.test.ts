import { call } from '@orpc/server'
import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'
import { stripeFixture, testContext } from './test-utils'

describe('products.list', () => {
  it('active フィルタとページネーションを Stripe に渡す', async () => {
    let captured: unknown
    const context = testContext({
      products: {
        list: (params: unknown) => {
          captured = params
          return Promise.resolve({ has_more: false, data: [] })
        },
      },
    })

    await call(appRouter.products.list, { active: true, limit: 5 }, { context })

    expect(captured).toStrictEqual({ active: true, limit: 5 })
  })
})

describe('products.update', () => {
  it('指定フィールドを Stripe に渡し、結果の metadata を traq_id だけに絞る', async () => {
    let capturedId: unknown
    let capturedParams: unknown
    const context = testContext({
      products: {
        update: (id: unknown, params: unknown) => {
          capturedId = id
          capturedParams = params
          return Promise.resolve(
            stripeFixture<Stripe.Product>({ metadata: { traq_id: 'prod', internal: 'secret' } }),
          )
        },
      },
    })

    const result = await call(
      appRouter.products.update,
      { id: 'prod_x', name: '新会費', description: null },
      { context },
    )

    expect(capturedId).toBe('prod_x')
    // active / metadata は未指定なので渡さない。description の null は透過する。
    expect(capturedParams).toStrictEqual({ name: '新会費', description: null })
    expect(result.metadata).toStrictEqual({ traq_id: 'prod' })
  })
})
