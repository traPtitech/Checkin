import type Stripe from 'stripe'
import type { Database } from '@checkin/db'
import { claimConnectedAccountId, getUserById } from '../auth/identity'
import type { StripeClient } from './client'

/** Inputs to resolve (and possibly create) the Connect connected account for a payee. */
export interface ResolveConnectedAccountInput {
  /** The person row id (`users.id`) whose `stripe_connected_account_id` we read/persist. */
  userId: string
  /**
   * The caller's snapshot of `users.stripe_connected_account_id` (or null). Kept
   * for callers' convenience/logging only — it is NOT trusted: we always re-read
   * the column fresh from the DB before deciding to create, to stay race-safe.
   */
  stripeConnectedAccountId: string | null
  /** Non-PII labels for log/dashboard readability; never used as lookup keys. A
   *  payout-only recipient has no mail_hash, so traq_id labels the account instead. */
  mailHash: string | null
  traqId?: string | null
}

/**
 * Get-or-create the Stripe Connect connected account for a payee and persist its id.
 *
 * Resolution order (connect-onboarding spec: §connected account の get-or-create):
 *   1. Re-read `users.stripe_connected_account_id` FRESH — present → reuse it.
 *   2. Else create an Express account (`metadata.mail_hash`) and CONDITIONALLY
 *      link it (`... WHERE id = ? AND stripe_connected_account_id IS NULL`).
 *
 * Race safety: two concurrent calls for the same payee may both pass step 1 and
 * each create a Stripe account. The conditional link in step 2 lets exactly one
 * win; the loser re-reads the winning id and best-effort deletes its orphaned
 * account so we never overwrite a stored id or leak an unused Stripe account.
 *
 * The connected account id is the sole reference key — `mail_hash` is metadata
 * only. No plaintext email is involved. (D2)
 */
export async function getOrCreateConnectedAccount(
  stripe: StripeClient,
  db: Database,
  input: ResolveConnectedAccountInput,
): Promise<string> {
  // 1. Reuse the linked connected account if one is already persisted. Re-read
  //    fresh (don't trust the caller's snapshot) so a concurrent link is seen.
  const existing = await readConnectedAccountId(db, input.userId)
  if (existing) {
    return existing
  }

  // 2. Create an Express account (Stripe-managed hosted onboarding). Label it with
  //    whichever non-PII key we have (a payout-only recipient has only traq_id).
  const metadata: Record<string, string> = {}
  if (input.mailHash) {
    metadata.mail_hash = input.mailHash
  }
  if (input.traqId) {
    metadata.traq_id = input.traqId
  }
  const created = await stripe.sdk.accounts.create({
    type: 'express',
    metadata,
  })

  // Conditional compare-and-set: only link if the column is still NULL. The
  // `unique` constraint on the column backs this up — should the IS NULL guard
  // ever be lost to a race we treat the duplicate-key error as "lost the claim".
  let won: boolean
  try {
    won = await claimConnectedAccountId(db, input.userId, created.id)
  }
  catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err
    }
    won = false
  }
  if (won) {
    return created.id
  }

  // We lost the race: another request linked an account first. Re-read the
  // winning id, then best-effort delete our just-created orphan (deletion is
  // allowed for unused platform-created Express accounts) and reuse the winner.
  const winning = await readConnectedAccountId(db, input.userId)
  await deleteOrphanAccount(stripe, created.id)
  if (!winning) {
    // Shouldn't happen (the claim lost ⇒ a row was linked), but never invent an
    // id: surface it rather than returning the orphan we just deleted.
    throw new Error('connected account claim lost but no linked account found')
  }
  return winning
}

/** Re-read the persisted connected-account id for a person, or null. */
async function readConnectedAccountId(db: Database, userId: string): Promise<string | null> {
  const row = await getUserById(db, userId)
  return row?.stripeConnectedAccountId ?? null
}

/**
 * Best-effort delete of a connected account we created but failed to link (lost
 * the race). Swallows errors: a leftover unused account is harmless and must not
 * fail the caller's onboarding.
 */
async function deleteOrphanAccount(stripe: StripeClient, accountId: string): Promise<void> {
  try {
    await stripe.sdk.accounts.del(accountId)
  }
  catch {
    // Deletion is a cleanup nicety, not a correctness requirement — ignore.
  }
}

/** Whether an error is a MySQL/MariaDB duplicate-key (unique violation). */
export function isDuplicateKeyError(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  const errno = (err as { errno?: number })?.errno
  return code === 'ER_DUP_ENTRY' || errno === 1062
}

/** Inputs for issuing a hosted Account Link for connected-account onboarding. */
export interface CreateAccountOnboardingLinkInput {
  /** Target connected account id (resolved via get-or-create). */
  accountId: string
  /** URL Stripe sends the payee to if the link expires / needs refreshing. */
  refreshUrl: string
  /** URL Stripe returns the payee to after the hosted onboarding flow. */
  returnUrl: string
}

/**
 * Create a Stripe **hosted** onboarding link (Account Link) for a connected
 * account. The returned URL is the Stripe-managed onboarding page; refresh /
 * return URLs are our own (`APP_ORIGIN` 配下).
 * (connect-onboarding spec: §ホスト型 onboarding リンクの発行)
 */
export async function createAccountOnboardingLink(
  stripe: StripeClient,
  input: CreateAccountOnboardingLinkInput,
): Promise<string> {
  const link = await stripe.sdk.accountLinks.create({
    account: input.accountId,
    type: 'account_onboarding',
    refresh_url: input.refreshUrl,
    return_url: input.returnUrl,
  })
  return link.url
}

/**
 * A verified `account.updated` event reduced to what the webhook handler needs.
 * The account object is narrowed to the payouts-relevant flags so the `payouts`
 * domain never depends on the Stripe SDK (it receives this structural shape).
 */
export interface VerifiedAccountEvent {
  id: string
  type: string
  /** The connected account id this event is about (`event.account` ?? object id). */
  accountId: string | null
  /** The connected account object carried by the event. */
  account: {
    payouts_enabled: boolean
    requirements?: { currently_due?: string[] | null } | null
  }
}

/**
 * Verify a Connect webhook signature over the raw body and return the decoded
 * `account.updated` event, narrowed to the payouts-relevant shape. Throws when
 * the signature is missing/invalid — callers map that to a 4xx. The raw
 * (unparsed) body is required for the HMAC to match.
 *
 * Kept here (not in webhook.ts) so the full Stripe `Account` type stays inside
 * the adapter boundary while the handler/`payouts` domain see only structural data.
 */
export function constructAccountEvent(
  stripe: StripeClient,
  rawBody: string | Buffer,
  signature: string | undefined,
  webhookSecret: string,
): VerifiedAccountEvent {
  if (!signature) {
    throw new Error('missing Stripe-Signature header')
  }
  if (!webhookSecret) {
    throw new Error('STRIPE_CONNECT_WEBHOOK_SECRET is not set; refusing to verify webhook')
  }
  const event: Stripe.Event = stripe.sdk.webhooks.constructEvent(rawBody, signature, webhookSecret)
  const object = event.data.object as Stripe.Account
  return {
    id: event.id,
    type: event.type,
    // `event.account` is the connected account for Connect events; fall back to
    // the object id for direct-account deliveries.
    accountId: event.account ?? object.id ?? null,
    account: {
      payouts_enabled: object.payouts_enabled ?? false,
      requirements: object.requirements
        ? { currently_due: object.requirements.currently_due }
        : null,
    },
  }
}
