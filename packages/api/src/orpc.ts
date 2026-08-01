import { implement } from '@orpc/server'
import type { Database } from '@checkin/db'
import { contract } from '@checkin/api-contract'

/**
 * Request context shared by every procedure. The Nitro handler builds this
 * per request (e.g. injecting the database handle and the authenticated user
 * once auth is specced out).
 */
export interface Context {
  db: Database
}

/** Base implementer — start all procedures from here. Enforces `contract`. */
export const pub = implement(contract).$context<Context>()
