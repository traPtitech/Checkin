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
  it('product_id を Stripe の product フィルタに変換して渡す', async () => {
    let captured: unknown
    const context = makeContext({
      list: (arg: unknown) => {
        captured = arg
        return Promise.resolve({ has_more: false, data: [] })
      },
    })

    await call(appRouter.prices.list, { product_id: 'prod_x' }, { context })

    expect(captured).toStrictEqual({ product: 'prod_x' })
  })

  it('product_id 未指定なら空フィルタで呼ぶ', async () => {
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

  it('product_id とページネーションを併せて渡す', async () => {
    let captured: unknown
    const context = makeContext({
      list: (arg: unknown) => {
        captured = arg
        return Promise.resolve({ has_more: false, data: [] })
      },
    })

    await call(
      appRouter.prices.list,
      { product_id: 'prod_x', limit: 20, starting_after: 'price_last' },
      { context },
    )

    expect(captured).toStrictEqual({ product: 'prod_x', limit: 20, starting_after: 'price_last' })
  })

  it('has_more を引き回し、metadata を traq_id だけに絞る', async () => {
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
    // internal は落ち、traq_id だけが残る(toStrictEqual で余計なキーの不在も検証)
    expect(result.data[0]?.metadata).toStrictEqual({ traq_id: 'alice' })
    // traq_id が無ければ空になる(他キーも残らない)
    expect(result.data[1]?.metadata).toStrictEqual({})
  })
})

describe('prices.retrieve', () => {
  it('metadata を traq_id だけに絞り、内部キーを漏らさない', async () => {
    const context = makeContext({
      retrieve: () => Promise.resolve(price({ metadata: { traq_id: 'bob', internal: 'secret' } })),
    })

    const result = await call(appRouter.prices.retrieve, { id: 'price_x' }, { context })

    expect(result.metadata).toStrictEqual({ traq_id: 'bob' })
  })
})

describe('prices.update', () => {
  it('active と metadata を Stripe に渡し、結果の metadata を traq_id だけに絞る', async () => {
    let capturedId: unknown
    let capturedParams: unknown
    const context = makeContext({
      update: (id: unknown, params: unknown) => {
        capturedId = id
        capturedParams = params
        return Promise.resolve(price({ metadata: { traq_id: 'carol', internal: 'secret' } }))
      },
    })

    const result = await call(
      appRouter.prices.update,
      { id: 'price_x', active: false, metadata: { traq_id: 'carol' } },
      { context },
    )

    expect(capturedId).toBe('price_x')
    expect(capturedParams).toStrictEqual({ active: false, metadata: { traq_id: 'carol' } })
    expect(result.metadata).toStrictEqual({ traq_id: 'carol' })
  })

  it('更新フィールドを1つも指定しなければ reject する', async () => {
    const context = makeContext({ update: () => Promise.resolve(price({})) })

    await expect(
      call(appRouter.prices.update, { id: 'price_x' }, { context }),
    ).rejects.toThrow()
  })
})
