import { call } from '@orpc/server'
import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'
import { stripeFixture, testContext } from './test-utils'

/** prices リソースだけをスタブしたコンテキストを組む。 */
function makeContext(prices: unknown) {
  return testContext({ prices })
}

/** 公開対象フィールドを埋めた Price フィクスチャ。allowlist の除外検証用に余分な値も持たせられる。 */
function price(overrides: Partial<Stripe.Price>): Stripe.Price {
  return stripeFixture<Stripe.Price>({
    id: 'price_x',
    product: 'prod_1',
    active: true,
    currency: 'jpy',
    unit_amount: 4000,
    type: 'one_time',
    nickname: null,
    created: 1680000000,
    ...overrides,
  })
}

/** price フィクスチャに対応する、公開されるべき PriceView。 */
function priceViewOf(o: Record<string, unknown> = {}) {
  return {
    id: 'price_x',
    product: 'prod_1',
    active: true,
    currency: 'jpy',
    unit_amount: 4000,
    type: 'one_time',
    nickname: null,
    created: 1680000000,
    ...o,
  }
}

describe('prices.list', () => {
  it('フィルタとページネーションを Stripe に渡す', async () => {
    let captured: unknown
    const context = makeContext({
      list: (arg: unknown) => {
        captured = arg
        return Promise.resolve({ has_more: false, data: [] })
      },
    })

    await call(
      appRouter.prices.list,
      { product: 'prod_x', active: false, type: 'recurring', ending_before: 'price_first' },
      { context },
    )

    expect(captured).toStrictEqual({
      product: 'prod_x',
      active: false,
      type: 'recurring',
      ending_before: 'price_first',
    })
  })

  it('フィルタ未指定なら空パラメータで呼ぶ', async () => {
    let captured: unknown
    const context = makeContext({
      list: (arg: unknown) => {
        captured = arg
        return Promise.resolve({ has_more: false, data: [] })
      },
    })

    await call(appRouter.prices.list, {}, { context })

    expect(captured).toStrictEqual({})
  })

  it('has_more を引き回し、allowlist のフィールドだけを返す', async () => {
    const context = makeContext({
      list: () =>
        Promise.resolve({
          has_more: true,
          data: [
            price({
              id: 'price_a',
              // allowlist されない Stripe フィールド。出力に出てはいけない。
              livemode: true,
              metadata: { internal: 'secret' },
            }),
          ],
        }),
    })

    const result = await call(appRouter.prices.list, {}, { context })

    expect(result.has_more).toBe(true)
    expect(result.data[0]).toStrictEqual(priceViewOf({ id: 'price_a' }))
  })
})

describe('prices.retrieve', () => {
  it('公開フィールドだけの PriceView を返す', async () => {
    const context = makeContext({
      retrieve: () => Promise.resolve(price({ livemode: true, metadata: { internal: 'secret' } })),
    })

    const result = await call(appRouter.prices.retrieve, { id: 'price_x' }, { context })

    expect(result).toStrictEqual(priceViewOf())
  })

  it('product が展開オブジェクトでも ID に正規化する(PII を出さない)', async () => {
    const context = makeContext({
      retrieve: () =>
        Promise.resolve(
          price({
            product: stripeFixture<Stripe.Product>({
              id: 'prod_9',
              name: '秘密',
              metadata: { internal: 'secret' },
            }),
          }),
        ),
    })

    const result = await call(appRouter.prices.retrieve, { id: 'price_x' }, { context })

    expect(result).toStrictEqual(priceViewOf({ product: 'prod_9' }))
  })
})

describe('prices.update', () => {
  it('active を Stripe に渡し、PriceView を返す', async () => {
    let capturedId: unknown
    let capturedParams: unknown
    const context = makeContext({
      update: (id: unknown, params: unknown) => {
        capturedId = id
        capturedParams = params
        return Promise.resolve(price({ active: false }))
      },
    })

    const result = await call(appRouter.prices.update, { id: 'price_x', active: false }, { context })

    expect(capturedId).toBe('price_x')
    expect(capturedParams).toStrictEqual({ active: false })
    expect(result).toStrictEqual(priceViewOf({ active: false }))
  })

  it('active 未指定なら reject する(active は必須)', async () => {
    const context = makeContext({ update: () => Promise.resolve(price({})) })

    await expect(
      // @ts-expect-error active は必須のため意図的に省略している
      call(appRouter.prices.update, { id: 'price_x' }, { context }),
    ).rejects.toThrow()
  })
})
