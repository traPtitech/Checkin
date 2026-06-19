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
  const e = err as { code?: string, errno?: number }
  return e.code === 'ER_DUP_ENTRY' || e.errno === 1062
}
