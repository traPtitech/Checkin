import { call } from '@orpc/server'
import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'
import { stripeFixture, testContext } from './test-utils'

/** prices リソースだけをスタブしたコンテキストを組む。 */
function makeContext(prices: unknown) {
  return testContext({ prices })
}

/** handler が読むフィールドだけ埋めた Price フィクスチャ。metadata 等は上書きできる。 */
function price(overrides: Partial<Stripe.Price>): Stripe.Price {
  return stripeFixture<Stripe.Price>(overrides)
}

describe('prices.list', () => {
  it('product を Stripe の product フィルタに変換して渡す', async () => {
    let captured: unknown
    const context = makeContext({
      list: (arg: unknown) => {
        captured = arg
        return Promise.resolve({ has_more: false, data: [] })
      },
    })

    await call(appRouter.prices.list, { product: 'prod_x' }, { context })

    expect(captured).toStrictEqual({ product: 'prod_x' })
  })

  it('product 未指定なら空フィルタで呼ぶ', async () => {
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

  it('limit と starting_after をカーソルとして Stripe に渡す', async () => {
    let captured: unknown
    const context = makeContext({
      list: (arg: unknown) => {
        captured = arg
        return Promise.resolve({ has_more: false, data: [] })
      },
    })

    await call(appRouter.prices.list, { limit: 20, starting_after: 'price_last' }, { context })

    expect(captured).toStrictEqual({ limit: 20, starting_after: 'price_last' })
  })

  it('product とページネーションを併せて渡す', async () => {
    let captured: unknown
    const context = makeContext({
      list: (arg: unknown) => {
        captured = arg
        return Promise.resolve({ has_more: false, data: [] })
      },
    })

    await call(
      appRouter.prices.list,
      { product: 'prod_x', limit: 20, starting_after: 'price_last' },
      { context },
    )

    expect(captured).toStrictEqual({ product: 'prod_x', limit: 20, starting_after: 'price_last' })
  })

  it('has_more を引き回し、透過するが metadata は出力しない', async () => {
    const context = makeContext({
      list: () =>
        Promise.resolve({
          has_more: true,
          data: [
            price({ id: 'price_a', metadata: { traq_id: 'alice', internal: 'secret' } }),
            price({ id: 'price_b', metadata: {} }),
          ],
        }),
    })

    const result = await call(appRouter.prices.list, {}, { context })

    expect(result.has_more).toBe(true)
    // 透過だが metadata は出力しない(traq_id は自前 DB 単一ソースのため)。
    expect(result.data[0]).toStrictEqual({ id: 'price_a' })
    expect(result.data[1]).toStrictEqual({ id: 'price_b' })
  })
})

describe('prices.retrieve', () => {
  it('透過するが metadata は出力しない', async () => {
    const context = makeContext({
      retrieve: () => Promise.resolve(price({ id: 'price_x', metadata: { traq_id: 'bob', internal: 'secret' } })),
    })

    const result = await call(appRouter.prices.retrieve, { id: 'price_x' }, { context })

    expect(result).toStrictEqual({ id: 'price_x' })
  })
})

describe('prices.update', () => {
  it('active を Stripe に渡し、結果に metadata を含めない', async () => {
    let capturedId: unknown
    let capturedParams: unknown
    const context = makeContext({
      update: (id: unknown, params: unknown) => {
        capturedId = id
        capturedParams = params
        return Promise.resolve(price({ id: 'price_x', metadata: { traq_id: 'carol', internal: 'secret' } }))
      },
    })

    const result = await call(appRouter.prices.update, { id: 'price_x', active: false }, { context })

    expect(capturedId).toBe('price_x')
    expect(capturedParams).toStrictEqual({ active: false })
    expect(result).toStrictEqual({ id: 'price_x' })
  })

  it('更新フィールドを1つも指定しなければ reject する', async () => {
    const context = makeContext({ update: () => Promise.resolve(price({})) })

    await expect(
      call(appRouter.prices.update, { id: 'price_x' }, { context }),
    ).rejects.toThrow()
  })
})
