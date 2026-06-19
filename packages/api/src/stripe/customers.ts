import { eq } from 'drizzle-orm'
import { schema, type Database } from '@checkin/db'
import { normalizeEmail } from '../auth/crypto'
import type { StripeClient } from './client'

/** Inputs to resolve (and possibly create) the Stripe Customer for a person. */
export interface ResolveCustomerInput {
  /** The person row id (`users.id`) whose `stripe_customer_id` we read/persist. */
  userId: string
  /** Existing `users.stripe_customer_id`, or null if not yet linked. */
  stripeCustomerId: string | null
  /** Plaintext email — used only transiently to search/create the Customer. */
  email: string
  /** Display name for the Customer (for human-readable Stripe dashboards). */
  name?: string
  /** Non-PII labels for log readability; never used as a lookup key. */
  mailHash: string
  /** Optional traQ ID for metadata only (untrusted; not a reference key). */
  traqId?: string
}

/**
 * Get-or-create the Stripe Customer for a person and persist its id.
 *
 * Resolution order (stripe-customer spec: §Customer の get-or-create):
 *   1. `users.stripe_customer_id` present → reuse it (no Stripe round-trip).
 *   2. Else search Stripe by the submitted email; adopt a match and save it.
 *   3. Else create a Customer (email + name + metadata) and save it.
 *
 * The email plaintext is only used for (2)/(3); it is never persisted. The
 * customer id is the sole reference key — the traQ ID is metadata only.
 */
export async function getOrCreateCustomer(
  stripe: StripeClient,
  db: Database,
  input: ResolveCustomerInput,
): Promise<string> {
  // 1. Reuse the linked Customer if we already have one.
  if (input.stripeCustomerId) {
    return input.stripeCustomerId
  }

  const metadata: Record<string, string> = { mail_hash: input.mailHash }
  if (input.traqId) {
    metadata.traq_id = input.traqId
  }

  // Normalize (trim + lowercase) so case/whitespace variants don't create
  // duplicate Customers. mail_hash already normalizes internally, so the
  // router's mail_hash match is unaffected.
  const email = normalizeEmail(input.email)

  // 2. Look for an existing Customer by email before creating a new one. We use
  // list({email}) rather than search() so no Search API enablement is required.
  const existing = await stripe.sdk.customers.list({ email, limit: 1 })
  const found = existing.data[0]
  if (found) {
    await persistCustomerId(db, input.userId, found.id)
    return found.id
  }

  // 3. Nothing on either side: create the Customer and persist its id.
  const created = await stripe.sdk.customers.create({
    email,
    name: input.name,
    metadata,
  })
  await persistCustomerId(db, input.userId, created.id)
  return created.id
}

/** Persist the resolved Customer id on the person row (`users.stripe_customer_id`). */
async function persistCustomerId(db: Database, userId: string, customerId: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ stripeCustomerId: customerId })
    .where(eq(schema.users.id, userId))
}
