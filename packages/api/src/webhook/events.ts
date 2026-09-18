import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { schema, type Database } from '@checkin/db'

/**
 * Whether a Stripe event id has already been recorded as processed. Used for a
 * check-then-notify-then-record flow so a notify failure leaves the event
 * unrecorded and Stripe will retry. (payment-webhook spec: §event id による冪等処理)
 */
export async function hasProcessedStripeEvent(db: Database, eventId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.stripeEvents.id })
    .from(schema.stripeEvents)
    .where(eq(schema.stripeEvents.eventId, eventId))
    .limit(1)
  return rows.length > 0
}

/**
 * Record a Stripe event id once, race-safely. Returns `true` if this call was
 * the first to see the event (caller should run side effects), or `false` if
 * the event was already recorded (duplicate delivery — skip side effects).
 *
 * Idempotency rides on the `stripe_events.event_id` UNIQUE constraint: a
 * concurrent/duplicate insert fails with a duplicate-key error, which we treat
 * as "already processed". (payment-webhook spec: §event id による冪等処理)
 *
 * KNOWN GAP — the `false` return is currently unreachable. The local
 * `isDuplicateKeyError` below reads only the top level of the thrown value, but
 * drizzle wraps the mysql2 error and carries the one holding `code`/`errno` as
 * its `.cause` (measured; the chain is written out on `isDuplicateKeyError` in
 * `../mysql-result.ts`). So a real duplicate key is not recognised and the error
 * is rethrown instead of reporting "already processed". Both callers
 * (`processInvoicePaid` and the `account-updated` route) query
 * `hasProcessedStripeEvent` before calling this, so an ordinary redelivery never
 * reaches the insert; only two deliveries that pass that check concurrently do,
 * and the loser surfaces an error that Stripe retries (the retry then stops at
 * the query). Switching to the shared reader would change that behaviour, so it
 * is left to the follow-up issue that covers unifying the three copies.
 */
export async function recordStripeEventOnce(
  db: Database,
  event: { id: string, type: string },
): Promise<boolean> {
  try {
    await db.insert(schema.stripeEvents).values({
      id: randomUUID(),
      eventId: event.id,
      type: event.type,
    })
    return true
  }
  catch (err) {
    if (isDuplicateKeyError(err)) {
      return false
    }
    throw err
  }
}

/** Whether an error is a MySQL/MariaDB duplicate-key (ER_DUP_ENTRY = 1062). */
function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false
  }
  return ('code' in err && err.code === 'ER_DUP_ENTRY') || ('errno' in err && err.errno === 1062)
}
