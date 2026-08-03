import Stripe from 'stripe'

let cached: Stripe | undefined

/** サーバーインスタンスごとに Stripe クライアントを1つだけ遅延生成し、再利用する。 */
export function useStripe(): Stripe {
  if (cached === undefined) {
    const secretKey = useRuntimeConfig().stripeSecretKey
    // 未設定なら生成時に明示エラーにする(Stripe 呼び出し時の不透明な失敗を避ける)。
    if (secretKey === '') {
      throw new Error('STRIPE_SECRET_KEY (NUXT_STRIPE_SECRET_KEY) が設定されていません')
    }
    // apiVersion を SDK が生成された版に明示ピンする。省略するとアカウントの既定
    // API バージョンに従い、SDK の型と実行時のレスポンス形状がズレ得るため。
    // SDK を更新すると LatestApiVersion 型が変わり、この文字列が型エラーになって気づける。
    cached = new Stripe(secretKey, { apiVersion: '2026-07-29.dahlia' })
  }
  return cached
}
