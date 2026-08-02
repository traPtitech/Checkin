import { call } from '@orpc/server'
import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'
import { stripeFixture, testContext } from './test-utils'

describe('checkout.listSessions', () => {
  it('フィルタとページネーションを Stripe に写像し、metadata を traq_id だけに絞る', async () => {
    let captured: unknown
    const context = testContext({
      checkout: {
        sessions: {
          list: (params: unknown) => {
            captured = params
            return Promise.resolve({
              has_more: true,
              data: [
                stripeFixture<Stripe.Checkout.Session>({
                  metadata: { traq_id: 'cs', internal: 'secret' },
                }),
              ],
            })
          },
        },
      },
    })

    const result = await call(
      appRouter.checkout.listSessions,
      { customer_id: 'cus_1', payment_intent_id: 'pi_1', status: 'complete', limit: 3 },
      { context },
    )

    // customer_id / payment_intent_id は Stripe のキー名に写像する。
    expect(captured).toStrictEqual({
      customer: 'cus_1',
      payment_intent: 'pi_1',
      status: 'complete',
      limit: 3,
    })
    expect(result.has_more).toBe(true)
    expect(result.data[0]?.metadata).toStrictEqual({ traq_id: 'cs' })
  })
})
