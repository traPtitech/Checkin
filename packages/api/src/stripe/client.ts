import Stripe from 'stripe'

/**
 * Stripe SDK initialization, isolated to the adapter layer.
 *
 * The client is created **lazily**: a request that never touches billing must
 * not fail just because `STRIPE_SECRET_KEY` is absent (e.g. local auth-only
 * dev). We only throw when something actually tries to use Stripe without a key.
 * (stripe-customer spec: §Stripe 呼び出しはアダプタ境界に閉じ込める)
 */
export class StripeClient {
  private client: Stripe | undefined

  constructor(private readonly secretKey: string) {}

  /** The underlying SDK handle, created on first use. */
  get sdk(): Stripe {
    if (!this.client) {
      if (!this.secretKey) {
        throw new Error('STRIPE_SECRET_KEY is not set; refusing to call Stripe')
      }
      this.client = new Stripe(this.secretKey)
    }
    return this.client
  }
}

/**
 * Build a lazy Stripe adapter. Constructing it is cheap and key-free, so the
 * Nitro host can attach one to every request Context; the SDK is only
 * instantiated when a billing procedure actually reaches out to Stripe.
 */
export function createStripeClient(secretKey: string): StripeClient {
  return new StripeClient(secretKey)
}
