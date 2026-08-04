import { call } from '@orpc/server'
import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'
import { stripeFixture, testContext } from './test-utils'

/** 公開対象フィールドを埋めた Product フィクスチャ。 */
function product(overrides: Partial<Stripe.Product>): Stripe.Product {
  return stripeFixture<Stripe.Product>({
    id: 'prod_x',
    active: true,
    name: '部費',
    description: null,
    default_price: 'price_1',
    created: 1680000000,
    ...overrides,
  })
}

function productViewOf(o: Record<string, unknown> = {}) {
  return {
    id: 'prod_x',
    active: true,
    name: '部費',
    description: null,
    default_price: 'price_1',
    created: 1680000000,
    ...o,
  }
}

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

  it('allowlist のフィールドだけを返す', async () => {
    const context = testContext({
      products: {
        list: () =>
          Promise.resolve({
            has_more: false,
            data: [
              product({
                id: 'prod_a',
                // allowlist されない Stripe フィールド。出力に出てはいけない。
                livemode: true,
                metadata: { internal: 'secret' },
              }),
            ],
          }),
      },
    })

    const result = await call(appRouter.products.list, {}, { context })

    expect(result.data[0]).toStrictEqual(productViewOf({ id: 'prod_a' }))
    // toListResponse 経由の一覧レスポンス(has_more:false なら next_cursor:null)に配線されていることを確認。
    expect(result.next_cursor).toBeNull()
  })

  it('default_price が展開オブジェクト・未設定でも ID または null に正規化する', async () => {
    const context = testContext({
      products: {
        list: () =>
          Promise.resolve({
            has_more: false,
            data: [
              product({ id: 'prod_a', default_price: stripeFixture<Stripe.Price>({ id: 'price_9' }) }),
              product({ id: 'prod_b', default_price: undefined }),
            ],
          }),
      },
    })

    const result = await call(appRouter.products.list, {}, { context })

    expect(result.data[0]?.default_price).toBe('price_9')
    expect(result.data[1]?.default_price).toBeNull()
  })
})

describe('products.update', () => {
  it('指定フィールドを Stripe に渡し、ProductView を返す', async () => {
    let capturedId: unknown
    let capturedParams: unknown
    const context = testContext({
      products: {
        update: (id: unknown, params: unknown) => {
          capturedId = id
          capturedParams = params
          return Promise.resolve(product({ name: '新会費', description: null }))
        },
      },
    })

    const result = await call(
      appRouter.products.update,
      { id: 'prod_x', name: '新会費', description: null },
      { context },
    )

    expect(capturedId).toBe('prod_x')
    // active は未指定なので渡さない。description の null は透過する。
    expect(capturedParams).toStrictEqual({ name: '新会費', description: null })
    expect(result).toStrictEqual(productViewOf({ name: '新会費' }))
  })

  it('更新フィールドを1つも指定しなければ reject する', async () => {
    const context = testContext({
      products: { update: () => Promise.resolve(product({})) },
    })

    await expect(
      call(appRouter.products.update, { id: 'prod_x' }, { context }),
    ).rejects.toThrow()
  })

  it('mutationsEnabled が false なら更新を拒否する(認可導入までの暫定ガード)', async () => {
    const context = testContext({ products: { update: () => Promise.resolve(product({})) } }, false)

    await expect(
      call(appRouter.products.update, { id: 'prod_x', active: false }, { context }),
    ).rejects.toThrow()
  })
})
