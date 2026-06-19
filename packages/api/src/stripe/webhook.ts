import type Stripe from 'stripe'
import type { StripeClient } from './client'

/** A verified Stripe event reduced to what the webhook handler needs. */
export interface VerifiedEvent {
  id: string
  type: string
}

/**
 * Verify a Stripe webhook signature over the raw request body and return the
 * decoded event. Throws when the signature is missing/invalid — callers map that
 * to a 4xx. The raw (unparsed) body is required for the HMAC to match.
 * (payment-webhook spec: §Stripe 署名の検証)
 */
export function constructEvent(
  stripe: StripeClient,
  rawBody: string | Buffer,
  signature: string | undefined,
  webhookSecret: string,
): VerifiedEvent {
  if (!signature) {
    throw new Error('missing Stripe-Signature header')
  }
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set; refusing to verify webhook')
  }
  const event: Stripe.Event = stripe.sdk.webhooks.constructEvent(rawBody, signature, webhookSecret)
  return { id: event.id, type: event.type }
}
