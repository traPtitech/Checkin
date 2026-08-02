import Stripe from 'stripe'

let cached: Stripe | undefined

/** サーバーインスタンスごとに Stripe クライアントを1つだけ遅延生成し、再利用する。 */
export function useStripe(): Stripe {
  cached ??= new Stripe(useRuntimeConfig().stripeSecretKey)
  return cached
}
