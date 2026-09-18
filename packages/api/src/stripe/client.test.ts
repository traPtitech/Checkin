import { describe, expect, it, vi } from 'vitest'
import { createStripeClient } from './client'

describe('StripeClient', () => {
  it('鍵が未設定のまま sdk を読むとエラーを投げる', () => {
    const client = createStripeClient('')
    expect(() => client.sdk).toThrow('STRIPE_SECRET_KEY is not set; refusing to call Stripe')
  })

  it('sdk を 2 回読むと 2 回目も 1 回目と同じインスタンスが返る', () => {
    const client = createStripeClient('sk_test_dummy')
    const first = client.sdk
    expect(client.sdk).toBe(first)
  })

  it('生成した SDK は固定した API バージョンを報告する', () => {
    const client = createStripeClient('sk_test_dummy')
    // getApiField は stripe 22.4.0 の型定義(cjs/stripe.core.d.ts)にあるが README には無い。
    // 公式ドキュメントに書かれていない挙動に依拠していることをここに残す。
    expect(client.sdk.getApiField('version')).toBe('2026-07-29.dahlia')
  })

  /**
   * 固定を丸ごと外す変異(`{ apiVersion: ... }` を消す)は、生成した SDK を読むだけでは検出
   * できない。stripe-node は指定が無いときその版の既定(同じ文字列)を入れるためである
   * (22.4.0 の `cjs/stripe.core.js` の `version: props.apiVersion || DEFAULT_API_VERSION`、
   * および README の `apiVersion` の行「未設定ならリリース時点の最新を使う」)。
   * そこで、指定がコンストラクターへ渡っていること自体を、コンストラクターを差し替えて見る。
   */
  it('SDK のコンストラクターに API バージョンの指定を渡している', async () => {
    const calls: [string, unknown][] = []
    vi.resetModules()
    vi.doMock('stripe', () => ({
      default: class {
        constructor(secretKey: string, config: unknown) {
          calls.push([secretKey, config])
        }
      },
    }))
    try {
      const { createStripeClient: create } = await import('./client')
      const sdk = create('sk_test_dummy').sdk
      expect(sdk).toBeDefined()
      expect(calls).toEqual([['sk_test_dummy', { apiVersion: '2026-07-29.dahlia' }]])
    }
    finally {
      vi.doUnmock('stripe')
      vi.resetModules()
    }
  })
})
