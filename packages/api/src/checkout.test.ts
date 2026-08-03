import { call } from '@orpc/server'
import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'
import { stripeFixture, testContext } from './test-utils'

describe('checkout.listSessions', () => {
  it('フィルタを Stripe に写像し、allowlist のフィールドだけを返す', async () => {
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
                  id: 'cs_1',
                  status: 'complete',
                  amount_total: 2198,
                  amount_subtotal: 1998,
                  created: 1680000000,
                  customer: 'cus_1',
                  payment_intent: 'pi_1',
                  metadata: { traq_id: 'cs', internal: 'secret' },
                  // allowlist されない PII。出力に出てはいけない。
                  customer_email: 'secret@example.com',
                }),
              ],
            })
          },
        },
      },
    })

    const result = await call(
      appRouter.checkout.sessions.list,
      { customer: 'cus_1', payment_intent: 'pi_1', status: 'complete', limit: 3 },
      { context },
    )

    // customer / payment_intent は Stripe のキー名に写像する。
    expect(captured).toStrictEqual({
      customer: 'cus_1',
      payment_intent: 'pi_1',
      status: 'complete',
      limit: 3,
    })
    expect(result.has_more).toBe(true)
    // toStrictEqual で allowlist を厳密に検証: customer_email/internal は含まれない。
    expect(result.data[0]).toStrictEqual({
      id: 'cs_1',
      status: 'complete',
      amount_total: 2198,
      amount_subtotal: 1998,
      created: 1680000000,
      customer: 'cus_1',
      payment_intent: 'pi_1',
      metadata: { traq_id: 'cs' },
    })
  })
})
