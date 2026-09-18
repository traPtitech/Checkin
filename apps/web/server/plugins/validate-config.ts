/**
 * 起動時に必須シークレットの存在を検証する。決済を扱うサービスとして、設定漏れは最初の
 * Stripe 利用時ではなくデプロイ時に検知されるべきなので、リクエスト処理の前段(サーバー起動時)で
 * 落とす。SDK の遅延生成(@checkin/api の StripeClient)はそのまま — 存在チェックだけを起動時へ
 * 前倒しする。
 *
 * 検証は本番のみ。ローカル開発では Stripe 鍵なしでも起動できるようにし(Stripe を使うプロシージャは
 * StripeClient が SDK を生成する時点で明示エラーにする)、鍵を持たない作業を妨げない。
 */
export default defineNitroPlugin(() => {
  if (import.meta.dev) return
  const { stripeSecretKey } = useRuntimeConfig()
  if (stripeSecretKey === '') {
    // StripeClient が SDK の生成時に投げるものと区別できるよう、起動時の検証であることを文言に入れる。
    throw new Error('起動時の設定検証: STRIPE_SECRET_KEY (NUXT_STRIPE_SECRET_KEY) が設定されていません')
  }
})
