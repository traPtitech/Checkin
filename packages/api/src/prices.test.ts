import { call } from '@orpc/server'
import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import type { Context } from './orpc'
import { appRouter } from './router'

/**
 * prices リソースだけをスタブしたコンテキストを組む。handler は has_more / data /
 * metadata しか触らないため、Stripe の厳密なメソッド型には合わせず unknown で受ける。
 */
function makeContext(prices: unknown) {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- prices リソースだけを供給する最小スタブ。handler は db に触れず、stripe も prices しか使わない
  return { db: {}, stripe: { prices } } as unknown as Context
}

/** handler が読むフィールドだけ埋めた Price フィクスチャ。metadata 等は上書きできる。 */
function price(overrides: Partial<Stripe.Price>): Stripe.Price {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Price 全体は再現せず、handler が参照するフィールドだけ供給する
  return {
    id: 'price_x',
    metadata: {},
    ...overrides,
  } as unknown as Stripe.Price
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
