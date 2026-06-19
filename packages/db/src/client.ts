import { drizzle } from 'drizzle-orm/mysql2'
import * as schema from './schema'

export type Database = ReturnType<typeof createDatabase>

/**
 * Create a Drizzle database handle backed by mysql2 (MariaDB).
 *
 * Uses the default (non-planetscale) mode which is what MariaDB/MySQL want.
 */
export function createDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set')
  }

  return drizzle(connectionString, { schema, mode: 'default' })
}
