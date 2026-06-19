import { os } from '@orpc/server'
import type { Database } from '@checkin/db'

/**
 * Request context shared by every procedure. The Nitro handler builds this
 * per request (e.g. injecting the database handle and the authenticated user
 * once auth is specced out).
 */
export interface Context {
  db: Database
}

/** Base procedure builder — start all procedures from here. */
export const pub = os.$context<Context>()
